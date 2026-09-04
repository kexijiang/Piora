import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const promptRuns = await jiti.import("./prompt-run-registry.ts");

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

test("project-managed tools replace idle sessions and reject per-session overrides", async () => {
  const fake = createFakeSession("project-tools-idle", ["read", "harmony_tap"]);
  const wrapper = new AgentSessionWrapper(fake.session, "normal", {
    projectRoot: process.cwd(),
    projectManaged: true,
  });
  wrapper.initializeSessionCapabilities();

  assert.equal(wrapper.applyProjectCapabilitySettings({
    projectRoot: process.cwd(),
    revision: 3,
    preset: "custom",
    enabledCapabilityIds: ["tool:harmony_tap"],
    updatedAt: new Date().toISOString(),
  }), "applied");
  assert.deepEqual(fake.session.getActiveToolNames(), ["harmony_tap"]);
  await assert.rejects(
    wrapper.send({ type: "set_capabilities", preset: "coding", expectedRevision: 3 }),
    /managed by this project's settings/,
  );
  wrapper.destroy();
});

test("running sessions defer project tool changes until the current run finishes", async () => {
  const fake = createFakeSession("project-tools-busy", ["read", "harmony_tap"]);
  const wrapper = new AgentSessionWrapper(fake.session, "normal", { projectRoot: process.cwd() });
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
  assert.deepEqual(fake.session.getActiveToolNames(), ["read"]);

  fake.promptFinished.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fake.session.getActiveToolNames(), ["harmony_tap"]);
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
  fake.session.abort = async () => { await abortFinished.promise; };
  const wrapper = new AgentSessionWrapper(fake.session);

  await wrapper.send({ type: "prompt", message: "Wait for a slow model" });
  await fake.promptStarted.promise;

  const result = await Promise.race([
    wrapper.send({ type: "abort" }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("abort acknowledgement timed out")), 100)),
  ]);
  assert.deepEqual(result, { accepted: true });
  assert.equal(wrapper.getRuntime(), "stopping");

  fake.promptFinished.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(wrapper.getRuntime(), "stopping");
  await assert.rejects(
    wrapper.send({ type: "prompt", message: "Do not overlap abort cleanup" }),
    /session is busy/,
  );

  abortFinished.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(wrapper.getRuntime(), "idle");
  wrapper.destroy();
});

test("extension restart destroys an idle wrapper so the next request rebuilds its load plan", async () => {
  const fake = createFakeSession("session-extension-restart");
  const wrapper = new AgentSessionWrapper(fake.session);
  await wrapper.send({ type: "restart_extensions" });
  assert.equal(wrapper.isAlive(), false);
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
