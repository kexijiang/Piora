import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { AgentSessionWrapper, stopRpcSessionsForFileMutation } = await jiti.import("./rpc-manager.ts");
const promptRuns = await jiti.import("./prompt-run-registry.ts");
const { writeModelFallbackConfig } = await jiti.import("./model-fallback-config.ts");
const { scheduleSessionModels, readPendingSessionModel } = await jiti.import("./session-model-selection.ts");

test("a project model request leaves the active turn untouched and applies before the next prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "piora-project-model-live-")); const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
  const fake = createFakeSession("project-next-model"); const old = { provider: "p", id: "old", input: ["text"] }, next = { provider: "p", id: "next", input: ["text"] };
  fake.session.model = old; fake.session.modelRuntime.getModel = () => next; fake.session.setModel = async (model) => { fake.session.model = model; };
  const wrapper = new AgentSessionWrapper(fake.session); wrapper.start();
  try {
    const done = deferred(); wrapper.onEvent((event) => { if (event.type === "prompt_done") done.resolve(); });
    await wrapper.send({ type: "prompt", message: "first" }); await fake.promptStarted.promise;
    scheduleSessionModels([wrapper.sessionId], { provider: "p", modelId: "next" }); assert.equal(fake.session.model.id, "old"); assert.equal(fake.abortCount, 0);
    fake.promptFinished.resolve(); await done.promise;
    const second = deferred(); let observed;
    fake.session.prompt = async () => { observed = fake.session.model.id; };
    wrapper.onEvent((event) => { if (event.type === "prompt_done") second.resolve(); });
    await wrapper.send({ type: "prompt", message: "second" }); await second.promise;
    assert.equal(observed, "next"); assert.equal(readPendingSessionModel(wrapper.sessionId), undefined); assert.equal(fake.abortCount, 0);
  } finally { wrapper.destroy(); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(root, { recursive: true, force: true }); }
});

