import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

// Runtime preferences must not depend on the developer's active desktop profile.
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fixtureAgentDir = mkdtempSync(join(tmpdir(), "piora-rpc-behavior-"));
process.env.PI_CODING_AGENT_DIR = fixtureAgentDir;
test.after(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  assert.ok(fixtureAgentDir.startsWith(join(tmpdir(), "piora-rpc-behavior-")));
  rmSync(fixtureAgentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url);
const { AgentSessionWrapper, stopRpcSessionsForFileMutation } = await jiti.import("./rpc-manager.ts");
const { retainSessionFileOwnership } = await jiti.import("./session-file-ownership.ts");
const wrappers = new Set();
function createWrapper(...args) {
  const wrapper = new AgentSessionWrapper(...args);
  wrappers.add(wrapper);
  return wrapper;
}

const promptRuns = await jiti.import("./prompt-run-registry.ts");
const { writeModelFallbackConfig } = await jiti.import("./model-fallback-config.ts");
const { scheduleSessionModels, readPendingSessionModel } = await jiti.import("./session-model-selection.ts");
const { writeConfiguredImageInput } = await jiti.import("./model-capabilities.ts");

async function waitForCondition(predicate, description) {
  const deadline = performance.now() + 5_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("image prompts use current capability settings and the pending project model", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "piora-live-image-input-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    for (const scenario of ["enabled-live", "disabled-live", "pending-vision", "pending-text"]) {
      await t.test(scenario, async () => {
        const fake = createFakeSession(`image-${scenario}`);
        const old = { provider: "image-test", id: scenario, input: scenario === "disabled-live" || scenario === "pending-text" ? ["text", "image"] : ["text"] };
        const next = { provider: "image-test", id: `${scenario}-next`, input: scenario === "pending-vision" ? ["text", "image"] : ["text"] };
        fake.session.model = old;
        fake.session.modelRuntime.getModel = () => next;
        fake.session.setModel = async (model) => { fake.session.model = model; };
        const wrapper = createWrapper(fake.session);
        wrapper.start();
        const events = [];
        wrapper.onEvent((event) => events.push(event));
        try {
          if (scenario.endsWith("-live")) writeConfiguredImageInput(old.provider, old.id, scenario === "enabled-live");
          else scheduleSessionModels([wrapper.sessionId], { provider: next.provider, modelId: next.id });
          const images = [{ type: "image", mimeType: "image/png", data: "eA==" }];
          let observed;
          const done = deferred();
          fake.session.prompt = async (_text, options) => { observed = { model: fake.session.model, images: options.images }; };
          wrapper.onEvent((event) => { if (event.type === "prompt_done") done.resolve(); });
          const command = { type: "prompt", message: "Describe this image", images };
          if (scenario === "disabled-live" || scenario === "pending-text") {
            await assert.rejects(wrapper.send(command), /does not support image input/);
            assert.equal(observed, undefined);
          } else {
            await wrapper.send(command);
            await done.promise;
            assert.deepEqual(observed.images, images);
            assert.ok(observed.model.input.includes("image"));
            assert.equal(observed.model.id, scenario === "pending-vision" ? next.id : old.id);
            assert.equal(events.some((event) => event.type === "prompt_error"), false);
          }
        } finally { wrapper.destroy(); }
      });
    }
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("live metrics and content remain available without a view and never mutate SDK messages", () => {
  const fake = createFakeSession("background-metrics");
  const wrapper = createWrapper(fake.session, "normal");
  wrapper.start();
  try {
    const message = { role: "assistant", content: [{ type: "text", text: "already generated" }] };
    fake.emit({ type: "message_start", message });
    assert.equal(wrapper.getStreamingMessage().content[0].text, "already generated");
    assert.equal(message.streamingMetrics, undefined);
    const events = [];
    const unsubscribe = wrapper.onEvent(event => events.push(event));
    message.content[0].text += " more";
    fake.emit({ type: "message_update", message });
    assert.equal(events.at(-1).message.streamingMetrics.generation, wrapper.getStreamingMetrics().generation);
    assert.equal(message.streamingMetrics, undefined);
    unsubscribe();
    fake.emit({ type: "message_end", message });
    assert.equal(wrapper.getStreamingMessage(), null);
    assert.equal(wrapper.getStreamingMetrics(), null);
  } finally { wrapper.destroy(); }
});

test("a project model request leaves the active turn untouched and applies before the next prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "piora-project-model-live-")); const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
  const fake = createFakeSession("project-next-model"); const old = { provider: "p", id: "old", input: ["text"] }, next = { provider: "p", id: "next", input: ["text"] };
  fake.session.model = old; fake.session.modelRuntime.getModel = () => next; fake.session.setModel = async (model) => { fake.session.model = model; };
  const wrapper = createWrapper(fake.session); wrapper.start();
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
  for (const wrapper of wrappers) wrapper.destroy();
  wrappers.clear();
  promptRuns.resetPromptRunRegistryForTests();
});

test("switching to a smaller context compacts before changing the model", async () => {
  const fake = createFakeSession("smaller-model-compaction");
  const old = { provider: "test", id: "large", contextWindow: 200, input: ["text"] };
  const small = { provider: "test", id: "small", contextWindow: 100, input: ["text"] };
  const order = [];
  fake.session.model = old;
  fake.session.modelRuntime.getModel = () => small;
  fake.session.getContextUsage = () => ({ tokens: 120, contextWindow: 200, percent: 60 });
  fake.session.agent.state.messages = [{ role: "user", content: "short" }];
  const original = () => ({ enabled: true, reserveTokens: 16, keepRecentTokens: 20000 });
  fake.session.settingsManager = { getCompactionSettings: original };
  fake.session.compact = async () => {
    order.push("compact");
    assert.ok(fake.session.settingsManager.getCompactionSettings().keepRecentTokens < 20000);
    fake.session.agent.state.messages = [{ role: "user", content: "summary" }];
    return { estimatedTokensAfter: 20 };
  };
  fake.session.setModel = async (model) => { order.push("set_model"); fake.session.model = model; };
  const wrapper = createWrapper(fake.session);
  try {
    const result = await wrapper.send({ type: "set_model", provider: "test", modelId: "small" });
    assert.deepEqual(order, ["compact", "set_model"]);
    assert.equal(result.compacted, true);
    assert.equal(fake.session.settingsManager.getCompactionSettings, original);
    assert.equal(fake.session.model.id, "small");
  } finally { wrapper.destroy(); }
});

test("failed or insufficient model-switch compaction keeps the original model", async () => {
  for (const insufficient of [false, true]) {
    const fake = createFakeSession(`small-model-rejected-${insufficient}`);
    const old = { provider: "test", id: "large", contextWindow: 200, input: ["text"] };
    fake.session.model = old;
    fake.session.modelRuntime.getModel = () => ({ provider: "test", id: "small", contextWindow: 100, input: ["text"] });
    fake.session.getContextUsage = () => ({ tokens: 150, contextWindow: 200, percent: 75 });
    fake.session.settingsManager = { getCompactionSettings: () => ({ enabled: true, reserveTokens: 16, keepRecentTokens: 20000 }) };
    fake.session.compact = async () => {
      if (!insufficient) throw new Error("compaction failed");
      return { estimatedTokensAfter: 120 };
    };
    fake.session.setModel = async () => { throw new Error("model must not change"); };
    const wrapper = createWrapper(fake.session);
    try {
      await assert.rejects(wrapper.send({ type: "set_model", provider: "test", modelId: "small" }), insufficient ? /exceeding/ : /compaction failed/);
      assert.equal(fake.session.model.id, "large");
    } finally { wrapper.destroy(); }
  }
});

test("an existing session selects edited model metadata from disk, including the same model ID", async () => {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const root = mkdtempSync(join(tmpdir(), "piora-live-model-refresh-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const modelsPath = join(root, "models.json");
    const save = (name, contextWindow, maxTokens, baseUrl) => writeFileSync(modelsPath, JSON.stringify({ providers: {
      "refresh-fixture": { api: "openai-completions", apiKey: "test-key", baseUrl, models: [
        { id: "editable", name, contextWindow, maxTokens, input: ["text"], reasoning: false },
      ] },
    } }));
    save("Before edit", 32000, 4096, "https://before.invalid/v1");
    const runtime = await ModelRuntime.create({ modelsPath, authPath: join(root, "auth.json") });
    const stale = runtime.getModel("refresh-fixture", "editable");
    const fake = createFakeSession("edited-live-model");
    fake.session.modelRuntime = runtime;
    fake.session.model = stale;
    fake.session.setModel = async model => { fake.session.model = model; };
    fake.session.getContextUsage = () => ({ tokens: 50, contextWindow: fake.session.model.contextWindow, percent: 0 });
    const wrapper = createWrapper(fake.session);
    try {
      save("After edit", 64000, 8192, "https://after.invalid/v1");
      assert.equal(runtime.getModel("refresh-fixture", "editable").name, "Before edit");
      await wrapper.send({ type: "set_model", provider: "refresh-fixture", modelId: "editable" });
      assert.equal(fake.session.model.name, "After edit");
      assert.equal(fake.session.model.contextWindow, 64000);
      assert.equal(fake.session.model.maxTokens, 8192);
      assert.equal(fake.session.model.baseUrl, "https://after.invalid/v1");
      assert.equal((await wrapper.send({ type: "get_state" })).contextUsage.contextWindow, 64000);
      assert.equal(stale.contextWindow, 32000, "the previous model snapshot is not mutated");
      writeFileSync(modelsPath, JSON.stringify({ providers: {} }));
      await assert.rejects(wrapper.send({ type: "set_model", provider: "refresh-fixture", modelId: "editable" }), /Model not found/);
      assert.equal(fake.session.model.name, "After edit", "removed models cannot be reselected from stale runtime data");
    } finally { wrapper.destroy(); }
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("reselecting an edited model with a smaller window compacts using its refreshed limit", async () => {
  const fake = createFakeSession("edited-smaller-window");
  const old = { provider: "test", id: "same", contextWindow: 200, input: ["text"] };
  const edited = { ...old, contextWindow: 100 };
  let cached = old;
  const order = [];
  fake.session.model = old;
  fake.session.modelRuntime.getModel = () => cached;
  fake.session.modelRuntime.refresh = async options => { assert.deepEqual(options, { allowNetwork: false }); cached = edited; order.push("refresh"); };
  fake.session.getContextUsage = () => ({ tokens: 120, contextWindow: 200, percent: 60 });
  fake.session.settingsManager = { getCompactionSettings: () => ({ keepRecentTokens: 20000 }) };
  fake.session.compact = async () => { order.push("compact"); return { estimatedTokensAfter: 20 }; };
  fake.session.setModel = async model => { order.push("set"); fake.session.model = model; };
  const wrapper = createWrapper(fake.session);
  try {
    assert.equal((await wrapper.send({ type: "set_model", provider: "test", modelId: "same" })).compacted, true);
    assert.deepEqual(order, ["refresh", "compact", "set"]);
    assert.equal(fake.session.model.contextWindow, 100);
  } finally { wrapper.destroy(); }
});

test("model refresh errors and tasks starting during refresh prevent a stale model switch", async () => {
  for (const busy of [false, true]) {
    const fake = createFakeSession(`refresh-failure-${busy}`);
    const old = { provider: "test", id: "old" };
    fake.session.model = old;
    fake.session.modelRuntime.refresh = async () => { if (busy) fake.session.isStreaming = true; else throw new Error("invalid model configuration"); };
    fake.session.setModel = async () => { assert.fail("must not switch"); };
    const wrapper = createWrapper(fake.session);
    try {
      await assert.rejects(wrapper.send({ type: "set_model", provider: "test", modelId: "old" }), busy ? /running|streaming|busy/i : /invalid model configuration/);
      assert.equal(fake.session.model, old);
    } finally { wrapper.destroy(); }
  }
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

test("compaction start time survives detached views, is shared by SSE and snapshots, and resets only for a new compaction", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100_000 });
  for (const prefix of ["", "auto_"]) {
    const fake = createFakeSession(`compaction-clock-${prefix}`);
    const other = createFakeSession(`other-clock-${prefix}`);
    const wrapper = createWrapper(fake.session);
    const otherWrapper = createWrapper(other.session);
    wrapper.start();
    otherWrapper.start();
    try {
      const events = [];
      const unsubscribe = wrapper.onEvent(event => events.push(event));
      const startEvent = { type: `${prefix}compaction_start`, reason: "manual" };
      fake.session.isCompacting = true;
      fake.emit(startEvent);
      const startedAt = Date.now();
      assert.equal(events.at(-1).compactionStartedAt, startedAt);
      assert.equal(startEvent.compactionStartedAt, undefined, "SDK event is not mutated");
      unsubscribe();
      t.mock.timers.tick(18_000);
      assert.equal((await wrapper.send({ type: "get_state" })).compactionStartedAt, startedAt);
      assert.equal((await otherWrapper.send({ type: "get_state" })).compactionStartedAt, null);
      // Switching tabs/reloading only creates a fresh subscriber, never a run.
      wrapper.onEvent(event => events.push(event));
      t.mock.timers.tick(12_000);
      fake.emit(startEvent);
      assert.equal(events.at(-1).compactionStartedAt, startedAt, "duplicate start must retain the origin");
      assert.equal((await wrapper.send({ type: "get_state" })).compactionStartedAt, startedAt);
      for (const ending of [{}, { aborted: true }, { errorMessage: "summary failed" }]) {
        fake.session.isCompacting = false;
        fake.emit({ type: `${prefix}compaction_end`, ...ending });
        assert.equal((await wrapper.send({ type: "get_state" })).compactionStartedAt, null);
        t.mock.timers.tick(1_000);
        fake.session.isCompacting = true;
        fake.emit(startEvent);
        assert.equal((await wrapper.send({ type: "get_state" })).compactionStartedAt, Date.now());
      }
    } finally {
      wrapper.destroy();
      otherWrapper.destroy();
    }
  }
});

test("a send receipt annotates the user object before SDK persistence and never the next user", async () => {
  const fake = createFakeSession("send-receipt");
  const wrapper = createWrapper(fake.session);
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
  const wrapper = createWrapper(fake.session, "normal");
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
  const wrapper = createWrapper(fake.session);
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

test("bash timing and last progress survive a detached view", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100_000 });
  const fake = createFakeSession("bash-status-clock");
  const finished = deferred();
  let pushChunk = () => {};
  fake.session.executeBash = async (_command, onChunk) => {
    fake.session.isBashRunning = true;
    pushChunk = onChunk;
    await finished.promise;
    fake.session.isBashRunning = false;
    return { output: "done", exitCode: 0 };
  };
  const wrapper = createWrapper(fake.session);
  wrapper.start();
  try {
    const pending = wrapper.send({ type: "bash", command: "sleep 30" });
    await new Promise((resolve) => setImmediate(resolve));
    const started = await wrapper.send({ type: "get_state" });
    assert.equal(started.runStartedAt, 100_000);
    assert.equal(started.statusPhaseKind, "bash");
    assert.equal(started.statusPhaseStartedAt, 100_000);
    t.mock.timers.tick(12_000);
    pushChunk("still running\n");
    fake.emit({ type: "bash_execution_update", delta: "still running" });
    const detached = await wrapper.send({ type: "get_state" });
    assert.equal(detached.statusPhaseStartedAt, 100_000, "SDK bash updates must not restart the timer");
    assert.equal(detached.lastProgressAt, 112_000);
    t.mock.timers.tick(8_000);
    wrapper.onEvent(() => {}); // A new view subscribes without starting a new run.
    const resumed = await wrapper.send({ type: "get_state" });
    assert.equal(resumed.statusPhaseStartedAt, 100_000);
    assert.equal(resumed.lastProgressAt, 112_000);
    finished.resolve();
    await pending;
    assert.equal((await wrapper.send({ type: "get_state" })).statusPhaseStartedAt, null);
  } finally { finished.resolve(); wrapper.destroy(); }
});

test("tool phase and progress clocks stay stable while parallel tools run", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 200_000 });
  const fake = createFakeSession("tool-status-clock");
  fake.session.isStreaming = true;
  const wrapper = createWrapper(fake.session);
  wrapper.start();
  try {
    fake.emit({ type: "agent_start" });
    t.mock.timers.tick(5_000);
    fake.emit({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: {} });
    const toolsStartedAt = Date.now();
    t.mock.timers.tick(4_000);
    fake.emit({ type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: {} });
    let state = await wrapper.send({ type: "get_state" });
    assert.equal(state.statusPhaseKind, "running_tools");
    assert.equal(state.statusPhaseStartedAt, toolsStartedAt);
    assert.equal(state.lastProgressAt, Date.now());
    t.mock.timers.tick(6_000);
    fake.emit({ type: "tool_execution_end", toolCallId: "a" });
    state = await wrapper.send({ type: "get_state" });
    assert.equal(state.statusPhaseStartedAt, toolsStartedAt);
    t.mock.timers.tick(3_000);
    fake.emit({ type: "tool_execution_end", toolCallId: "b" });
    state = await wrapper.send({ type: "get_state" });
    assert.equal(state.statusPhaseKind, "waiting_model");
    assert.equal(state.statusPhaseStartedAt, Date.now());
  } finally { wrapper.destroy(); }
});

