import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createJiti } from 'jiti';
import { SessionManager } from '@earendil-works/pi-coding-agent';
const jiti = createJiti(import.meta.url);
const { compileUiRichPlan } = await jiti.import('./rich-plan.ts');
const { UiGenerationPrototype } = await jiti.import('./generation-journal.ts');
const { runUiAction, recoverUiAction } = await jiti.import('./action-runtime.ts');
const plan = () => ({ planVersion: 2, id: 'bill', title: 'Budget', inputs: [{ id: 'people', label: 'People', valueType: 'number', value: 4, min: 1, max: 20 }],
  derived: [], views: [{ id: 'count', kind: 'metric', label: 'Count', value: { input: 'people' } }],
  layout: [{ id: 'parameters', type: 'group', title: 'Values', columns: 1, nodeIds: ['people', 'count'] }],
  actions: { version: 1, actions: [{ id: 'save', label: 'Save results', kind: 'save_snapshot', path: 'report.json', format: 'json' },
    { id: 'read', label: 'Read parameters', kind: 'read_json_parameters', path: 'parameters.json' }] } });
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'piora-action-runtime-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()))); rmSync(root, { recursive: true, force: true }); });
  const manager = SessionManager.create(root, join(root, 'sessions'));
  manager.appendMessage({ role: 'user', content: 'Create a budget and let me save it.', timestamp: 1 });
  const host = new UiGenerationPrototype({ manager, root }); await host.startRun();
  const context = await host.captureContext('bill'), value = plan();
  const messageEntryId = manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'piora_render_ui_plan', arguments: value }], timestamp: 2 });
  const candidate = await host.createCandidate(context.contextId, 'call', compileUiRichPlan(value, { revision: 1 }));
  const receipt = await host.persistCandidate(candidate.operationId);
  await host.observePersistedCandidate(candidate.operationId, { messageEntryId, toolResultEntryIds: [receipt.entryId] });
  await host.commitCandidate(candidate.operationId); await host.finishRun('idle');
  const source = await host.readActionSource('call');
  const controller = new AbortController();
  const assertActive = () => { if (controller.signal.aborted) throw new Error('cancelled'); };
  const run = { identity: { sessionId: manager.getSessionId(), runId: 'user-run', source: 'ui' }, signal: controller.signal, assertActive,
    authorize: async ({ evidence }) => { await evidence(controller.signal); return assertActive; } };
  const input = { requestId: 'click', toolCallId: 'call', sourceDigest: source.digest, actionId: 'save' };
  const options = { host, cwd: root, input, run, enabled: () => true, prepared: () => {}, ask: async () => 'once' };
  return { root, manager, host, controller, run, input, options, candidate, source };
}

test('save derives bytes from committed parameters and a repeated request never writes again', async t => {
  const f = await fixture(t);
  const result = await runUiAction(f.options); assert.equal(result.status, 'completed');
  const saved = JSON.parse(readFileSync(join(f.root, 'report.json'), 'utf8')); assert.deepEqual(saved.parameters, { people: 4 });
  let authorizations = 0;
  f.run.authorize = async () => { authorizations++; throw new Error('must not repeat'); };
  writeFileSync(join(f.root, 'report.json'), 'subsequent user edit');
  assert.deepEqual(await runUiAction(f.options), result);
  assert.equal(authorizations, 0); assert.equal(readFileSync(join(f.root, 'report.json'), 'utf8'), 'subsequent user edit');
  await assert.rejects(runUiAction({ ...f.options, input: { ...f.input, actionId: 'read' } }), /another intent/);
});

test('query needs explicit application; one atomic receipt prevents reapplying after later edits', async t => {
  const f = await fixture(t); writeFileSync(join(f.root, 'parameters.json'), '{"people":9}');
  const result = await runUiAction({ ...f.options, input: { ...f.input, actionId: 'read' } });
  assert.equal(result.status, 'completed'); assert.deepEqual(result.result.state, { people: 9 });
  assert.deepEqual((await f.host.readActive('bill')).state, { people: 4 });
  const applied = await f.host.applyActionParameters('click', () => {}); assert.equal(applied.alreadyApplied, false);
  assert.deepEqual((await f.host.readActive('bill')).state, { people: 9 });
  await f.host.saveParameters(f.candidate.operationId, applied.revision, { people: 12 });
  assert.deepEqual(await f.host.applyActionParameters('click', () => {}), { ...applied, alreadyApplied: true });
  assert.deepEqual((await f.host.readActive('bill')).state, { people: 12 });
});