test.afterEach(() => {
  promptRuns.resetPromptRunRegistryForTests();
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("a send receipt annotates the user object before SDK persistence and never the next user", async () => {
  const fake = createFakeSession("send-receipt");
  const wrapper = new AgentSessionWrapper(fake.session);
  wrapper.start();
  try {
    await wrapper.startTrackedPrompt({ commandId: "cmd-receipt", clientPromptId: "exact-send", source: "ui", message: "original" });
    const user = { role: "user", content: "original" };
    fake.emit({ type: "message_end", message: user });
    assert.equal(JSON.parse(JSON.stringify(user)).clientPromptId, "exact-send");
    const later = { role: "user", content: "another message" };
    fake.emit({ type: "message_end", message: later });
    assert.equal(later.clientPromptId, undefined);
  } finally { fake.promptFinished.resolve(); wrapper.destroy(); }
});

test("deletion also drains an already-destroyed wrapper removed from the registry", async () => {
  const fake = createFakeSession("removed-wrapper");
  const shutdown = deferred();
  let disposed = false;
  fake.session.extensionRunner.emit = async () => { await shutdown.promise; };
  fake.session.dispose = () => { disposed = true; };
  const wrapper = new AgentSessionWrapper(fake.session, "normal");
  wrapper.destroy();
  assert.equal(globalThis.__piSessions?.has("removed-wrapper") ?? false, false);
  let drained = false;
  const drain = stopRpcSessionsForFileMutation(["removed-wrapper"]).then(() => { drained = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  shutdown.resolve();
  await drain;
  assert.equal(disposed, true);
});

test("manual shell chunks are emitted before the command finishes", async () => {
  const fake = createFakeSession("shell-output");
  fake.session.sessionManager.getSessionFile = () => undefined;
  const finished = deferred();
  fake.session.executeBash = async (_command, onChunk) => {
    onChunk("first line\n");
    await finished.promise;
    onChunk("last line\n");
    return { output: "first line\nlast line\n", exitCode: 0 };
  };
  const wrapper = new AgentSessionWrapper(fake.session);
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  try {
    const pending = wrapper.send({ type: "bash", command: "echo test" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events.filter((event) => event.type === "bash_output").map((event) => event.output), ["first line\n"]);
    finished.resolve();
    await pending;
    assert.deepEqual(events.filter((event) => event.type === "bash_output").map((event) => event.output), ["first line\n", "last line\n"]);
  } finally { finished.resolve(); wrapper.destroy(); }
});

test("file mutation shutdown waits for transport writers and extension shutdown", async () => {
  const fake = createFakeSession("mutation-drain");
  const transport = deferred();
  const extensions = deferred();
  const order = [];
  fake.session.abort = async () => { await transport.promise; order.push("writer-finished"); };
  fake.session.extensionRunner.emit = async () => { await extensions.promise; order.push("shutdown-finished"); };
  fake.session.dispose = () => order.push("disposed");
  const wrapper = new AgentSessionWrapper(fake.session, "normal");
  const stopping = wrapper.shutdownForFileMutation().then(() => order.push("files-may-move"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, []);
  transport.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["writer-finished"]);
  extensions.resolve();
  await stopping;
  assert.deepEqual(order, ["writer-finished", "shutdown-finished", "disposed", "files-may-move"]);
  assert.equal(wrapper.isAlive(), false);
});

function createFakeSession(sessionId, toolNames = [], initialSessionName) {
  const promptStarted = deferred();
  const promptFinished = deferred();
  let activeTools = ["read", "bash", "edit", "grep"];
  let abortCount = 0;
  let reloadCount = 0;
  let sessionName = initialSessionName;
  let sessionNameReadCount = 0;
  let subscriber = () => {};
  const customEntries = [];
  const state = { systemPrompt: "Base instructions", thinkingLevel: "off" };

  return {
    promptStarted,
    promptFinished,
    customEntries,
    emit: (event) => subscriber(event),
    get abortCount() { return abortCount; },
    get reloadCount() { return reloadCount; },
    get sessionNameReadCount() { return sessionNameReadCount; },
    session: {
      sessionId,
      sessionFile: undefined,
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      autoCompactionEnabled: true,
      autoRetryEnabled: true,
      model: undefined,
      modelRuntime: {
        getModel: () => undefined,
        refresh: async () => undefined,
      },
      sessionManager: {
        getSessionFile: () => undefined,
        getCwd: () => process.cwd(),
        getSessionName: () => {
          sessionNameReadCount += 1;
          return sessionName;
        },
        getBranch: () => [],
        getEntries: () => customEntries.map((entry) => ({ type: "custom", ...entry })),
        appendCustomEntry: (customType, data) => {
          customEntries.push({ customType, data });
          return `custom-${customEntries.length}`;
        },
      },
      agent: { state },
      extensionRunner: { getRegisteredCommands: () => [] },
      promptTemplates: [],
      resourceLoader: {
        getSkills: () => ({ skills: [] }),
        getExtensions: () => ({ extensions: [], errors: [] }),
      },
      subscribe: (listener) => {
        subscriber = listener;
        return () => { subscriber = () => {}; };
      },
      prompt: async () => {
        promptStarted.resolve();
        await promptFinished.promise;
      },
      setSessionName: (name) => { sessionName = name; },
      abort: async () => { abortCount += 1; },
      abortCompaction: () => {},
      abortBash: () => {},
      clearQueue: () => ({ steering: [], followUp: [] }),
      reload: async () => {
        reloadCount += 1;
        state.systemPrompt = "Updated instructions";
      },
      getActiveToolNames: () => [...activeTools],
      setActiveToolsByName: (names) => { activeTools = [...names]; },
      getAllTools: () => toolNames.map((name) => ({ name, description: `${name} description` })),
      getContextUsage: () => undefined,
      pendingMessageCount: 0,
      getSteeringMessages: () => [],
      getFollowUpMessages: () => [],
    },
  };
}

test("runtime snapshots reuse the cached session title until a rename updates it", () => {
  const fake = createFakeSession("session-cached-title", [], "Initial title");
  const wrapper = new AgentSessionWrapper(fake.session);

  assert.equal(fake.sessionNameReadCount, 1);
  assert.equal(wrapper.getTaskRuntimeSnapshot().title, "Initial title");
  assert.equal(wrapper.getTaskRuntimeSnapshot().title, "Initial title");
  assert.equal(fake.sessionNameReadCount, 1);

  wrapper.setSessionName("Renamed title");
  assert.equal(wrapper.getTaskRuntimeSnapshot().title, "Renamed title");
  assert.equal(fake.sessionNameReadCount, 1);
  wrapper.destroy();
});

test("restored notes wrappers enforce an empty tool ceiling independent of caller options", async () => {
  const fake = createFakeSession("notes-restored", ["read", "bash", "write"]);
  fake.customEntries.push({ customType: "piora-remote-policy", data: { policy: "notes" } });
  const wrapper = new AgentSessionWrapper(fake.session);
  try {
    wrapper.initializeSessionCapabilities();
    assert.deepEqual(fake.session.getActiveToolNames(), []);
    await assert.rejects(wrapper.send({ type: "set_tools", tools: ["bash"] }), /disabled/);
    await assert.rejects(wrapper.send({ type: "bash", command: "echo forbidden" }), /disabled/);
    assert.equal(wrapper.remotePolicy, "notes");
  } finally { wrapper.destroy(); }
});

test("extension status updates report work without pretending to wait for approval", () => {
  const fake = createFakeSession("session-extension-status");
  const wrapper = new AgentSessionWrapper(fake.session);
  wrapper.start();

  fake.emit({
    type: "extension_ui_request",
    id: "vision-progress",
    method: "setStatus",
    statusKey: "piora-vision-agent",
    statusText: "Analyzing image…",
  });
  assert.equal(wrapper.getTaskRuntimeSnapshot().activity.kind, "thinking");
  assert.equal(wrapper.getTaskRuntimeSnapshot().activity.message, "Analyzing image…");

  fake.emit({
    type: "extension_ui_request",
    id: "approval",
    method: "confirm",
    title: "Approve change",
    message: "Continue?",
  });
  assert.equal(wrapper.getTaskRuntimeSnapshot().activity.kind, "approval");
  wrapper.destroy();
});

test("ordinary and extension tools share the same persisted session capability controls", async () => {
  const fake = createFakeSession("session-capabilities", ["read", "browser", "piora_plan"]);
  const wrapper = new AgentSessionWrapper(fake.session);
  wrapper.initializeSessionCapabilities();

  assert.deepEqual(fake.session.getActiveToolNames(), ["browser", "read"]);
  const planOff = await wrapper.send({
    type: "set_capabilities",
    preset: "custom",
    enabledCapabilityIds: ["tool:read", "tool:browser"],
    expectedRevision: 0,
  });
  assert.equal(planOff.policy.preset, "custom");
  assert.deepEqual(fake.session.getActiveToolNames(), ["browser", "read"]);

  await wrapper.send({
    type: "set_capabilities",
    preset: "custom",
    enabledCapabilityIds: ["tool:read", "tool:piora_plan"],
    expectedRevision: 1,
  });
  assert.deepEqual(fake.session.getActiveToolNames(), ["piora_plan", "read"]);
  assert.equal(fake.customEntries.at(-1).customType, "piora-session-capabilities");
  wrapper.destroy();
});

test("project-managed tools replace idle sessions and reject per-session overrides", async (t) => {
  const fake = createFakeSession("project-tools-idle", ["read", "harmony_control"]);
  const wrapper = new AgentSessionWrapper(fake.session, "normal", {
    projectRoot: process.cwd(),
    projectManaged: true,
  });
  wrapper.initializeSessionCapabilities();

  t.after(() => wrapper.destroy());
  assert.equal(wrapper.applyProjectCapabilitySettings({
    projectRoot: process.cwd(),
    revision: 3,
    preset: "custom",
    enabledCapabilityIds: ["tool:harmony_tap"],
    updatedAt: new Date().toISOString(),
  }), "applied");
  assert.deepEqual(fake.session.getActiveToolNames(), ["harmony_control"]);
  await assert.rejects(
    wrapper.send({ type: "set_capabilities", preset: "coding", expectedRevision: 3 }),
    /managed by this project's settings/,
  );
  wrapper.destroy();
});

test("running sessions defer project tool changes until the current run finishes", async (t) => {
  const fake = createFakeSession("project-tools-busy", ["read", "harmony_control"]);
  const wrapper = new AgentSessionWrapper(fake.session, "normal", { projectRoot: process.cwd() });
  t.after(() => { fake.promptFinished.resolve(); wrapper.destroy(); });
  wrapper.initializeSessionCapabilities();
  await wrapper.send({ type: "prompt", message: "Keep running" });
  await fake.promptStarted.promise;

  assert.equal(wrapper.applyProjectCapabilitySettings({
    projectRoot: process.cwd(),
    revision: 1,
    preset: "custom",
    enabledCapabilityIds: ["tool:harmony_tap"],
    updatedAt: new Date().toISOString(),
  }), "deferred");
  assert.deepEqual(fake.session.getActiveToolNames(), ["harmony_control", "read"]);

  fake.promptFinished.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fake.session.getActiveToolNames(), ["harmony_control"]);
  wrapper.destroy();
});

test("destroy aborts an active ordinary prompt without changing its tool selection", async () => {
  const fake = createFakeSession("session-destroy");
  const wrapper = new AgentSessionWrapper(fake.session);

  await wrapper.send({ type: "prompt", message: "Keep running until shutdown" });
  await fake.promptStarted.promise;
  wrapper.destroy();
  fake.promptFinished.resolve();

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.abortCount, 1);
  assert.deepEqual(fake.session.getActiveToolNames(), ["read", "bash", "edit", "grep"]);
});

test("abort acknowledges before slow model cleanup becomes idle", async () => {
  const fake = createFakeSession("session-fast-abort");
  const abortFinished = deferred();
  const queuedMessages = { steering: ["stop repeating", "stop repeating"], followUp: ["then check the result"] };
  let remaining = structuredClone(queuedMessages);
  let queueClears = 0;
  fake.session.clearQueue = () => { queueClears += 1; const queued = remaining; remaining = { steering: [], followUp: [] }; return queued; };
  fake.session.abort = async () => { await abortFinished.promise; };
  const wrapper = new AgentSessionWrapper(fake.session);
  const events = [];
  wrapper.onEvent(event => events.push(event));
  wrapper.start();

  await wrapper.send({ type: "prompt", message: "Wait for a slow model" });
  await fake.promptStarted.promise;

  const result = await Promise.race([
    wrapper.send({ type: "abort" }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("abort acknowledgement timed out")), 100)),
  ]);
  assert.equal(typeof result.queuedMessages.id, "string");
  assert.deepEqual(result, { accepted: true, queuedMessages: { id: result.queuedMessages.id, ...queuedMessages } });
  assert.equal(wrapper.getRuntime(), "stopping");
  assert.deepEqual(await wrapper.send({ type: "abort" }), result, "a retried stop retains the unconsumed handoff");
  assert.equal(queueClears, 1);
  const eventCount = events.length;
  fake.emit({ type: "agent_start" });
  assert.equal(events.length, eventCount, "late cancelled SDK events must not start a fresh stream");

  fake.promptFinished.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.find(event => event.type === "prompt_done")?.aborted, true);
  assert.equal(wrapper.getRuntime(), "stopping");
  await assert.rejects(
    wrapper.send({ type: "prompt", message: "Do not overlap abort cleanup" }),
    /session is busy/,
  );

  abortFinished.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(wrapper.getRuntime(), "idle");
  assert.deepEqual(await wrapper.send({ type: "abort" }), result, "a lost response can be retried after cleanup too");
  await wrapper.send({ type: "prompt", message: "Resume the saved guidance" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await wrapper.send({ type: "abort" }), { accepted: true }, "the next run cannot replay an earlier handoff");
  wrapper.destroy();
});

test("extension restart destroys an idle wrapper so the next request rebuilds its load plan", async () => {
  const fake = createFakeSession("session-extension-restart");
  const wrapper = new AgentSessionWrapper(fake.session);
  await wrapper.send({ type: "restart_extensions" });
  assert.equal(wrapper.isAlive(), false);
});

test("model fallback keeps one tracked run active and emits terminal success only after recovery", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "piora-rpc-fallback-"));
  const previousRoot = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousRoot;
    rmSync(root, { recursive: true, force: true });
  });
  writeModelFallbackConfig({ enabled: true }, root);
  const fake = createFakeSession("session-model-fallback");
  const primary = { provider: "primary", id: "model", name: "model", input: ["text"], contextWindow: 128000 };
  const backup = { ...primary, provider: "backup" };
  fake.session.model = primary;
  fake.session.settingsManager = { reload: async () => {}, getEnabledModels: () => undefined };
  fake.session.modelRuntime.getAvailable = async () => [primary, backup];
  fake.session.agent.state.messages = [];
  fake.session.setModel = async (model) => { fake.session.model = model; };
  let promptCount = 0;
  fake.session.prompt = async (_text, options) => {
    promptCount += 1;
    options.preflightResult(true);
    fake.emit({ type: "agent_start" });
    const message = { role: "assistant", stopReason: "error", errorMessage: "401 Unauthorized" };
    fake.session.agent.state.messages.push(message);
    fake.emit({ type: "message_end", message });
    fake.emit({ type: "agent_end" });
  };
  fake.session.sendCustomMessage = async () => {
    fake.promptStarted.resolve();
    await fake.promptFinished.promise;
    fake.emit({ type: "agent_start" });
    const message = { role: "assistant", stopReason: "stop", content: [] };
    fake.session.agent.state.messages.push(message);
    fake.emit({ type: "message_end", message });
    fake.emit({ type: "agent_end" });
  };
  const wrapper = new AgentSessionWrapper(fake.session);
  wrapper.start();
  t.after(() => wrapper.destroy());
  const events = [];
  const done = deferred();
  wrapper.onEvent((event) => { events.push(event); if (event.type === "prompt_done") done.resolve(); });
  await wrapper.startTrackedPrompt({ commandId: "fallback-command", source: "system", message: "Do the task" });
  await fake.promptStarted.promise;
  assert.equal(wrapper.isRunning(), true);
  assert.equal(events.filter((event) => event.type === "prompt_started").length, 1);
  assert.equal(events.some((event) => event.type === "prompt_done" || event.type === "prompt_error"), false);
  fake.promptFinished.resolve();
  await done.promise;
  assert.equal(promptCount, 1);
  assert.equal(events.filter((event) => event.type === "model_fallback").length, 1);
  assert.equal(events.filter((event) => event.type === "prompt_done").length, 1);
  assert.equal(events.some((event) => event.type === "prompt_error"), false);
  assert.equal(wrapper.getTaskRuntimeSnapshot().lastPromptFailed, false);
  assert.equal(new Set(events.filter((event) => event.runId).map((event) => event.runId)).size, 1);
});