test("assistant output phase keeps its start across status reads", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 300_000 });
  const fake = createFakeSession("assistant-status-clock");
  fake.session.isStreaming = true;
  const wrapper = createWrapper(fake.session);
  wrapper.start();
  try {
    fake.emit({ type: "agent_start" });
    t.mock.timers.tick(5_000);
    fake.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    const outputStartedAt = Date.now();
    t.mock.timers.tick(7_000);
    fake.emit({ type: "message_update", message: { role: "assistant", content: [] } });
    const state = await wrapper.send({ type: "get_state" });
    assert.equal(state.statusPhaseKind, "agent");
    assert.equal(state.statusPhaseStartedAt, outputStartedAt);
    assert.equal(state.lastProgressAt, Date.now());
  } finally { wrapper.destroy(); }
});

test("file mutation shutdown retains write ownership until transport and extensions finish", async () => {
  const fake = createFakeSession("mutation-drain");
  const transport = deferred();
  const extensions = deferred();
  const order = [];
  fake.session.abort = async () => { await transport.promise; order.push("writer-finished"); };
  const owner = retainSessionFileOwnership("mutation-drain", fixtureAgentDir);
  fake.session.extensionRunner.emit = async () => { await extensions.promise; owner.assertOwned(); order.push("shutdown-finished"); };
  fake.session.dispose = () => order.push("disposed");
  const wrapper = createWrapper(fake.session, "normal", { ownedSessionManager: { ...owner, manager: fake.session.sessionManager } });
  const stopping = wrapper.shutdownForFileMutation().then(() => order.push("files-may-move"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, []);
  transport.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["writer-finished"]);
  owner.assertOwned();
  extensions.resolve();
  await stopping;
  assert.deepEqual(order, ["writer-finished", "shutdown-finished", "disposed", "files-may-move"]);
  assert.equal(wrapper.isAlive(), false);
  assert.throws(owner.assertOwned, /no longer active/);
  assert.throws(() => wrapper.persistSessionFile(), /no longer active/);
});

