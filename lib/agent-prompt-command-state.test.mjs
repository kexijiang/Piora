import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const { SessionMessageRouter, SessionMessageRouterError } = await jiti.import('./session-message-router.ts');
const { SessionControlStore } = await jiti.import('./session-control-store.ts');
const { SessionCommandEventHub } = await jiti.import('./session-command-events.ts');
const { resetSessionInboxesForTests } = await jiti.import('./session-inbox.ts');
const routeSource = await readFile(new URL('../app/api/agent/[id]/route.ts', import.meta.url), 'utf8');
const routeCode = ts.transpileModule(routeSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

class ControlledSession {
  sessionId = 'session-a';
  runtimeProfile = 'normal';
  active = true;
  runId;
  commandId;
  listeners = new Set();
  destroyListeners = new Set();
  aborts = [];
  queuedMessages = { id: 'fixture-queue', steering: ['fixture steering'], followUp: ['fixture follow-up'] };
  startEntered;
  allowStart;
  isAlive() { return true; }
  isRunning() { return this.active; }
  getActivePromptRunId() { return this.runId; }
  getTaskRuntimeSnapshot() { return { id: this.sessionId, runtime: this.active ? 'running' : 'idle', pendingApproval: false, lastPromptFailed: false }; }
  onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onDestroy(listener) { this.destroyListeners.add(listener); return () => this.destroyListeners.delete(listener); }
  emit(event) { for (const listener of this.listeners) listener(event); }
  async send(command) {
    if (command.type === 'abort') {
      this.aborts.push(command);
      this.active = false;
      this.emit({ type: 'prompt_done', commandId: this.commandId, runId: this.runId });
      return { accepted: true, queuedMessages: this.queuedMessages };
    }
    assert.equal(command.type, 'get_state');
    return { runtime: this.active ? 'running' : 'idle', isStreaming: false, isPromptRunning: false };
  }
  async startTrackedPrompt(input) {
    this.commandId = input.commandId;
    this.startEntered?.();
    await new Promise(resolve => { this.allowStart = resolve; });
    this.active = true;
    this.runId = `run_${randomUUID()}`;
    return { accepted: true, sessionId: this.sessionId, commandId: input.commandId, runId: this.runId };
  }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'piora-command-state-'));
  resetSessionInboxesForTests();
  t.after(async () => { resetSessionInboxesForTests(); await rm(root, { recursive: true, force: true }); });
  const store = new SessionControlStore({ root });
  const session = new ControlledSession();
  const previousRegistry = globalThis.__piSessions;
  globalThis.__piSessions = new Map([[session.sessionId, session]]);
  t.after(() => { globalThis.__piSessions = previousRegistry; });
  const router = new SessionMessageRouter({ store, events: new SessionCommandEventHub(store),
    resolver: async sessionId => { assert.equal(sessionId, session.sessionId); return { session, realSessionId: sessionId, cwd: root }; } });
  const calls = { router: 0, profile: 0, state: 0, path: 0 };
  let live = session, filePath = join(root, 'fixture-session.jsonl');
  const exports = {};
  vm.runInNewContext(routeCode, { exports, URL, require: name => {
    if (name === 'next/server') return { NextResponse: Response };
    if (name === 'node:crypto') return { randomUUID };
    if (name === '@/lib/rpc-manager') return { getRpcSession: () => live };
    if (name === '@/lib/session-runtime-resolver') return { resolveOrStartRpcSession: () => { throw new Error('GET must not start a runtime'); } };
    if (name === '@/lib/session-reader') return { resolveSessionPath: async () => { calls.path++; return filePath; } };
    if (name === '@/lib/agent-runtime-profile') return { getAgentRuntimeProfile: () => 'normal' };
    if (name === '@/lib/agent-profile-store') return { resolveSessionAgentRuntimeProfile: async () => { calls.profile++; } };
    if (name === '@/lib/session-message-router') return { SessionMessageRouterError, getSessionMessageRouter: () => { calls.router++; return router; } };
    throw new Error(`Unexpected route dependency ${name}`);
  } });
  const get = (query = '', id = session.sessionId) => exports.GET(new Request(`http://localhost/api/agent/${id}${query}`), { params: Promise.resolve({ id }) });
  const post = (body, id = session.sessionId) => exports.POST(new Request(`http://localhost/api/agent/${id}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) });
  const query = commandId => `?promptCommandId=${encodeURIComponent(commandId)}`;
  const append = async (status, overrides = {}) => {
    const command = { commandId: `cmd_${randomUUID()}`, idempotencyKey: randomUUID(), targetSessionId: session.sessionId,
      content: 'PRIVATE_SYNTHETIC_BODY', images: [{ type: 'image', data: 'PRIVATE_IMAGE', mimeType: 'image/png' }],
      delivery: 'next_turn', source: 'ui', acceptedAt: Date.now(), status,
      errorMessage: 'PRIVATE_SQL_TOOL_PAYLOAD', ...overrides };
    await store.appendCommand(command);
    return command;
  };
  return { root, store, router, session, calls, get, post, query, append,
    setLive: value => { live = value; }, setFilePath: value => { filePath = value; } };
}

async function eventually(predicate) {
  const deadline = Date.now() + 4000;
  while (!await predicate()) {
    if (Date.now() >= deadline) assert.fail('Router did not reach the expected fixture state');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('actual handler preserves no-parameter live and inactive responses without reading the router', async t => {
  const f = await fixture(t);
  assert.deepEqual(await (await f.get()).json(), { running: true, state: { runtime: 'running', isStreaming: false, isPromptRunning: false }, runtimeProfile: 'normal' });
  f.setLive(undefined);
  assert.deepEqual(await (await f.get()).json(), { running: false, runtimeProfile: 'normal' });
  f.setFilePath(null);
  assert.deepEqual(await (await f.get()).json(), { running: false, runtimeProfile: 'normal' });
  assert.equal(f.calls.router, 0);
});

test('actual router queued, dispatching, running and completion are projected by the actual GET handler', async t => {
  const f = await fixture(t);
  const receipt = await f.router.dispatchSessionMessage({ targetSessionId: f.session.sessionId, content: 'synthetic controlled prompt', source: 'ui', idempotencyKey: randomUUID() });
  await eventually(() => f.session.listeners.size > 0);
  assert.equal((await (await f.get(f.query(receipt.commandId))).json()).promptCommand.status, 'queued');
  const entered = new Promise(resolve => { f.session.startEntered = resolve; });
  f.session.active = false;
  const draining = f.router.resumeSession(f.session.sessionId);
  await entered;
  assert.equal((await (await f.get(f.query(receipt.commandId))).json()).promptCommand.status, 'dispatching');
  f.session.allowStart();
  await eventually(async () => (await f.router.getCommand(receipt.commandId)).status === 'running');
  assert.deepEqual((await (await f.get(f.query(receipt.commandId))).json()).promptCommand, { commandId: receipt.commandId, status: 'running' });
  f.session.active = false;
  f.session.emit({ type: 'prompt_done', commandId: receipt.commandId, runId: f.session.runId });
  await draining;
  const response = await f.get(f.query(receipt.commandId));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.deepEqual(body.promptCommand, { commandId: receipt.commandId, status: 'completed' });
  assert.equal(body.state.runtime, 'idle');
});

test('all real journal statuses are preserved without content, images, errors or run payloads', async t => {
  const f = await fixture(t);
  f.session.active = false;
  for (const status of ['accepted', 'queued', 'dispatching', 'delivered', 'running', 'completed', 'failed', 'cancelled', 'expired', 'interrupted']) {
    const command = await f.append(status, { runId: 'PRIVATE_RUN', attachedRunId: 'PRIVATE_ATTACHED_RUN' });
    const body = await (await f.get(f.query(command.commandId))).json();
    assert.deepEqual(body.promptCommand, { commandId: command.commandId, status });
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE_/);
  }
});

test('inactive or missing runtime can return exact terminal command status without starting the session', async t => {
  const f = await fixture(t);
  const command = await f.append('failed');
  f.setLive(undefined);
  for (const filePath of [join(f.root, 'fixture-session.jsonl'), null]) {
    f.setFilePath(filePath);
    const body = await (await f.get(f.query(command.commandId))).json();
    assert.deepEqual(body, { running: false, runtimeProfile: 'normal', promptCommand: { commandId: command.commandId, status: 'failed' } });
  }
});

test('unknown, foreign-session, steer/follow-up and malformed journal status return null without exposing data', async t => {
  const f = await fixture(t);
  const commands = [
    { commandId: `cmd_${randomUUID()}` },
    await f.append('completed', { targetSessionId: 'session-b' }),
    await f.append('completed', { delivery: 'steer' }),
    await f.append('delivered', { delivery: 'steer' }),
    await f.append('PRIVATE_STATUS_PAYLOAD'),
  ];
  for (const command of commands) {
    const response = await f.get(f.query(command.commandId));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.promptCommand, null);
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE_/);
  }
});

test('empty, duplicate, non-command and overlong query values are rejected before runtime or journal reads', async t => {
  const f = await fixture(t);
  const id = `cmd_${randomUUID()}`;
  for (const query of ['?promptCommandId=', '?promptCommandId=not-a-command', '?promptCommandId=%00',
    `?promptCommandId=${encodeURIComponent('x'.repeat(4096))}`, `?promptCommandId=${id}&promptCommandId=${id}`]) {
    const response = await f.get(query);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Invalid promptCommandId.', code: 'INVALID_PROMPT_COMMAND_ID' });
  }
  assert.equal(f.calls.router, 0); assert.equal(f.calls.profile, 0); assert.equal(f.calls.path, 0);
});

test('real journal IO failure is an unavailable response, never null/completed or raw storage detail', async t => {
  const f = await fixture(t);
  await mkdir(f.root, { recursive: true });
  await writeFile(join(f.root, 'commands'), 'synthetic invalid journal directory');
  const response = await f.get(f.query(`cmd_${randomUUID()}`));
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.match(body.error, /Prompt command state is unavailable/);
  assert.equal(Object.hasOwn(body, 'promptCommand'), false);
  assert.doesNotMatch(JSON.stringify(body), /ENOTDIR|PRIVATE_|piora-command-state/);
});

test('actual cancellation handler preserves the exact submission key and prevents a late prompt from starting', async t => {
  const f = await fixture(t);
  const idempotencyKey = `ui:${randomUUID()}`;
  const response = await f.post({ type: 'cancel_prompt_submission', idempotencyKey });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { success: true, data: { accepted: true, sessionId: f.session.sessionId, status: 'cancellation_pending' } });
  assert.equal(f.session.aborts.length, 0);
  const late = await f.router.dispatchSessionMessage({ targetSessionId: f.session.sessionId, content: 'late synthetic prompt', source: 'ui', idempotencyKey });
  assert.equal(late.status, 'cancelled');
  assert.equal((await f.router.getCommand(late.commandId)).status, 'cancelled');
  assert.equal(f.session.commandId, undefined);
});

test('actual queued cancellation removes only the matching prompt and does not abort the unrelated active run', async t => {
  const f = await fixture(t);
  const key = randomUUID();
  const target = await f.router.dispatchSessionMessage({ targetSessionId: f.session.sessionId, content: 'cancel target', source: 'ui', idempotencyKey: key });
  const survivor = await f.router.dispatchSessionMessage({ targetSessionId: f.session.sessionId, content: 'keep survivor', source: 'ui', idempotencyKey: randomUUID() });
  await f.router.resumeSession(f.session.sessionId);
  const response = await f.post({ type: 'cancel_prompt_submission', idempotencyKey: key, promptCommandId: target.commandId });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.data.status, 'cancelled');
  assert.equal(body.data.commandId, target.commandId);
  assert.equal((await f.router.getCommand(target.commandId)).status, 'cancelled');
  assert.equal((await f.router.getCommand(survivor.commandId)).status, 'queued');
  assert.equal(f.session.aborts.length, 0);
});

test('padded queued prompt keys match exact-command cancellation after the same normalization', async t => {
  const f = await fixture(t);
  for (const key of [randomUUID(), 'k'.repeat(512)]) {
    const paddedKey = ` \t${key}\r\n `;
    const original = `  queued original ${key.slice(0, 8)}\n`;
    const submitted = await f.post({ type: 'prompt', message: original, idempotencyKey: paddedKey });
    assert.equal(submitted.status, 200);
    const receipt = await submitted.json();
    assert.equal(receipt.data.status, 'queued');
    const response = await f.post({ type: 'cancel_prompt_submission', idempotencyKey: paddedKey, promptCommandId: receipt.commandId });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.status, 'cancelled');
    const command = await f.router.getCommand(receipt.commandId);
    assert.equal(command.idempotencyKey, key);
    assert.equal(command.status, 'cancelled');
    assert.equal(command.content, original);
    const durable = f.store.loadCommands(f.session.sessionId).find(record => record.commandId === receipt.commandId);
    assert.equal(durable.status, 'cancelled');
    assert.equal(durable.content, original);
  }
  assert.equal(f.session.commandId, undefined);
  assert.equal(f.session.aborts.length, 0);
});

test('padded unknown cancellation before the prompt POST fences that normalized late admission and keeps original text', async t => {
  const f = await fixture(t);
  const key = randomUUID();
  const paddedKey = ` \t${key}\r\n `;
  const cancelled = await f.post({ type: 'cancel_prompt_submission', idempotencyKey: paddedKey });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).data.status, 'cancellation_pending');
  const original = '  late prompt original\n  keep the whitespace\n';
  const submitted = await f.post({ type: 'prompt', message: original, idempotencyKey: paddedKey });
  assert.equal(submitted.status, 200);
  const receipt = await submitted.json();
  assert.equal(receipt.data.status, 'cancelled');
  const command = await f.router.getCommand(receipt.commandId);
  assert.equal(command.idempotencyKey, key);
  assert.equal(command.status, 'cancelled');
  assert.equal(command.content, original);
  const durable = f.store.loadCommands(f.session.sessionId).find(record => record.commandId === receipt.commandId);
  assert.equal(durable.status, 'cancelled');
  assert.equal(durable.content, original);
  assert.equal(f.session.commandId, undefined);
  assert.equal(f.session.aborts.length, 0);
});

test('actual running cancellation returns the SDK queue handoff with exactly one addressed abort', async t => {
  const f = await fixture(t);
  const key = randomUUID();
  const target = await f.router.dispatchSessionMessage({ targetSessionId: f.session.sessionId, content: 'running target', source: 'ui', idempotencyKey: key });
  await f.router.resumeSession(f.session.sessionId);
  const entered = new Promise(resolve => { f.session.startEntered = resolve; });
  f.session.active = false;
  const draining = f.router.resumeSession(f.session.sessionId);
  await entered;
  f.session.allowStart();
  await eventually(async () => (await f.router.getCommand(target.commandId)).status === 'running');
  const response = await f.post({ type: 'cancel_prompt_submission', idempotencyKey: key, promptCommandId: target.commandId });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.status, 'cancelled');
  assert.equal(body.data.commandId, target.commandId);
  assert.deepEqual(body.data.queuedMessages, f.session.queuedMessages);
  assert.equal(f.session.aborts.length, 1);
  assert.equal(f.session.aborts[0].commandId, target.commandId);
  await draining;
  assert.equal((await f.router.getCommand(target.commandId)).status, 'cancelled');
});

test('unknown command and mismatched session, key or steer command cannot cancel another submission', async t => {
  const f = await fixture(t);
  const target = await f.append('queued');
  const foreign = await f.append('queued', { targetSessionId: 'session-b' });
  const steer = await f.append('delivered', { delivery: 'steer' });
  const inputs = [
    [{ type: 'cancel_prompt_submission', idempotencyKey: randomUUID(), promptCommandId: `cmd_${randomUUID()}` }, 404],
    [{ type: 'cancel_prompt_submission', idempotencyKey: target.idempotencyKey, promptCommandId: foreign.commandId }, 400],
    [{ type: 'cancel_prompt_submission', idempotencyKey: randomUUID(), promptCommandId: target.commandId }, 400],
    [{ type: 'cancel_prompt_submission', idempotencyKey: steer.idempotencyKey, promptCommandId: steer.commandId }, 400],
  ];
  for (const [input, status] of inputs) {
    const response = await f.post(input);
    assert.equal(response.status, status);
    assert.doesNotMatch(JSON.stringify(await response.json()), /PRIVATE_/);
  }
  assert.equal((await f.router.getCommand(target.commandId)).status, 'queued');
  assert.equal((await f.router.getCommand(foreign.commandId)).status, 'queued');
  assert.equal((await f.router.getCommand(steer.commandId)).status, 'delivered');
  assert.equal(f.session.aborts.length, 0);
});

test('terminal cancellation receipts preserve the actual terminal outcome without aborting a newer run', async t => {
  const f = await fixture(t);
  for (const status of ['completed', 'failed', 'cancelled', 'expired', 'interrupted']) {
    const command = await f.append(status);
    const response = await f.post({ type: 'cancel_prompt_submission', idempotencyKey: command.idempotencyKey, promptCommandId: command.commandId });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.status, status);
    assert.equal(body.data.commandId, command.commandId);
  }
  assert.equal(f.session.aborts.length, 0);
});

test('malformed cancellation identities are rejected before any router or runtime lookup', async t => {
  const f = await fixture(t);
  const base = { type: 'cancel_prompt_submission' };
  for (const body of [base, { ...base, idempotencyKey: null }, { ...base, idempotencyKey: '' },
    { ...base, idempotencyKey: ' ' }, { ...base, idempotencyKey: 'x'.repeat(513) },
    { ...base, idempotencyKey: 'valid', promptCommandId: '' }, { ...base, idempotencyKey: 'valid', promptCommandId: null },
    { ...base, idempotencyKey: 'valid', promptCommandId: ['bad'] }]) {
    const response = await f.post(body);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Invalid prompt cancellation identity.', code: 'INVALID_SESSION_MESSAGE' });
  }
  assert.equal(f.calls.router, 0); assert.equal(f.calls.profile, 0); assert.equal(f.calls.path, 0);
  assert.equal(f.session.aborts.length, 0);
});

test('legacy untracked abort preserves its existing SDK queue handoff response', async t => {
  const f = await fixture(t);
  const response = await f.post({ type: 'abort' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, data: { accepted: true, queuedMessages: f.session.queuedMessages } });
  assert.equal(f.session.aborts.length, 1);
  assert.equal(f.calls.router, 0);
});