test("stop fences a late model start after asynchronous SDK preflight", async () => {
  const fake = createFakeSession("session-abort-preflight");
  let modelStarts = 0;
  fake.session.prompt = async (_text, options) => {
    fake.promptStarted.resolve();
    await fake.promptFinished.promise;
    options.preflightResult(true);
    modelStarts += 1;
  };
  const wrapper = new AgentSessionWrapper(fake.session);
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  await wrapper.send({ type: "prompt", message: "slow preflight" });
  await fake.promptStarted.promise;
  await wrapper.send({ type: "abort" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(wrapper.getRuntime(), "stopping", "SDK abort alone can resolve before preflight");
  await assert.rejects(wrapper.send({ type: "prompt", message: "must not overlap" }), /busy/);
  await assert.rejects(wrapper.send({ type: "follow_up", message: "must not resume" }), /busy/);
  fake.promptFinished.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(modelStarts, 0);
  assert.equal(wrapper.getRuntime(), "idle");
  assert.equal(wrapper.getTaskRuntimeSnapshot().lastPromptFailed, false);
  assert.equal(events.some((event) => event.type === "prompt_error"), false);
  assert.ok(events.some((event) => event.type === "session_idle"));
  wrapper.destroy();
});

test("stop signals compaction, shell, queued messages and pending UI without waiting for transport", async () => {
  const fake = createFakeSession("session-abort-all");
  const abortFinished = deferred();
  const signals = [];
  fake.session.abort = async () => { signals.push("model"); await abortFinished.promise; };
  fake.session.abortCompaction = () => { signals.push("compaction"); };
  fake.session.abortBash = () => { signals.push("bash"); };
  fake.session.clearQueue = () => { signals.push("queue"); return { steering: [], followUp: [] }; };
  const wrapper = new AgentSessionWrapper(fake.session);
  const dialog = wrapper.requestExtensionUi({ method: "confirm", title: "Question" }, false, () => true);
  await wrapper.send({ type: "abort" });
  assert.deepEqual(signals, ["model", "compaction", "bash", "queue"]);
  assert.equal(await dialog, false);
  assert.equal(wrapper.getTaskRuntimeSnapshot().pendingApproval, false);
  abortFinished.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  wrapper.destroy();
});

test("state snapshots expose active tool names for reconnect and reconciliation", async () => {
  const fake = createFakeSession("session-active-tools");
  const wrapper = new AgentSessionWrapper(fake.session);
  wrapper.start();
  fake.emit({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "private-path" } });
  fake.emit({ type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: { command: "private-command" } });
  assert.deepEqual((await wrapper.send({ type: "get_state" })).activeTools, [{ id: "a", name: "read" }, { id: "b", name: "bash" }]);
  fake.emit({ type: "tool_execution_end", toolCallId: "a", toolName: "read", result: { content: [] } });
  assert.deepEqual((await wrapper.send({ type: "get_state" })).activeTools, [{ id: "b", name: "bash" }]);
  wrapper.destroy();
});

test("system prompt changes reload idle sessions and defer busy sessions without aborting them", async () => {
  const idle = createFakeSession("session-system-prompt-idle");
  const idleWrapper = new AgentSessionWrapper(idle.session);
  const idleEvents = [];
  idleWrapper.onEvent((event) => idleEvents.push(event));

  assert.equal(await idleWrapper.requestSystemPromptReload(), "reloaded");
  assert.equal(idle.reloadCount, 1);
  assert.equal(idle.session.agent.state.systemPrompt, "Updated instructions");
  assert.ok(idleEvents.some((event) => event.type === "system_prompt_reloaded"));
  idleWrapper.destroy();

  const busy = createFakeSession("session-system-prompt-busy");
  const busyWrapper = new AgentSessionWrapper(busy.session);
  const reloaded = new Promise((resolve) => {
    busyWrapper.onEvent((event) => {
      if (event.type === "system_prompt_reloaded") resolve();
    });
  });
  await busyWrapper.send({ type: "prompt", message: "Keep this run alive while settings change" });
  await busy.promptStarted.promise;
  assert.equal(await busyWrapper.requestSystemPromptReload(), "deferred");
  assert.equal(busy.reloadCount, 0);
  assert.equal(busy.abortCount, 0);

  busy.promptFinished.resolve();
  await reloaded;
  assert.equal(busy.reloadCount, 1);
  assert.equal(busy.abortCount, 0);
  busyWrapper.destroy();
});