test("shutdown cancels extension startup questions and drains startup before releasing ownership", { timeout: 10_000 }, async t => {
  for (const mode of ["question", "pending-startup"]) await t.test(mode, async () => {
    const fake = createFakeSession(`shutdown-binding-${mode}`), entered = deferred(), resume = deferred();
    const owner = retainSessionFileOwnership(fake.session.sessionId, fixtureAgentDir);
    const order = [];
    fake.session.bindExtensions = async ({ uiContext }) => {
      entered.resolve();
      if (mode === "question") assert.equal(await uiContext.confirm("Startup", "Continue?"), false);
      else await resume.promise;
      owner.assertOwned(); order.push("startup-finished");
    };
    fake.session.extensionRunner.emit = async () => { owner.assertOwned(); order.push("shutdown-finished"); };
    const wrapper = createWrapper(fake.session, "normal", { ownedSessionManager: { ...owner, manager: fake.session.sessionManager } });
    wrapper.beginExtensionBinding(); await entered.promise;
    if (mode === "pending-startup") {
      wrapper.destroy();
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(order, []); owner.assertOwned();
      resume.resolve();
    }
    await wrapper.shutdownForFileMutation();
    assert.deepEqual(order, ["startup-finished", "shutdown-finished"]);
    assert.throws(owner.assertOwned, /no longer active/);
  });
});

