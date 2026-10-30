import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createJiti } from 'jiti';
import { SessionManager } from '@earendil-works/pi-coding-agent';
const jiti = createJiti(import.meta.url, { alias: { '@': resolve(import.meta.dirname, '../..') } });
const { UiGenerationPrototype } = await jiti.import('./generation-journal.ts');
const { compileUiPlan } = await jiti.import('./plan.ts');
const { writeBetaFeatures } = await jiti.import('../beta-features.ts');
const { cacheSessionPath, invalidateSessionPathCache } = await jiti.import('../session-reader.ts');
const { beginPromptRun, finishPromptRun, getActivePromptRun } = await jiti.import('../prompt-run-registry.ts');
const { withUiFileLock, uiSessionLockPath } = await jiti.import('./session-lock.ts');
const { GET, POST } = await jiti.import('../../app/api/sessions/[id]/intelligent-ui/migration/route.ts');

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'piora-migration-route-')), previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  writeBetaFeatures({ intelligentUi: true }, root);
  const manager = SessionManager.create(root, join(root, 'sessions'));
  manager.appendMessage({ role: 'user', content: 'Compare costs', timestamp: 1 });
  const id = manager.getSessionId(), file = manager.getSessionFile(), host = new UiGenerationPrototype({ manager, root, runId: 'origin' });
  cacheSessionPath(id, file);
  t.after(async () => {
    await finishPromptRun(getActivePromptRun(id), 'abort'); invalidateSessionPathCache(id);
    assert.equal(globalThis.__pioraSessionFileOperations?.has(id) ?? false, false);
    assert.equal(globalThis.__pioraSessionFileOwners?.has(id) ?? false, false);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    assert.ok(resolve(root).startsWith(resolve(tmpdir()))); rmSync(root, { recursive: true, force: true });
  });
  await host.startRun();
  for (const revision of [1, 2]) {
    const plan = { planVersion: 1, id: 'bill', title: 'Bill', inputs: [{ id: 'price', valueType: 'number', label: 'Cost', unit: revision === 1 ? 'yuan' : 'cents', value: revision === 1 ? 20 : 2000, min: 0 }], derived: [], views: [{ id: 'cost', kind: 'metric', label: 'Cost', value: { input: 'price' } }] };
    const context = await host.captureContext('bill'), toolCallId = `call-${revision}`;
    const messageEntryId = manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: toolCallId, name: 'piora_render_ui_plan', arguments: plan }], timestamp: revision });
    const candidate = await host.createCandidate(context.contextId, toolCallId, compileUiPlan(plan, { revision }));
    const result = await host.persistCandidate(candidate.operationId);
    await host.observePersistedCandidate(candidate.operationId, { messageEntryId, toolResultEntryIds: [result.entryId] });
    if (revision === 1) await host.commitCandidate(candidate.operationId);
    else await host.prepareMigration(candidate.operationId);
  }
  await host.finishRun('idle');
  const review = await host.readMigration('call-2');
  const input = { proposalId: review.proposalId, digest: review.digest, leafId: review.leafId, requestId: 'user-click', decision: 'confirm', state: { price: 3000 } };
  const request = (body, options = {}) => new Request(`http://localhost/api/sessions/${id}/intelligent-ui/migration?toolCallId=call-2`, {
    method: body === undefined ? 'GET' : 'POST', ...options,
    headers: { host: 'localhost', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { root, id, file, host, input, request, context: { params: Promise.resolve({ id }) } };
}

test('same-origin confirmation uses a fresh owned host run and replays one durable click', async t => {
  const f = await fixture(t);
  assert.equal((await (await GET(f.request(), f.context)).json()).review.status, 'ready');
  const response = await POST(f.request(f.input), f.context);
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const first = await response.json(); assert.equal(first.status, 'committed');
  assert.deepEqual(await (await POST(f.request(f.input), f.context)).json(), first);
  const manager = SessionManager.open(f.file), confirmations = manager.getEntries().filter(entry => entry.customType === 'piora-ui-confirmation');
  assert.equal(confirmations.length, 1); assert.notEqual(confirmations[0].data.runId, 'origin');
  assert.equal(getActivePromptRun(f.id), undefined);
  assert.deepEqual((await new UiGenerationPrototype({ root: f.root, manager }).readActive('bill')).state, { price: 3000 });
});

test('route rejects untrusted requests, disabled beta, malformed choices and busy runs without publishing', async t => {
  const f = await fixture(t);
  assert.equal((await POST(f.request(f.input, { headers: { origin: 'https://untrusted.test' } }), f.context)).status, 403);
  assert.equal((await POST(f.request({ ...f.input, force: true }), f.context)).status, 400);
  assert.equal((await POST(f.request({ ...f.input, state: {} }), f.context)).status, 400);
  writeBetaFeatures({ intelligentUi: false }, f.root);
  assert.equal((await POST(f.request(f.input), f.context)).status, 403);
  writeBetaFeatures({ intelligentUi: true }, f.root);
  const running = beginPromptRun(f.id);
  assert.equal((await POST(f.request(f.input), f.context)).status, 409);
  assert.equal(getActivePromptRun(f.id).runId, running.runId);
  await finishPromptRun(running, 'idle');
  assert.equal((await f.host.readActive('bill')).surface.revision, 1);
  const response = await POST(f.request({ ...f.input, decision: 'cancel', state: {} }), f.context);
  assert.deepEqual(await response.json(), { status: 'cancelled' });
});

test('aborting a click while the UI mutex is occupied revokes its write and releases ownership', async t => {
  const f = await fixture(t), controller = new AbortController();
  let release, locked;
  const entered = new Promise(resolve => { locked = resolve; });
  const lock = withUiFileLock(uiSessionLockPath(f.id, f.root), () => { locked(); return new Promise(resolve => { release = resolve; }); });
  await entered;
  const post = POST(f.request(f.input, { signal: controller.signal }), f.context);
  const deadline = Date.now() + 3000;
  while (!getActivePromptRun(f.id)) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
  controller.abort(); release(); await lock;
  assert.equal((await post).status, 409);
  assert.equal((await f.host.readActive('bill')).surface.revision, 1);
  assert.equal(SessionManager.open(f.file).getEntries().filter(entry => entry.customType === 'piora-ui-confirmation').length, 0);
  assert.equal((await f.host.readMigration('call-2')).status, 'ready');
});

test('simultaneous windows cannot publish conflicting choices twice', async t => {
  const f = await fixture(t);
  const results = await Promise.all([
    POST(f.request(f.input), f.context),
    POST(f.request({ ...f.input, requestId: 'other-click', state: { price: 4000 } }), f.context),
  ]);
  assert.deepEqual(results.map(response => response.status).sort(), [200, 409]);
  const manager = SessionManager.open(f.file);
  assert.equal(manager.getEntries().filter(entry => entry.customType === 'piora-ui-confirmation').length, 1);
  const saved = await new UiGenerationPrototype({ root: f.root, manager }).readActive('bill');
  assert.ok([3000, 4000].includes(saved.state.price));
});
