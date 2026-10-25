import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { SessionMessageRouter } = await jiti.import("./session-message-router.ts");
const { SessionControlStore } = await jiti.import("./session-control-store.ts");
const { SessionCommandEventHub } = await jiti.import("./session-command-events.ts");
const { resetSessionInboxesForTests } = await jiti.import("./session-inbox.ts");
const { createChatCommandCatalog, parseChatInput, createChatCommandOperation } = await jiti.import("./chat-command-input.ts");
const catalog = createChatCommandCatalog([{ name: "inspect", source: "extension" }, { name: "review", source: "prompt", usesTemplateArguments: true }]);

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, "operation did not settle");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

class Session {
  sessionId = "command-session";
  active = false;
  listeners = new Set();
  starts = [];
  runId;
  isAlive() { return true; }
  isRunning() { return this.active; }
  getRuntime() { return this.active ? "running" : "idle"; }
  getActivePromptRunId() { return this.runId; }
  getTaskRuntimeSnapshot() { return { runtime: this.getRuntime(), pendingApproval: false }; }
  onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onDestroy() { return () => {}; }
  emit(event) { for (const listener of this.listeners) listener(event); }
  async startTrackedPrompt(input) {
    assert.equal(this.active, false);
    this.active = true;
    this.runId = `run-${this.starts.length}`;
    this.starts.push(input);
    this.emit({ type: "prompt_started", commandId: input.commandId, runId: this.runId });
    setTimeout(() => { this.active = false; this.emit({ type: "prompt_done", commandId: input.commandId, runId: this.runId }); this.runId = undefined; this.emit({ type: "session_idle" }); }, 15);
    return { runId: this.runId };
  }
}