test("extension-triggered models own a PromptRun before model execution and release it after settlement", async () => {
  const fake = createFakeSession("extension-command-model");
  let observedRun;
  let wrapper;
  fake.session.prompt = async (_text, options) => {
    options.preflightResult("started");
    observedRun = wrapper.getActivePromptRunId();
    await fake.promptFinished.promise;
  };
  wrapper = createWrapper(fake.session);
  wrapper.start();
  const events = [];
  wrapper.onEvent(event => events.push(event));
  const execution = wrapper.executeChatCommand("extension-command", "/custom");
  await waitForCondition(() => observedRun, "extension model run");
  assert.ok(observedRun);
  assert.equal(wrapper.getActivePromptRunId(), observedRun);
  fake.promptFinished.resolve();
  await execution;
  assert.equal(wrapper.getActivePromptRunId(), undefined);
  assert.ok(events.some(event => event.type === "prompt_started" && event.commandId === "extension-command" && event.runId === observedRun));
  assert.ok(events.some(event => event.type === "prompt_done" && event.runId === observedRun));
});

test("handled extension commands do not manufacture model runs or assistant completion events", async () => {
  const fake = createFakeSession("extension-command-pure");
  fake.session.prompt = async (_text, options) => { options.preflightResult("handled"); };
  const wrapper = createWrapper(fake.session);
  wrapper.start();
  const events = [];
  wrapper.onEvent(event => events.push(event));
  await wrapper.executeChatCommand("pure-command", "/custom");
  assert.equal(wrapper.getActivePromptRunId(), undefined);
  assert.equal(events.some(event => event.type === "prompt_started" || event.type === "prompt_done"), false);
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
        getSessionId: () => sessionId,
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

test("answer actions own a cancellable run and cannot accept concurrent chat work", async () => {
  const { writeToolPermission } = await jiti.import("./tool-permission-store.ts");
  const fake = createFakeSession("answer-action-cancel", ["read", "write"]), wrapper = createWrapper(fake.session);
  wrapper.start(); fake.session.setActiveToolsByName(["read", "write"]);
  writeToolPermission(wrapper.sessionId, "ask");
  const waiting = deferred(); let effects = 0;
  const execution = wrapper.executeAnswerAction("click", "Save the report", async run => {
    const assertAuthorized = await run.authorize({ name: "write", args: { path: "report.json" },
      evidence: async () => ({ fingerprint: "same", classification: { trustedTool: true, safeTarget: true }, context: { path: "report.json" } }),
      ask: async (_text, signal) => { waiting.resolve(); return new Promise(resolve => signal.addEventListener("abort", () => resolve("deny"), { once: true })); },
    });
    assertAuthorized(); effects++;
  });
  const rejected = assert.rejects(execution, /declined|cancelled/);
  await waiting.promise;
  assert.equal(wrapper.isRunning(), true);
  assert.equal(promptRuns.getActivePromptRun(wrapper.sessionId).source, "ui");
  for (const type of ["prompt", "steer", "follow_up", "bash"]) await assert.rejects(wrapper.send({ type, message: "Other work", command: "echo x" }), /answer action/);
  await assert.rejects(wrapper.executeAnswerAction("other", "Other action", async () => {}), /current task/);
  await wrapper.send({ type: "abort" }); await rejected;
  await waitForCondition(() => !wrapper.isRunning(), "action cancellation");
  assert.equal(effects, 0); assert.equal(promptRuns.getActivePromptRun(wrapper.sessionId), undefined);
  wrapper.destroy();
});

test("answer action grants are invalidated by permission changes and capability ceilings", async () => {
  const { writeToolPermission } = await jiti.import("./tool-permission-store.ts");
  const fake = createFakeSession("answer-action-permission", ["read", "write"]), wrapper = createWrapper(fake.session);
  wrapper.start(); fake.session.setActiveToolsByName(["read", "write"]);
  writeToolPermission(wrapper.sessionId, "full");
  let effects = 0;
  const operation = { name: "write", args: {}, evidence: async () => { throw new Error("full skips review"); }, ask: async () => "deny" };
  await assert.rejects(wrapper.executeAnswerAction("one", "Save", async run => {
    const grant = await run.authorize(operation); writeToolPermission(wrapper.sessionId, "ask"); grant(); effects++;
  }), /Permission changed/);
  assert.equal(wrapper.isRunning(), false);
  fake.session.setActiveToolsByName(["read"]);
  await assert.rejects(wrapper.executeAnswerAction("two", "Save", async run => { await run.authorize(operation); effects++; }), /file capability/);
  assert.equal(effects, 0); assert.equal(promptRuns.getActivePromptRun(wrapper.sessionId), undefined);
  wrapper.destroy();
});

test("runtime snapshots reuse the cached session title until a rename updates it", () => {
  const fake = createFakeSession("session-cached-title", [], "Initial title");
  const wrapper = createWrapper(fake.session);

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
  const wrapper = createWrapper(fake.session);
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
  const wrapper = createWrapper(fake.session);
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
  const fake = createFakeSession("session-capabilities", ["read", "browser", "custom_plan"]);
  const wrapper = createWrapper(fake.session);
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
    enabledCapabilityIds: ["tool:read", "tool:custom_plan"],
    expectedRevision: 1,
  });
  assert.deepEqual(fake.session.getActiveToolNames(), ["custom_plan", "read"]);
  assert.equal(fake.customEntries.at(-1).customType, "piora-session-capabilities");
  wrapper.destroy();
});

