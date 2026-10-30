import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createJiti } from 'jiti';
import { SessionManager } from '@earendil-works/pi-coding-agent';
const jiti = createJiti(import.meta.url, { alias: { '@': resolve(import.meta.dirname, '../..') } });
const { compileUiRichPlan } = await jiti.import('./rich-plan.ts');
const { UiGenerationPrototype } = await jiti.import('./generation-journal.ts');
const { AgentSessionWrapper } = await jiti.import('../rpc-manager.ts');
const { bindSessionAgentRuntimeProfile } = await jiti.import('../agent-profile-store.ts');
const { writeBetaFeatures } = await jiti.import('../beta-features.ts');
const { writeToolPermission } = await jiti.import('../tool-permission-store.ts');
const { cacheSessionPath, invalidateSessionPathCache } = await jiti.import('../session-reader.ts');
const { GET, POST } = await jiti.import('../../app/api/sessions/[id]/intelligent-ui/actions/route.ts');

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'piora-action-route-')), previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  writeBetaFeatures({ intelligentUi: true }, root);
  const manager = SessionManager.create(root, join(root, 'sessions'));
  manager.appendMessage({ role: 'user', content: 'Make a budget with a save button.', timestamp: 1 });
  const id = manager.getSessionId(), host = new UiGenerationPrototype({ manager, root }); await host.startRun();
  const plan = { planVersion: 2, id: 'budget', title: 'Budget', inputs: [{ id: 'people', label: 'People', valueType: 'number', value: 4, min: 1 }], derived: [],
    views: [{ id: 'count', kind: 'metric', label: 'Count', value: { input: 'people' } }], layout: [{ id: 'group', type: 'group', title: 'Values', columns: 1, nodeIds: ['people', 'count'] }],
    actions: { version: 1, actions: [{ id: 'save', label: 'Save', kind: 'save_snapshot', path: 'report.json', format: 'json' }] } };
  const source = await host.captureContext('budget');
  const messageEntryId = manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'piora_render_ui_plan', arguments: plan }], timestamp: 2 });
  const candidate = await host.createCandidate(source.contextId, 'call', compileUiRichPlan(plan, { revision: 1 }));
  const receipt = await host.persistCandidate(candidate.operationId);
  await host.observePersistedCandidate(candidate.operationId, { messageEntryId, toolResultEntryIds: [receipt.entryId] });
  await host.commitCandidate(candidate.operationId); await host.finishRun('idle');
  await bindSessionAgentRuntimeProfile(id, 'normal'); cacheSessionPath(id, manager.getSessionFile());
  let active = ['read', 'write', 'piora_render_ui_plan'];
  const inner = { sessionId: id, sessionFile: manager.getSessionFile(), sessionManager: manager, agent: { state: { systemPrompt: '', thinkingLevel: 'off' } },
    isStreaming: false, isCompacting: false, isBashRunning: false, autoCompactionEnabled: true, autoRetryEnabled: true,
    modelRuntime: { getModel: () => undefined, refresh: async () => {} },
    extensionRunner: { getRegisteredCommands: () => [] }, resourceLoader: { getSkills: () => ({ skills: [] }), getExtensions: () => ({ extensions: [], errors: [] }) },
    promptTemplates: [], subscribe: () => () => {}, prompt: async () => { throw new Error('Actions must not run a model turn'); }, reload: async () => {},
    abort: async () => {}, abortCompaction: () => {}, abortBash: () => {}, clearQueue: () => ({ steering: [], followUp: [] }),
    getActiveToolNames: () => [...active], setActiveToolsByName: names => { active = names; }, getAllTools: () => ['read', 'write', 'piora_render_ui_plan'].map(name => ({ name, description: name })),
    getContextUsage: () => undefined, pendingMessageCount: 0, getSteeringMessages: () => [], getFollowUpMessages: () => [], dispose: () => {},
  };
  const wrapper = new AgentSessionWrapper(inner); wrapper.start();
  (globalThis.__piSessions ??= new Map()).set(id, wrapper); writeToolPermission(id, 'ask', root);
  t.after(async () => {
    if (wrapper.isRunning()) await wrapper.send({ type: 'abort' });
    await wrapper.shutdownForFileMutation(); globalThis.__piSessions.delete(id); invalidateSessionPathCache(id);
    assert.equal(globalThis.__pioraUiActions?.size ?? 0, 0);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    assert.ok(resolve(root).startsWith(resolve(tmpdir()))); rmSync(root, { recursive: true, force: true });
  });
  const context = { params: Promise.resolve({ id }) };
  const request = (body, origin) => new Request(`http://localhost/api/sessions/${id}/intelligent-ui/actions?toolCallId=call`, { method: body ? 'POST' : 'GET',
    headers: { host: 'localhost', ...(body ? { 'content-type': 'application/json' } : {}), ...(origin ? { origin } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const get = async () => { const response = await GET(request(), context); assert.equal(response.status, 200); return response.json(); };
  const post = async body => POST(request(body), context);
  const start = { command: 'start', requestId: 'click', toolCallId: 'call', actionId: 'save', sourceDigest: (await host.readActionSource('call')).digest };
  return { root, manager, host, wrapper, request, context, get, post, start };
}
async function waitFor(read, predicate) {
  const until = Date.now() + 5000;
  while (Date.now() < until) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 15)); }
  throw new Error('Timed out waiting for action state');
}