async function fixture(context, executor = async () => ({ title: "done" })) {
  const root = await mkdtemp(join(tmpdir(), "piora-chat-commands-"));
  resetSessionInboxesForTests();
  const session = new Session();
  const previous = globalThis.__piSessions;
  globalThis.__piSessions = new Map([[session.sessionId, session]]);
  const store = new SessionControlStore({ root });
  const router = new SessionMessageRouter({ store, events: new SessionCommandEventHub(store), resolver: async () => ({ session, realSessionId: session.sessionId }), commandExecutor: executor });
  context.after(async () => {
    await Promise.allSettled([...router.operationExecutions.values()]);
    await router.resumeSession(session.sessionId);
    globalThis.__piSessions = previous;
    resetSessionInboxesForTests();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const input = (text, key = text, options = {}) => ({ targetSessionId: session.sessionId, source: "ui", delivery: "next_turn", content: text, idempotencyKey: key, operation: createChatCommandOperation(text, catalog, parseChatInput(text, catalog, options), options) });
  return { session, store, router, input };
}

test("a reload and query are archived together before execution and run exactly once", async context => {
  let executions = 0;
  const fixtureState = await fixture(context, async record => {
    executions++;
    const stored = fixtureState.store.loadCommands(record.targetSessionId)[0];
    assert.equal(stored.operation.afterPrompt, "检查当前项目");
    assert.equal(stored.operation.steps.length, 2);
    return { title: "reloaded" };
  });
  const { router, input, session } = fixtureState;
  const submission = input("/reload 检查当前项目", "same-submission");
  const receipt = await router.dispatchSessionMessage(submission);
  await router.dispatchSessionMessage(submission);
  await waitFor(async () => (await router.getCommand(receipt.commandId)).status === "completed");
  assert.equal(executions, 1);
  assert.equal(session.starts.length, 1);
  assert.equal(session.starts[0].message, "检查当前项目");
  assert.equal(session.starts[0].clientPromptId, undefined);
  await waitFor(() => fixtureState.store.completedSlashPromptIds(session.sessionId).includes("same-submission"));
  assert.deepEqual((await router.getCommand(receipt.commandId)).operation.steps.map(step => step.status), ["completed", "completed"]);
});

test("extension-owned model cancellation aborts only its matching PromptRun", async context => {
  let release;
  const model = new Promise(resolve => { release = resolve; });
  const state = await fixture(context, async (record, execution) => {
    const session = execution.session;
    session.active = true;
    session.runId = "extension-owned-run";
    session.emit({ type: "prompt_started", commandId: record.commandId, runId: session.runId });
    await model;
    execution.assertActive();
    return { title: "done" };
  });
  const aborts = [];
  state.session.send = async command => {
    aborts.push(command);
    state.session.active = false;
    state.session.runId = undefined;
    release();
    return {};
  };
  const receipt = await state.router.dispatchSessionMessage(state.input("/inspect"));
  await waitFor(async () => (await state.router.getCommand(receipt.commandId)).runId === "extension-owned-run");
  const cancellation = await state.router.cancelCommand(receipt.commandId);
  assert.equal(cancellation.status, "cancelled");
  assert.equal(aborts.length, 1);
  assert.equal(aborts[0].runId, "extension-owned-run");
  await waitFor(() => state.store.loadCommands(state.session.sessionId)[0].operation.steps[0].status === "cancelled");
});

test("durable operation snapshots and events carry monotonic per-command revisions", async context => {
  const state = await fixture(context, async (_record, execution) => {
    execution.phase("waiting_input");
    execution.phase("executing");
    return { title: "done" };
  });
  const receipt = await state.router.dispatchSessionMessage(state.input("/inspect"));
  await waitFor(() => state.store.loadCommands(state.session.sessionId)[0]?.status === "completed");
  await waitFor(() => state.router.listEvents(state.session.sessionId).some(event => event.type === "command_completed"));
  const events = state.router.listEvents(state.session.sessionId).filter(event => event.commandId === receipt.commandId && event.revision !== undefined);
  assert.ok(events.length > 3);
  assert.deepEqual(events.map(event => event.revision), [...events.map(event => event.revision)].sort((left, right) => left - right));
  assert.equal(events.at(-1).revision, state.store.loadCommands(state.session.sessionId)[0].revision);
  assert.notEqual(events.find(event => event.operation?.phase === "waiting_input")?.operation.phase, "settling");
});

test("failed commands block their query and retain the exact original across reload", async context => {
  const { router, store, input, session } = await fixture(context, async () => { throw new Error("extension could not load"); });
  await router.dispatchSessionMessage(input("/reload 保留这条\n后续问题"));
  await waitFor(() => store.loadCommands(session.sessionId)[0]?.status === "failed");
  assert.equal(session.starts.length, 0);
  const saved = store.loadCommands(session.sessionId)[0];
  assert.equal(saved.operation.rawText, "/reload 保留这条\n后续问题");
  assert.equal(saved.operation.steps[1].status, "blocked");
  assert.equal(saved.errorMessage, "extension could not load");
});

test("extension commands execute during the model run while reload waits", async context => {
  const executed = [];
  const { router, input, session } = await fixture(context, async record => { executed.push(record.operation.command.name); return { title: "done" }; });
  session.active = true;
  const reload = await router.dispatchSessionMessage(input("/reload", "reload"));
  const extension = await router.dispatchSessionMessage(input("/inspect status", "extension"));
  await waitFor(async () => (await router.getCommand(extension.commandId)).status === "completed");
  assert.deepEqual(executed, ["inspect"]);
  assert.equal((await router.getCommand(reload.commandId)).status, "queued");
  assert.equal(session.active, true);
  session.active = false;
  session.emit({ type: "session_idle" });
  await waitFor(async () => (await router.getCommand(reload.commandId)).status === "completed");
  assert.deepEqual(executed, ["inspect", "reload"]);
});

test("explicit next-turn extensions wait while explicitly steered model commands admit immediately", async context => {
  const executed = [];
  const { router, input, session } = await fixture(context, async record => { executed.push(record.operation.command.name); return { title: "done" }; });
  session.active = true;
  session.runId = "parent-model";
  const extension = await router.dispatchSessionMessage(input("/inspect", "deferred-extension", { delivery: "next_turn" }));
  assert.equal((await router.getCommand(extension.commandId)).status, "queued");
  const model = await router.dispatchSessionMessage(input("/review API", "steered-template", { delivery: "steer" }));
  await waitFor(async () => (await router.getCommand(model.commandId)).status === "completed");
  assert.deepEqual(executed, ["review"]);
  session.active = false; session.runId = undefined; session.emit({ type: "session_idle" });
  await waitFor(() => executed.includes("inspect"));
});

test("clipboard success requires the exact client acknowledgement and never journals the text", async context => {
  const secret = "clipboard-content-not-for-the-journal";
  const { router, store, input, session } = await fixture(context, async (_record, execution) => { await execution.copy(secret); return { title: "copied" }; });
  const receipt = await router.dispatchSessionMessage(input("/copy", "copy"));
  await waitFor(async () => (await router.getCommand(receipt.commandId)).operation.phase === "waiting_client");
  const command = await router.getCommand(receipt.commandId);
  const requestId = command.operation.result.clientAction.id;
  assert.equal(command.status, "running");
  assert.throws(() => router.confirmClientAction(session.sessionId, receipt.commandId, "old-request", true));
  assert.deepEqual(router.getClientAction(session.sessionId, receipt.commandId, requestId), { text: secret });
  assert.equal((await readFile(store.commandsPath(session.sessionId), "utf8")).includes(secret), false);
  router.confirmClientAction(session.sessionId, receipt.commandId, requestId, true);
  await waitFor(async () => (await router.getCommand(receipt.commandId)).status === "completed");
});

test("unconfirmed clipboard requests expire without claiming success or sending the follow-up", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const state = await fixture(context, async (_record, execution) => { await execution.copy("not-confirmed"); return { title: "copied" }; });
  const until = async predicate => {
    const deadline = performance.now() + 5000;
    while (!await predicate()) {
      assert.ok(performance.now() < deadline, "clipboard expiry did not settle");
      await new Promise(resolve => setImmediate(resolve));
    }
  };
  const receipt = await state.router.dispatchSessionMessage(state.input("/copy 保存问题"));
  await until(async () => (await state.router.getCommand(receipt.commandId)).operation.phase === "waiting_client");
  context.mock.timers.tick(60_001);
  await until(() => state.store.loadCommands(state.session.sessionId)[0]?.status === "interrupted");
  const record = state.store.loadCommands(state.session.sessionId)[0];
  assert.equal(record.operation.steps[0].status, "failed");
  assert.equal(record.operation.steps[1].status, "blocked");
  assert.equal(state.session.starts.length, 0);
  assert.throws(() => state.router.getClientAction(state.session.sessionId, receipt.commandId, record.operation.result.clientAction.id));
});

test("cancelled queue entries do not execute when the session becomes idle", async context => {
  let executions = 0;
  const { router, input, session } = await fixture(context, async () => { executions++; return { title: "done" }; });
  session.active = true;
  const receipt = await router.dispatchSessionMessage(input("/reload question"));
  await router.cancelCommand(receipt.commandId);
  session.active = false;
  session.emit({ type: "session_idle" });
  await router.resumeSession(session.sessionId);
  assert.equal(executions, 0);
  assert.equal((await router.getCommand(receipt.commandId)).status, "cancelled");
});

test("an interrupted command is not replayed after process restart", async context => {
  const { router, store, input, session } = await fixture(context);
  const record = { ...input("/reload question"), commandId: "cmd-interrupted", acceptedAt: 1, status: "running" };
  record.operation.steps[0].status = "running";
  await store.appendCommand(record);
  const operations = await router.listOperations(session.sessionId);
  assert.equal(operations[0].status, "interrupted");
  assert.equal(operations[0].operation.steps[1].status, "blocked");
});


test("editing a queued follow-up changes only its query and never repeats the completed command", async context => {
  let executions = 0;
  const { router, input, session } = await fixture(context, async () => { executions++; return { title: "done" }; });
  session.active = true;
  const receipt = await router.dispatchSessionMessage(input("/inspect status", "edited-follow-up", { afterPrompt: "old query" }));
  await waitFor(async () => { const command = await router.getCommand(receipt.commandId); return command.status === "queued" && command.operation.steps[0].status === "completed"; });
  const paused = await router.queuedInputAction(session.sessionId, receipt.commandId, "pause");
  const saved = await router.queuedInputAction(session.sessionId, receipt.commandId, "edit", "new query", paused.revision);
  assert.equal(saved.operation.steps[0].status, "completed");
  assert.equal(saved.operation.afterPrompt, "new query");
  assert.equal(saved.operation.inputOptions.afterPrompt, "new query");
  session.active = false; session.emit({ type: "session_idle" });
  await waitFor(async () => (await router.getCommand(receipt.commandId)).status === "completed");
  assert.equal(executions, 1);
  assert.equal(session.starts.length, 1);
  assert.equal(session.starts[0].message, "new query");
});