test("reused coding sessions activate collaboration only for a bound room prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "piora-reused-room-tools-"));
  const previous = process.env.PIORA_ROOMS_ROOT;
  process.env.PIORA_ROOMS_ROOT = root;
  const { createRoom } = await jiti.import("./room-store.ts");
  const room = createRoom({ name: "Reused", creator: { sessionId: "reused-room-session", role: "coordinator" } });
  const fake = createFakeSession("reused-room-session", ["read", "write", "piora_room"]);
  const wrapper = createWrapper(fake.session);
  wrapper.initializeSessionCapabilities(); wrapper.start();
  try {
    assert.ok(!fake.session.getActiveToolNames().includes("piora_room"));
    await wrapper.send({ type: "prompt", source: "room", roomContext: { roomId: room.id, messageId: "origin" }, message: "Collaborate" });
    await fake.promptStarted.promise;
    assert.ok(fake.session.getActiveToolNames().includes("piora_room"));
    assert.ok(fake.session.getActiveToolNames().includes("write"));
  } finally {
    fake.promptFinished.resolve(); wrapper.destroy();
    if (previous === undefined) delete process.env.PIORA_ROOMS_ROOT; else process.env.PIORA_ROOMS_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("project-managed room intake enables coordination without granting disabled workspace tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "piora-project-room-tools-"));
  const previous = process.env.PIORA_ROOMS_ROOT;
  process.env.PIORA_ROOMS_ROOT = root;
  const { createRoom } = await jiti.import("./room-store.ts");
  const room = createRoom({ name: "Project room", creator: { sessionId: "project-room-session", role: "coordinator" } });
  const fake = createFakeSession("project-room-session", ["read", "write", "piora_room"]);
  const wrapper = createWrapper(fake.session, "normal", { projectManaged: true, projectRoot: process.cwd() });
  wrapper.initializeSessionCapabilities(); wrapper.start();
  try {
    assert.equal(wrapper.isToolAllowedByCapability("piora_room"), false);
    wrapper.applyProjectCapabilitySettings({ projectRoot: process.cwd(), revision: 1, preset: "custom", enabledCapabilityIds: ["tool:read"], updatedAt: new Date().toISOString() });
    await assert.rejects(wrapper.send({ type: "set_team_tools", toolNames: ["read", "write"] }), /disabled by project settings/);
    assert.equal(wrapper.isToolAllowedByCapability("write"), false);
    await wrapper.send({ type: "prompt", source: "room", roomContext: { roomId: room.id, messageId: "origin" }, message: "Answer my question" });
    await fake.promptStarted.promise;
    assert.deepEqual(fake.session.getActiveToolNames().sort(), ["piora_room", "read"]);
    assert.equal(wrapper.isToolAllowedByCapability("piora_room"), true);
    assert.equal(wrapper.isToolAllowedByCapability("write"), false);
  } finally {
    fake.promptFinished.resolve(); wrapper.destroy();
    if (previous === undefined) delete process.env.PIORA_ROOMS_ROOT; else process.env.PIORA_ROOMS_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("project-managed tools replace idle sessions and reject per-session overrides", async (t) => {
  const fake = createFakeSession("project-tools-idle", ["read", "harmony_control"]);
  const wrapper = createWrapper(fake.session, "normal", {
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
  const wrapper = createWrapper(fake.session, "normal", { projectRoot: process.cwd() });
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
  await waitForCondition(() => fake.session.getActiveToolNames().length === 1, "deferred project tools");
  assert.deepEqual(fake.session.getActiveToolNames(), ["harmony_control"]);
  wrapper.destroy();
});

test("destroy aborts an active ordinary prompt without changing its tool selection", async () => {
  const fake = createFakeSession("session-destroy");
  const wrapper = createWrapper(fake.session);

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
  const wrapper = createWrapper(fake.session);
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
  const stopClock = await wrapper.send({ type: "get_state" });
  assert.equal(stopClock.statusPhaseKind, "stopping");
  assert.equal(typeof stopClock.statusPhaseStartedAt, "number");
  assert.deepEqual(await wrapper.send({ type: "abort" }), result, "a retried stop retains the unconsumed handoff");
  assert.equal((await wrapper.send({ type: "get_state" })).statusPhaseStartedAt, stopClock.statusPhaseStartedAt);
  assert.equal(queueClears, 1);
  const eventCount = events.length;
  fake.emit({ type: "agent_start" });
  assert.equal(events.length, eventCount, "late cancelled SDK events must not start a fresh stream");

  fake.promptFinished.resolve();
  await waitForCondition(() => events.some((event) => event.type === "prompt_done"), "aborted prompt completion");
  assert.equal(events.find(event => event.type === "prompt_done")?.aborted, true);
  assert.equal(wrapper.getRuntime(), "stopping");
  await assert.rejects(
    wrapper.send({ type: "prompt", message: "Do not overlap abort cleanup" }),
    /session is busy/,
  );

  abortFinished.resolve();
  await waitForCondition(() => wrapper.getRuntime() === "idle", "abort cleanup");
  assert.equal(wrapper.getRuntime(), "idle");
  assert.deepEqual(await wrapper.send({ type: "abort" }), result, "a lost response can be retried after cleanup too");
  await wrapper.send({ type: "prompt", message: "Resume the saved guidance" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await wrapper.send({ type: "abort" }), { accepted: true }, "the next run cannot replay an earlier handoff");
  wrapper.destroy();
});

test("extension restart destroys an idle wrapper so the next request rebuilds its load plan", async () => {
  const fake = createFakeSession("session-extension-restart");
  const wrapper = createWrapper(fake.session);
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
    options.preflightResult("started");
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
  const wrapper = createWrapper(fake.session);
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
    options.preflightResult("started");
    modelStarts += 1;
  };
  const wrapper = createWrapper(fake.session);
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
  await waitForCondition(() => wrapper.getRuntime() === "idle", "preflight cancellation cleanup");
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
  const wrapper = createWrapper(fake.session);
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
  const wrapper = createWrapper(fake.session);
  wrapper.start();
  fake.emit({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "private-path" } });
  fake.emit({ type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: { command: "private-command" } });
  assert.deepEqual((await wrapper.send({ type: "get_state" })).activeTools, [{ id: "a", name: "read" }, { id: "b", name: "bash" }]);
  fake.emit({ type: "tool_execution_end", toolCallId: "a", toolName: "read", result: { content: [] } });
  assert.deepEqual((await wrapper.send({ type: "get_state" })).activeTools, [{ id: "b", name: "bash" }]);
  wrapper.destroy();
});

const inputQuestions = [{ id: "choice", question: "Which approach?", kind: "text", required: true }];

test("question timeout continues the active prompt without any connected client", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  const { default: register } = await jiti.import("../extensions/piora-user-input.ts");
  let tool;
  register({ registerTool(value) { tool = value; } });
  const fake = createFakeSession("question-timeout-prompt");
  const wrapper = createWrapper(fake.session);
  const asked = deferred();
  const continued = deferred();
  let result;
  fake.session.prompt = async () => {
    const pending = tool.execute("question", { questions: inputQuestions }, undefined, undefined, { ui: wrapper.createExtensionUiContext() });
    asked.resolve();
    result = await pending;
    continued.resolve();
  };
  try {
    await wrapper.send({ type: "prompt", message: "Do the work" });
    await asked.promise;
    assert.equal(wrapper.getTaskRuntimeSnapshot().pendingApproval, true);
    t.mock.timers.tick(59_999);
    assert.equal(result, undefined);
    t.mock.timers.tick(1);
    await continued.promise;
    assert.deepEqual(result.details, { cancelled: true, reason: "timeout" });
    assert.equal(wrapper.getTaskRuntimeSnapshot().pendingApproval, false);
    assert.equal(wrapper.pendingUiRequests.size, 0);
    await waitForCondition(() => wrapper.getRuntime() === "idle", "question timeout prompt completion");
    assert.equal(wrapper.getRuntime(), "idle");
  } finally { wrapper.destroy(); }
});

test("question reconnect replays the original deadline and expiry closes every listener", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  const wrapper = createWrapper(createFakeSession("question-reconnect").session);
  const first = [], second = [];
  try {
    wrapper.onEvent(event => first.push(event));
    const result = wrapper.createExtensionUiContext().requestUserInput("Question", undefined, inputQuestions, { timeout: 120_000 });
    const request = first.find(event => event.method === "request_user_input");
    assert.equal(request.expiresAt, 121_000);
    t.mock.timers.tick(20_000);
    wrapper.onEvent(event => second.push(event));
    assert.deepEqual(second[0], request);
    t.mock.timers.tick(100_000);
    assert.deepEqual(await result, { cancelled: true, reason: "timeout" });
    for (const events of [first, second]) assert.equal(events.filter(event => event.method === "close" && event.id === request.id && event.reason === "timeout").length, 1);
    const late = []; wrapper.onEvent(event => late.push(event));
    assert.equal(late.length, 0, "expired requests must not be replayed");
  } finally { wrapper.destroy(); }
});

test("question submission and cancellation settle once and remove expiry timers", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  for (const response of [{ answers: { choice: ["A"] } }, { cancelled: true }]) {
    const wrapper = createWrapper(createFakeSession(`question-response-${"answers" in response}`).session);
    const events = []; wrapper.onEvent(event => events.push(event));
    try {
      const result = wrapper.createExtensionUiContext().requestUserInput("Question", undefined, inputQuestions);
      const request = events.find(event => event.method === "request_user_input");
      await wrapper.send({ type: "extension_ui_response", id: request.id, ...response });
      await wrapper.send({ type: "extension_ui_response", id: request.id, answers: { choice: ["duplicate"] } });
      assert.deepEqual(await result, response);
      t.mock.timers.tick(60_000);
      assert.equal(events.filter(event => event.method === "close").length, 1);
      assert.equal(events.find(event => event.method === "close").reason, "answers" in response ? "answered" : "cancelled");
      assert.equal(wrapper.getTaskRuntimeSnapshot().pendingApproval, false);
    } finally { wrapper.destroy(); }
  }
});

test("question rejects an expired answer even before its delayed timer fires", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  const wrapper = createWrapper(createFakeSession("question-late-answer").session);
  const events = []; wrapper.onEvent(event => events.push(event));
  try {
    const result = wrapper.createExtensionUiContext().requestUserInput("Question", undefined, inputQuestions);
    const request = events.find(event => event.method === "request_user_input");
    t.mock.timers.setTime(request.expiresAt);
    await wrapper.send({ type: "extension_ui_response", id: request.id, answers: { choice: ["late"] } });
    assert.deepEqual(await result, { cancelled: true, reason: "timeout" });
    t.mock.timers.tick(60_000);
    assert.equal(events.filter(event => event.method === "close").length, 1);
  } finally { wrapper.destroy(); }
});

test("question abort and wrapper destruction cancel rather than time out", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  for (const mode of ["abort", "destroy", "already-aborted"]) {
    const wrapper = createWrapper(createFakeSession(`question-${mode}`).session);
    const events = []; wrapper.onEvent(event => events.push(event));
    const controller = new AbortController();
    try {
      if (mode === "already-aborted") controller.abort();
      const result = wrapper.createExtensionUiContext().requestUserInput("Question", undefined, inputQuestions, { signal: controller.signal });
      if (mode === "destroy") wrapper.destroy(); else controller.abort();
      assert.deepEqual(await result, { cancelled: true });
      t.mock.timers.tick(60_000);
      assert.equal(events.some(event => event.reason === "timeout"), false);
      assert.equal(wrapper.pendingUiResponses.size, 0);
    } finally { wrapper.destroy(); }
  }
});