test('an existing report is a specific rejection with no action admitted or file changed', async t => {
  const f = await fixture(t); writeFileSync(join(f.root, 'report.json'), 'existing user report');
  const response = await f.post(f.start); assert.equal(response.status, 400);
  const failure = await response.json(); assert.equal(failure.problem, 'file_exists'); assert.match(failure.error, /already exists/);
  assert.equal((await f.get()).operations.length, 0);
  assert.equal(readFileSync(join(f.root, 'report.json'), 'utf8'), 'existing user report');
  await waitFor(async () => f.wrapper.isRunning(), value => !value);
});

test('unexpected status failures are server errors, not definitive client rejections', async t => {
  const f = await fixture(t), original = UiGenerationPrototype.prototype.readActionSource;
  try {
    UiGenerationPrototype.prototype.readActionSource = async () => { throw new Error('temporary storage failure'); };
    const response = await GET(f.request(), f.context); assert.equal(response.status, 500);
    assert.equal((await response.json()).problem, 'request_unknown');
  } finally { UiGenerationPrototype.prototype.readActionSource = original; }
  assert.equal((await f.get()).operations.length, 0);
});

test('route publishes a durable click, requires one-use approval, and answers retries from the journal', async t => {
  const f = await fixture(t);
  const started = await f.post(f.start); assert.equal(started.status, 202, await started.clone().text());
  const pending = (await waitFor(f.get, value => value.operations[0]?.approval)).operations[0];
  assert.equal(existsSync(join(f.root, 'report.json')), false);
  const wrong = await f.post({ command: 'approve', operationId: 'click', approvalId: 'wrong' });
  assert.equal(wrong.status, 409, await wrong.text());
  const approval = { command: 'approve', operationId: 'click', approvalId: pending.approval.id };
  assert.equal((await f.post(approval)).status, 200);
  await waitFor(f.get, value => value.operations[0]?.status === 'completed');
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'report.json'), 'utf8')).parameters, { people: 4 });
  assert.equal((await f.post(approval)).status, 409);
  assert.equal((await (await f.post(f.start)).json()).status, 'completed');
  assert.equal((await f.get()).operations.length, 1);
  await waitFor(async () => f.wrapper.isRunning(), value => !value);
});

test('route rejects cross-origin and arbitrary targets, and cancellation leaves no report', async t => {
  const f = await fixture(t);
  assert.equal((await POST(f.request(f.start, 'https://untrusted.test'), f.context)).status, 403);
  assert.equal((await f.post({ ...f.start, path: '../outside.json' })).status, 400);
  assert.equal((await f.post(f.start)).status, 202);
  await waitFor(f.get, value => value.operations[0]?.approval);
  assert.equal((await f.post({ command: 'cancel', operationId: 'click' })).status, 200);
  await waitFor(async () => f.wrapper.isRunning(), value => !value);
  assert.equal(existsSync(join(f.root, 'report.json')), false);
  assert.equal((await f.get()).operations[0].status, 'cancelled');
});

test('a pending approval remains usable after automatic chat naming', async t => {
  const f = await fixture(t); assert.equal((await f.post(f.start)).status, 202);
  const pending = (await waitFor(f.get, value => value.operations[0]?.approval)).operations[0];
  f.manager.appendSessionInfo('Generated after the action started');
  assert.equal((await f.post({command:'approve',operationId:'click',approvalId:pending.approval.id})).status,200);
  await waitFor(f.get,value=>value.operations[0]?.status==='completed');
  assert.deepEqual(JSON.parse(readFileSync(join(f.root,'report.json'),'utf8')).parameters,{people:4});
  await waitFor(async()=>f.wrapper.isRunning(),value=>!value);
});

test('concurrent replies consume a pending approval only once', async t => {
  const f=await fixture(t);assert.equal((await f.post(f.start)).status,202);
  const pending=(await waitFor(f.get,value=>value.operations[0]?.approval)).operations[0];
  const approval={command:'approve',operationId:'click',approvalId:pending.approval.id};
  const responses=await Promise.all([f.post(approval),f.post(approval)]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
  await waitFor(f.get,value=>value.operations[0]?.status==='completed');
  assert.deepEqual(JSON.parse(readFileSync(join(f.root,'report.json'),'utf8')).parameters,{people:4});
  assert.equal((await f.get()).operations.length,1);
  await waitFor(async()=>f.wrapper.isRunning(),value=>!value);
});

test('changed parameters still allow denial, while stale approval cancels its run without writing', async t => {
  for(const command of ['deny','approve']) await t.test(command,async t=>{
    const f=await fixture(t); assert.equal((await f.post(f.start)).status,202);
    const pending=(await waitFor(f.get,value=>value.operations[0]?.approval)).operations[0];
    await f.host.saveParameters(pending.source.operationId,pending.source.revision,{people:8});
    const response=await f.post({command,operationId:'click',approvalId:pending.approval.id});
    assert.equal(response.status,command==='deny'?200:409);
    await waitFor(async()=>f.wrapper.isRunning(),value=>!value);
    const operation=(await f.get()).operations[0];
    assert.ok(['cancelled','failed'].includes(operation.status));assert.equal(operation.approval,undefined);
    assert.equal(existsSync(join(f.root,'report.json')),false);
    assert.equal((await f.host.readActionSource('call')).state.people,8);
    assert.equal((await f.post({command:'approve',operationId:'click',approvalId:pending.approval.id})).status,409);
  });
});