test('missing and invalid parameter files preserve state and keep actionable failure reasons', async t => {
  const f = await fixture(t), options = { ...f.options, input: { ...f.input, actionId: 'read' } };
  await assert.rejects(runUiAction(options), error => error.code === 'TARGET' && error.problem === 'file_missing');
  assert.equal((await f.host.readActions('call')).length, 0);
  for (const [index, text] of ['{', '{"people":99}', '{"other":8}', '{"people":4,"people":8}'].entries()) {
    writeFileSync(join(f.root, 'parameters.json'), text);
    const result = await runUiAction({ ...options, input: { ...options.input, requestId: `invalid-${index}` } });
    assert.equal(result.status, 'failed'); assert.equal(result.problem, 'parameters_invalid'); assert.equal(result.result, undefined);
    const reopened = new UiGenerationPrototype({ manager: f.manager, root: f.root });
    assert.equal((await reopened.readActions('call')).find(o => o.id === result.id).problem, 'parameters_invalid');
    assert.deepEqual((await reopened.readActive('bill')).state, { people: 4 });
  }
});

test('changed UI, changed target, cancellation and disabled Beta revoke a pending action', async t => {
  for (const reason of ['parameters', 'file', 'abort', 'beta']) await t.test(reason, async t => {
    const f = await fixture(t); let beta = true;
    f.options.enabled = () => beta;
    f.run.authorize = async ({ evidence }) => {
      await evidence(f.controller.signal);
      if (reason === 'parameters') await f.host.saveParameters(f.candidate.operationId, f.source.revision, { people: 8 });
      if (reason === 'file') writeFileSync(join(f.root, 'report.json'), 'user file');
      if (reason === 'abort') f.controller.abort();
      if (reason === 'beta') beta = false;
      return f.run.assertActive;
    };
    const result = await runUiAction(f.options); assert.notEqual(result.status, 'completed');
    if (reason === 'file') assert.equal(readFileSync(join(f.root, 'report.json'), 'utf8'), 'user file');
    else assert.equal(existsSync(join(f.root, 'report.json')), false);
  });
});

test('a completed parameter read can be adopted after the chat title is generated', async t => {
  const f = await fixture(t); writeFileSync(join(f.root, 'parameters.json'), '{"people":9}');
  await runUiAction({ ...f.options, input: { ...f.input, actionId: 'read' } });
  f.manager.appendSessionInfo('Generated title');
  await f.host.applyActionParameters('click', () => {});
  assert.deepEqual((await f.host.readActive('bill')).state, { people: 9 });
});

test('read result cannot overwrite newer parameter values or cross conversation branches', async t => {
  const f = await fixture(t); writeFileSync(join(f.root, 'parameters.json'), '{"people":9}');
  await runUiAction({ ...f.options, input: { ...f.input, actionId: 'read' } });
  await f.host.saveParameters(f.candidate.operationId, f.source.revision, { people: 7 });
  await assert.rejects(f.host.applyActionParameters('click', () => {}), /changed since/);
  assert.deepEqual((await f.host.readActive('bill')).state, { people: 7 });
  const leaf = f.manager.getLeafId();
  f.manager.branch(f.manager.getBranch()[0].id);
  assert.deepEqual(await f.host.readActions('call'), []);
  await assert.rejects(f.host.applyActionParameters('click', () => {}), /another conversation branch/);
  f.manager.branch(leaf); assert.equal((await f.host.readActions('call')).length, 1);
});

test('a crash after writing but before receipt is reconciled without replay or false success', async t => {
  const f = await fixture(t), original = f.host.withActionOperation.bind(f.host); let crash = true;
  f.host.withActionOperation = (id, work) => original(id, (operation, context) => work(operation, { ...context, save: () => {
    if (crash && operation.status === 'completed') { crash = false; throw new Error('simulated receipt failure'); }
    context.save();
  } }));
  const result = await runUiAction(f.options); assert.equal(result.status, 'uncertain'); assert.ok(existsSync(join(f.root, 'report.json')));
  assert.equal(result.problem, 'uncertain');
  const recovered = new UiGenerationPrototype({ manager: f.manager, root: f.root });
  const verified = await recoverUiAction(recovered, 'click', f.root, () => false, true);
  assert.equal(verified.status, 'uncertain'); assert.equal(verified.reconciliation, 'matching');
  assert.equal((await runUiAction({ ...f.options, host: recovered })).status, 'uncertain');
  writeFileSync(join(f.root, 'report.json'), 'edited');
  assert.equal((await recoverUiAction(recovered, 'click', f.root, () => false, true)).reconciliation, 'different');
});

test('incomplete old requests are cancelled and cannot acquire a fresh permission on replay', async t => {
  const f = await fixture(t); let prepared;
  f.options.prepared = operation => { prepared = operation; };
  f.run.authorize = async () => { throw new Error('denied'); };
  const result = await runUiAction(f.options); assert.equal(result.status, 'failed'); assert.equal(prepared.status, 'prepared');
  assert.equal(existsSync(join(f.root, 'report.json')), false);
  await f.host.withActionOperation('click', (operation, context) => { operation.status = 'waiting_approval'; context.save(); });
  const recovered = await recoverUiAction(f.host, 'click', f.root, () => false, false); assert.equal(recovered.status, 'cancelled');
  assert.equal(recovered.problem, 'cancelled');
  assert.equal((await runUiAction(f.options)).status, 'cancelled');
});