test("legacy confirmation timeout dismisses without granting consent", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  const wrapper = createWrapper(createFakeSession("question-confirm").session);
  const events = []; wrapper.onEvent(event => events.push(event));
  try {
    const bounded = wrapper.createExtensionUiContext().confirm("Confirm", "Proceed?", { timeout: 5_000 });
    t.mock.timers.tick(5_000);
    assert.equal(await bounded, false);
    assert.equal(events.filter(event => event.method === "close" && event.reason === "timeout").length, 1);
    const manual = wrapper.createExtensionUiContext().confirm("Confirm", "Proceed?");
    t.mock.timers.tick(60_000);
    assert.equal(wrapper.pendingUiResponses.size, 1, "legacy confirmations without a timeout retain their existing policy");
    wrapper.destroy();
    assert.equal(await manual, false);
  } finally { wrapper.destroy(); }
});

test("system prompt changes reload idle sessions and defer busy sessions without aborting them", async () => {
  const idle = createFakeSession("session-system-prompt-idle");
  const idleWrapper = createWrapper(idle.session);
  const idleEvents = [];
  idleWrapper.onEvent((event) => idleEvents.push(event));

  assert.equal(await idleWrapper.requestSystemPromptReload(), "reloaded");
  assert.equal(idle.reloadCount, 1);
  assert.equal(idle.session.agent.state.systemPrompt, "Updated instructions");
  assert.ok(idleEvents.some((event) => event.type === "system_prompt_reloaded"));
  idleWrapper.destroy();

  const busy = createFakeSession("session-system-prompt-busy");
  const busyWrapper = createWrapper(busy.session);
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

test("image prompts, steering and follow-ups fail explicitly for a text-only model",async()=>{
 const fake=createFakeSession("text-only-images");fake.session.model={input:["text"]};const wrapper=createWrapper(fake.session);
  try{for(const input of [["text"],undefined]){fake.session.model={input};for(const type of ["prompt","steer","follow_up"])await assert.rejects(wrapper.send({type,message:"image",images:[{type:"image",mimeType:"image/png",data:"eA=="}]}),/image|图片/i);}}
 finally{fake.promptFinished.resolve();wrapper.destroy();}
});

test("remote frames follow logical prompt identity before SDK start and after completion",async()=>{
  const fake=createFakeSession("remote-frame-identity");const finishes=[];
  fake.session.prompt=()=>{const finish=deferred();finishes.push(finish);return finish.promise;};
  const wrapper=createWrapper(fake.session);wrapper.start();
  try {
    await wrapper.send({type:"prompt",message:"first"});const first=wrapper.getRemoteContentSnapshot();assert.equal(first.running,true);assert.ok(first.runId);assert.ok(first.streamId);
    fake.emit({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"first answer"}]}});fake.emit({type:"agent_start"});assert.equal(wrapper.getRemoteContentSnapshot().text,"first answer");
    await waitForCondition(() => finishes.length > 0, "first remote prompt start");
    finishes[0].resolve();await waitForCondition(() => wrapper.getRemoteContentSnapshot().runId === null, "first remote prompt completion");const idle=wrapper.getRemoteContentSnapshot();assert.equal(idle.runId,null);assert.equal(idle.text,"");assert.equal(idle.running,false);
    await wrapper.send({type:"prompt",message:"second"});const second=wrapper.getRemoteContentSnapshot();assert.notEqual(second.runId,first.runId);assert.equal(second.streamId,first.streamId);assert.ok(second.sequence>idle.sequence);assert.equal(second.text,"");
  }finally{for(const finish of finishes)finish.resolve();wrapper.destroy();}
});
