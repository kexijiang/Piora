import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const { SessionMessageRouter } = await jiti.import('./session-message-router.ts');
const { SessionControlStore } = await jiti.import('./session-control-store.ts');
const { SessionCommandEventHub } = await jiti.import('./session-command-events.ts');
const { resetSessionInboxesForTests } = await jiti.import('./session-inbox.ts');
const { AgentSessionWrapper } = await jiti.import('./rpc-manager.ts');

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function eventually(predicate) {
  const end = Date.now() + 4000;
  while (!await predicate()) { assert.ok(Date.now() < end, 'fixture did not settle'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
class ControlledSession {
  sessionId = `session-${randomUUID()}`;
  active = false; runId; starts = []; aborts = []; listeners = new Set(); destroyListeners = new Set();
  isAlive() { return true; }
  isRunning() { return this.active; }
  getActivePromptRunId() { return this.runId; }
  onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onDestroy(listener) { this.destroyListeners.add(listener); return () => this.destroyListeners.delete(listener); }
  emit(event) { for (const listener of this.listeners) listener(event); }
  async startTrackedPrompt(input) {
    this.active = true; this.runId = `run_${randomUUID()}`;
    this.starts.push(input); this.commandId = input.commandId;
    this.emit({ type: 'prompt_started', commandId: input.commandId, runId: this.runId });
    return { accepted: true, commandId: input.commandId, sessionId: this.sessionId, runId: this.runId };
  }
  finish() { const runId = this.runId; this.active = false; this.runId = undefined; this.emit({ type: 'prompt_done', commandId: this.commandId, runId }); }
  async send(command) {
    assert.equal(command.type, 'abort'); this.aborts.push(command); this.finish();
    return { accepted: true, queuedMessages: { id: 'owned-queue', steering: ['preserved steering'], followUp: ['preserved follow-up'] } };
  }
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'piora-prompt-cancel-'));
  resetSessionInboxesForTests();
  const store = new SessionControlStore({ root }), session = new ControlledSession();
  const priorRegistry = globalThis.__piSessions;
  globalThis.__piSessions = new Map([[session.sessionId, session]]);
  let resolverGate;
  const router = new SessionMessageRouter({ store, events: new SessionCommandEventHub(store), resolver: async () => {
    if (resolverGate) await resolverGate.promise;
    return { session, realSessionId: session.sessionId, cwd: root };
  } });
  t.after(async () => { session.finish(); await router.resumeSession(session.sessionId); resetSessionInboxesForTests(); globalThis.__piSessions = priorRegistry; await rm(root, { recursive: true, force: true }); });
  const input = (key = randomUUID(), content = 'actual original text', extra = {}) => ({ targetSessionId: session.sessionId, idempotencyKey: key, content, source: 'ui', ...extra });
  const cancel = (key, promptCommandId) => router.cancelPromptSubmission({ targetSessionId: session.sessionId, idempotencyKey: key, ...(promptCommandId ? { promptCommandId } : {}) });
  return { root, store, session, router, input, cancel, blockResolver() { resolverGate = deferred(); return resolverGate; } };
}

test('canonical cancellation while dispatching is awaiting persistence prevents admission', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  const appendStatus = f.store.appendStatus.bind(f.store);
  f.store.appendStatus = async (command, status, patch) => {
    if (status === 'dispatching') { entered.resolve(command.commandId); await release.promise; }
    return appendStatus(command, status, patch);
  };
  const receipt = await f.router.dispatchSessionMessage(f.input());
  const commandId = await entered.promise;
  await f.router.cancelCommand(commandId);
  release.resolve();
  let drained = false;
  const draining = f.router.resumeSession(f.session.sessionId).then(() => { drained = true; });
  await eventually(() => drained || f.session.starts.length > 0);
  if (f.session.starts.length) f.session.finish();
  await draining;
  assert.equal(f.session.starts.length, 0);
  assert.equal((await f.router.getCommand(receipt.commandId)).status, 'cancelled');
});

test('running cancellation uses the canonical record and never aborts a later run twice', async t => {
  const f = await fixture(t), key = randomUUID();
  const receipt = await f.router.dispatchSessionMessage(f.input(key));
  await eventually(async () => (await f.router.getCommand(receipt.commandId)).status === 'running');
  const cancelled = await f.router.cancelCommand(receipt.commandId);
  await f.router.resumeSession(f.session.sessionId);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await f.router.getCommand(receipt.commandId)).status, 'cancelled');
  f.session.active = true; f.session.runId = 'unrelated-new-run';
  await f.router.cancelCommand(receipt.commandId);
  assert.equal(f.session.aborts.length, 1);
  assert.equal(f.session.runId, 'unrelated-new-run');
});

test('cancellation before the POST stores no invented command and fences the later original submission', async t => {
  const f = await fixture(t), key = randomUUID();
  const pending = await f.cancel(key);
  assert.equal(pending.status, 'cancellation_pending');
  assert.equal(pending.commandId, undefined);
  assert.deepEqual(f.store.loadCommands(f.session.sessionId), []);
  const original = f.input(key, 'original multiline\nuser text', { images: [{ type: 'image', data: 'YWJj', mimeType: 'image/png' }] });
  const receipt = await f.router.dispatchSessionMessage(original);
  assert.equal(receipt.status, 'cancelled');
  await f.router.resumeSession(f.session.sessionId);
  assert.equal(f.session.starts.length, 0);
  const stored = f.store.loadCommands(f.session.sessionId);
  assert.equal(stored.length, 1); assert.equal(stored[0].content, original.content);
  assert.deepEqual(stored[0].images, original.images); assert.equal(stored[0].status, 'cancelled');
  const repeat = await f.router.dispatchSessionMessage(original);
  assert.equal(repeat.commandId, receipt.commandId); assert.equal(repeat.status, 'cancelled');
});

test('cancellation during resolver wait acknowledges its fence immediately and later journals the real original', async t => {
  const f = await fixture(t), key = randomUUID(), gate = f.blockResolver();
  const pending = f.router.dispatchSessionMessage(f.input(key));
  const stopped = await f.cancel(key);
  assert.equal(stopped.status, 'cancellation_pending'); assert.equal(stopped.commandId, undefined);
  assert.deepEqual(f.store.loadCommands(f.session.sessionId), []);
  gate.resolve(); const receipt = await pending;
  assert.equal(receipt.status, 'cancelled');
  assert.equal(f.store.loadCommands(f.session.sessionId)[0].content, 'actual original text');
  assert.equal(f.session.starts.length, 0);
  assert.match(await readFile(f.store.commandsPath(f.session.sessionId), 'utf8'), /actual original text/);
});

test('cancellation during original command append waits for its real durable text before terminal receipt', async t => {
  const f = await fixture(t), key = randomUUID(), entered = deferred(), release = deferred();
  const appendCommand = f.store.appendCommand.bind(f.store);
  f.store.appendCommand = async command => { entered.resolve(command.commandId); await release.promise; return appendCommand(command); };
  const sending = f.router.dispatchSessionMessage(f.input(key, 'durable original before cancellation'));
  const commandId = await entered.promise;
  let settled = false;
  const stopping = f.cancel(key, commandId).then(receipt => { settled = true; return receipt; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.deepEqual(f.store.loadCommands(f.session.sessionId), []);
  release.resolve();
  const [submitted, stopped] = await Promise.all([sending, stopping]);
  assert.equal(submitted.commandId, stopped.commandId); assert.equal(stopped.status, 'cancelled');
  const stored = f.store.loadCommands(f.session.sessionId);
  assert.equal(stored[0].content, 'durable original before cancellation'); assert.equal(stored[0].status, 'cancelled');
  assert.equal(f.session.starts.length, 0);
});

test('a durably saved submission rejected by inbox capacity stays failed instead of replaying on recovery', async t => {
  const f = await fixture(t); f.session.active = true;
  for (let index = 0; index < 100; index++) await f.router.dispatchSessionMessage(f.input(`queued-${index}`));
  const original = f.input('capacity-rejected', 'original retained despite full inbox');
  try {
    await assert.rejects(f.router.dispatchSessionMessage(original), error => error.code === 'SESSION_QUEUE_FULL');
    const stored = f.store.loadCommands(f.session.sessionId).find(command => command.idempotencyKey === original.idempotencyKey);
    assert.equal(stored.content, original.content); assert.equal(stored.status, 'failed');
    assert.equal(stored.errorCode, 'SESSION_QUEUE_FULL');
    const restored = new SessionMessageRouter({ store: f.store, events: new SessionCommandEventHub(f.store), resolver: async () => ({ session: f.session, realSessionId: f.session.sessionId, cwd: f.root }) });
    assert.equal((await restored.dispatchSessionMessage(original)).status, 'failed');
    assert.equal(f.session.starts.length, 0);
  } finally {
    for (const command of f.store.loadCommands(f.session.sessionId)) if (command.status === 'queued') await f.cancel(command.idempotencyKey, command.commandId);
  }
});

test('precise running prompt cancellation returns the actual queue handoff and leaves queued survivor intact', async t => {
  const f = await fixture(t), key = randomUUID();
  const target = await f.router.dispatchSessionMessage(f.input(key));
  await eventually(async () => (await f.router.getCommand(target.commandId)).status === 'running');
  const survivor = await f.router.dispatchSessionMessage(f.input(randomUUID(), 'survivor original'));
  const stopped = await f.cancel(key, target.commandId);
  assert.deepEqual(stopped.queuedMessages, { id: 'owned-queue', steering: ['preserved steering'], followUp: ['preserved follow-up'] });
  await eventually(() => f.session.starts.length === 2);
  f.session.finish(); await f.router.resumeSession(f.session.sessionId);
  assert.equal((await f.router.getCommand(survivor.commandId)).status, 'completed');
  assert.equal((await f.cancel(key, target.commandId)).status, 'cancelled');
  assert.equal(f.session.aborts.length, 1);
});

test('mismatched session, key or steer command never gains cancellation authority', async t => {
  const f = await fixture(t); f.session.active = true; f.session.runId = 'unrelated';
  const key = randomUUID(), receipt = await f.router.dispatchSessionMessage(f.input(key));
  for (const input of [{ targetSessionId: 'other-session', idempotencyKey: key }, { targetSessionId: f.session.sessionId, idempotencyKey: 'different-key' }]) {
    await assert.rejects(f.router.cancelPromptSubmission({ ...input, promptCommandId: receipt.commandId }), error => error.code === 'INVALID_SESSION_MESSAGE');
  }
  await assert.rejects(f.cancel(key, `cmd_${randomUUID()}`), error => error.code === 'COMMAND_NOT_FOUND');
  const steer = { ...f.input(randomUUID()), commandId: `cmd_${randomUUID()}`, delivery: 'steer', status: 'delivered', acceptedAt: Date.now() };
  await f.store.appendCommand(steer);
  await assert.rejects(f.cancel(steer.idempotencyKey, steer.commandId), error => error.code === 'INVALID_SESSION_MESSAGE');
  assert.equal(f.session.aborts.length, 0);
  await f.cancel(key, receipt.commandId);
});

test('an old command with a different actual run cannot abort that new run', async t => {
  const f = await fixture(t), key = randomUUID();
  const receipt = await f.router.dispatchSessionMessage(f.input(key));
  await eventually(async () => (await f.router.getCommand(receipt.commandId)).status === 'running');
  const oldRun = f.session.runId;
  f.session.runId = 'different-new-run';
  const stopped = await f.cancel(key, receipt.commandId);
  assert.equal(stopped.status, 'interrupted'); assert.equal(stopped.runId, oldRun);
  assert.equal(f.session.aborts.length, 0); assert.equal(f.session.runId, 'different-new-run');
  await f.router.resumeSession(f.session.sessionId);
  assert.equal(f.session.runId, 'different-new-run');
  assert.equal((await f.cancel(key, receipt.commandId)).status, 'interrupted');
  assert.equal(f.session.aborts.length, 0);
});

test('already completed submission stays completed and repeated cancellation never aborts another run', async t => {
  const f = await fixture(t), key = randomUUID();
  const receipt = await f.router.dispatchSessionMessage(f.input(key));
  await eventually(() => f.session.starts.length === 1);
  f.session.finish(); await f.router.resumeSession(f.session.sessionId);
  f.session.active = true; f.session.runId = 'later-run';
  for (let i = 0; i < 2; i++) assert.equal((await f.cancel(key, receipt.commandId)).status, 'completed');
  assert.equal(f.session.aborts.length, 0); assert.equal(f.session.runId, 'later-run');
});

test('a rejected SDK stop is handled immediately and repeated cancellation remains failed without another abort', async t => {
  const f = await fixture(t), key = randomUUID(), entered = deferred(), release = deferred();
  const target = await f.router.dispatchSessionMessage(f.input(key));
  await eventually(async () => (await f.router.getCommand(target.commandId)).status === 'running');
  const error = new Error('Synthetic SDK stop failed');
  f.session.send = async command => { f.session.aborts.push(command); throw error; };
  const appendStatus = f.store.appendStatus.bind(f.store);
  f.store.appendStatus = async (command, status, patch) => {
    if (status === 'cancelled') { entered.resolve(); await release.promise; }
    return appendStatus(command, status, patch);
  };
  const rejections = [], observe = value => rejections.push(value);
  process.on('unhandledRejection', observe); t.after(() => process.off('unhandledRejection', observe));
  const stopping = f.cancel(key, target.commandId).then(() => assert.fail('stop failure cannot become success'), value => value);
  await entered.promise; await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(rejections, []); release.resolve();
  assert.equal(await stopping, error);
  f.session.runId = 'new-run-after-stop-failure';
  await assert.rejects(f.cancel(key, target.commandId), value => value === error);
  assert.equal(f.session.aborts.length, 1); assert.equal(f.session.runId, 'new-run-after-stop-failure');
  assert.deepEqual(rejections, []);
});

test('a failed terminal journal write cannot become successful just because canonical status was mutated', async t => {
  const f = await fixture(t), key = randomUUID(); f.session.active = true;
  const target = await f.router.dispatchSessionMessage(f.input(key));
  const appendStatus = f.store.appendStatus.bind(f.store), error = new Error('Synthetic journal write failed');
  f.store.appendStatus = async (command, status, patch) => {
    if (status === 'cancelled') throw error;
    return appendStatus(command, status, patch);
  };
  await assert.rejects(f.cancel(key, target.commandId), value => value === error);
  f.store.appendStatus = appendStatus;
  await assert.rejects(f.cancel(key, target.commandId), value => value === error);
  assert.equal(f.store.loadCommands(f.session.sessionId)[0].status, 'queued');
  assert.equal(f.session.starts.length, 0); assert.equal(f.session.aborts.length, 0);
});

test('unknown cancellation intent is bounded without expiring or silently evicting accepted keys', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 256; i++) assert.equal((await f.cancel(`pending-${i}`)).status, 'cancellation_pending');
  await assert.rejects(f.cancel('overflow'), error => error.code === 'SESSION_QUEUE_FULL');
  assert.equal((await f.cancel('pending-0')).status, 'cancellation_pending');
  const receipt = await f.router.dispatchSessionMessage(f.input('pending-0'));
  assert.equal(receipt.status, 'cancelled');
  assert.equal((await f.cancel('overflow')).status, 'cancellation_pending');
  assert.equal(f.session.starts.length, 0);
});

test('real AgentSessionWrapper abortGeneration fences an own tracked prompt still awaiting extension binding', async t => {
  const root = await mkdtemp(join(tmpdir(), 'piora-wrapper-cancel-'));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR, oldRegistry = globalThis.__piSessions;
  process.env.PI_CODING_AGENT_DIR = root;
  const binding = deferred(), entered = deferred(), id = `wrapper-${randomUUID()}`;
  let modelPrompts = 0, sdkAborts = 0;
  const inner = {
    sessionId: id, sessionFile: undefined, isStreaming: false, isCompacting: false, isBashRunning: false,
    sessionManager: { getEntries: () => [], getSessionName: () => undefined, getCwd: () => root, getBranch: () => [] },
    agent: { state: { messages: [], tools: [], systemPrompt: '' } },
    getAllTools: () => [], getActiveToolNames: () => [], setActiveToolsByName: () => {},
    getContextUsage: () => undefined,
    getSteeringMessages: () => [], getFollowUpMessages: () => [],
    abort: async () => { sdkAborts++; }, abortCompaction: () => {}, abortBash: () => {},
    clearQueue: () => ({ steering: [], followUp: [] }),
    prompt: async () => { modelPrompts++; }, extensionRunner: { emit: async () => {} },
  };
  const wrapper = new AgentSessionWrapper(inner, 'normal');
  wrapper.extensionBindingPromise = binding.promise;
  const start = wrapper.startTrackedPrompt.bind(wrapper);
  wrapper.startTrackedPrompt = input => { entered.resolve(); return start(input); };
  const store = new SessionControlStore({ root }), router = new SessionMessageRouter({ store,
    events: new SessionCommandEventHub(store), resolver: async () => ({ session: wrapper, realSessionId: id, cwd: root }) });
  globalThis.__piSessions = new Map([[id, wrapper]]); resetSessionInboxesForTests();
  t.after(async () => { binding.resolve(); await router.resumeSession(id); wrapper.destroy(); resetSessionInboxesForTests(); globalThis.__piSessions = oldRegistry;
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true }); });
  const key = randomUUID(), submitted = await router.dispatchSessionMessage({ targetSessionId: id, idempotencyKey: key, content: 'actual wrapper pending prompt', source: 'system' });
  await entered.promise;
  assert.equal(wrapper.getActivePromptRunId(), undefined); assert.equal(wrapper.isRunning(), false);
  const before = wrapper.abortGeneration;
  const stopped = await router.cancelPromptSubmission({ targetSessionId: id, idempotencyKey: key, promptCommandId: submitted.commandId });
  assert.equal(stopped.status, 'cancelled'); assert.equal(wrapper.abortGeneration, before + 1); assert.equal(sdkAborts, 1);
  binding.resolve(); await router.resumeSession(id);
  assert.equal(modelPrompts, 0); assert.equal(wrapper.getActivePromptRunId(), undefined);
  assert.equal((await router.getCommand(submitted.commandId)).status, 'cancelled');
  assert.equal(store.loadCommands(id)[0].content, 'actual wrapper pending prompt');
});
