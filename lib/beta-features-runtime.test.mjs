import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createJiti } from "jiti";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { alias: { "@": resolve(import.meta.dirname, "..") } });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { writeBetaFeatures } = await jiti.import("./beta-features.ts");
const { resolveExtensionLoadPlan, applyExtensionLoadPlan, installExtensionLoadPlanReload } = await jiti.import("./extension-config.ts");
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
async function waitFor(predicate, label) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("existing AgentSessions apply beta tools and prompts only at the next run boundary", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "piora-beta-runtime-"));
  const prior = process.env.PI_CODING_AGENT_DIR, priorProtocol = process.env.PIORA_UI_INPUT_PROTOCOL;
  const cwd = join(root, "workspace"), agentDir = join(root, "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir; delete process.env.PIORA_UI_INPUT_PROTOCOL;
  let wrapper, release, holdNext = false;
  try {
    await mkdir(cwd); await mkdir(agentDir);
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const discover = async () => {
      await settingsManager.reload();
      const result = await resolveExtensionLoadPlan({ cwd, agentDir, settingsManager, profile: "normal", preferences: { version: 1, disabled: [] } });
      // Keep real beta discovery and its actual extension; unrelated desktop extensions are outside this fixture.
      result.enabledPaths = result.candidates.filter(candidate => candidate.id === "piora:intelligent-ui" && candidate.enabled).map(candidate => candidate.path);
      return result;
    };
    const plan = await discover();
    const requests = [], starts = [];
    const services = await createAgentSessionServices({ cwd, agentDir, settingsManager, resourceLoaderOptions: {
      additionalExtensionPaths: plan.enabledPaths, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionsOverride: result => applyExtensionLoadPlan(result, plan),
      extensionFactories: [pi => {
        pi.on("session_start", event => { starts.push(event.reason); });
        pi.registerCommand("beta-fixture-run", { handler: async () => { pi.sendUserMessage("Start model from extension command"); } });
        pi.registerProvider("beta-fixture", { api: "beta-fixture-api", apiKey: "test", baseUrl: "https://unused.invalid",
          models: [{ id: "test", name: "test", reasoning: false, input: ["text"], contextWindow: 10000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
          streamSimple(model, input) {
            const index = requests.length;
            requests.push({ tools: getCurrentTools(input.messages), systemPrompt: getCurrentSystemPrompt(input.messages) });
            const stream = createAssistantMessageEventStream();
            const emit = () => {
              const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "text", text: "done" }], timestamp: Date.now(), usage, stopReason: "stop" };
              stream.push({ type: "start", partial: message });
              stream.push({ type: "done", reason: "stop", message });
            };
            if (index === 1 || holdNext) { holdNext = false; release = emit; } else queueMicrotask(emit);
            return stream;
          },
        });
      }],
    } });
    installExtensionLoadPlanReload(services.resourceLoader, plan, discover);
    const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.create(cwd, join(agentDir, "sessions")), model: services.modelRuntime.getModel("beta-fixture", "test") });
    session.setAutoRetryEnabled(false); session.setAutoCompactionEnabled(false);
    wrapper = new AgentSessionWrapper(session);
    wrapper.initializeSessionCapabilities(); wrapper.start(); wrapper.beginExtensionBinding(); await wrapper.waitUntilReady();
    const events = []; wrapper.onEvent(event => events.push(event));
    const prompt = async (message, count) => {
      await wrapper.send({ type: "prompt", message });
      await waitFor(() => events.filter(event => event.type === "prompt_done").length === count, message);
    };
    await prompt("off", 1);
    assert.equal(session.getAllTools().some(tool => tool.name === "piora_render_ui_plan"), false);
    assert.doesNotMatch(JSON.stringify(requests[0]), /piora_render_ui/);
    writeBetaFeatures({ intelligentUi: true }, agentDir);
    await wrapper.send({ type: "prompt", message: "enabled active turn" });
    await waitFor(() => requests.length === 2, "enabled provider request");
    assert.ok(session.getActiveToolNames().includes("piora_render_ui_plan"));
    assert.match(JSON.stringify(requests[1].tools), /piora_render_ui/);
    assert.match(requests[1].systemPrompt, /Intelligent UI decision policy: intent-2/);
    const reloads = starts.filter(reason => reason === "reload").length;
    writeBetaFeatures({ intelligentUi: false }, agentDir);
    assert.ok(session.getActiveToolNames().includes("piora_render_ui_plan"), "active run retains its capability snapshot");
    assert.equal(starts.filter(reason => reason === "reload").length, reloads);
    release(); release = undefined;
    await waitFor(() => events.filter(event => event.type === "prompt_done").length === 2, "active turn settlement");
    await prompt("disabled next turn", 3);
    assert.equal(session.getAllTools().some(tool => tool.name === "piora_render_ui_plan"), false);
    assert.equal(session.getActiveToolNames().includes("piora_render_ui_plan"), false);
    assert.doesNotMatch(JSON.stringify(requests[2].tools), /piora_render_ui/);
    assert.doesNotMatch(requests[2].systemPrompt, /Intelligent UI decision policy/);
    writeBetaFeatures({ intelligentUi: true }, agentDir);
    await prompt("enabled again", 4);
    assert.ok(session.getActiveToolNames().includes("piora_render_ui_plan"));
    assert.match(JSON.stringify(requests[3].tools), /piora_render_ui/);
    assert.equal(events.some(event => event.type === "prompt_error" || event.type === "extension_error"), false);
    assert.equal(starts.filter(reason => reason === "reload").length, reloads + 2);

    const idleEntrypoints = [
      ["extension command", () => wrapper.executeChatCommand("beta-command", "/beta-fixture-run")],
      ["model command", () => wrapper.executeModelCommand("beta-model-command", "Model command", { delivery: "followUp" }, () => {})],
      ...["steer", "followUp"].map(streamingBehavior => [`prompt ${streamingBehavior}`, () => wrapper.send({ type: "prompt", message: `idle ${streamingBehavior}`, streamingBehavior })]),
      ...["steer", "follow_up"].flatMap(type => [
        [`literal ${type}`, () => wrapper.send({ type, message: `idle literal ${type}`, inputMode: "text" })],
        [`extension ${type}`, () => wrapper.send({ type, message: "/beta-fixture-run" })],
      ]),
    ];
    for (const [label, invoke] of idleEntrypoints) {
      for (const enabled of [false, true]) {
        await waitFor(() => !wrapper.isRunning() && !wrapper.getActivePromptRunId(), `${label} idle admission`);
        const count = requests.length;
        writeBetaFeatures({ intelligentUi: enabled }, agentDir);
        await invoke();
        await waitFor(() => requests.length === count + 1 && !wrapper.isRunning() && !wrapper.getActivePromptRunId(), `${label} settlement`);
        const request = requests[count];
        assert.equal(session.getActiveToolNames().includes("piora_render_ui_plan"), enabled, `${label}: active tools`);
        assert.equal(JSON.stringify(request.tools).includes("piora_render_ui_plan"), enabled, `${label}: model tools`);
        assert.equal(/Intelligent UI decision policy: intent-2/.test(request.systemPrompt), enabled, `${label}: model instructions`);
      }
    }
    const activeStart = requests.length;
    holdNext = true;
    await wrapper.send({ type: "prompt", message: "Hold the active capabilities while accepting queues" });
    await waitFor(() => requests.length === activeStart + 1, "held active request");
    const activeReloads = starts.filter(reason => reason === "reload").length;
    writeBetaFeatures({ intelligentUi: false }, agentDir);
    const modelCommand = wrapper.executeModelCommand("active-beta-command", "Queued model command", { delivery: "followUp" }, () => {});
    await waitFor(() => session.getFollowUpMessages().length === 1, "model command queued");
    await wrapper.send({ type: "prompt", message: "Queued streaming prompt", streamingBehavior: "followUp" });
    await wrapper.send({ type: "follow_up", message: "Queued direct follow-up" });
    await wrapper.send({ type: "steer", message: "duplicate guidance", commandId: "beta-pending-steer" });
    await wrapper.send({ type: "follow_up", message: "duplicate guidance", commandId: "beta-pending-follow-up" });
    let pendingInputs = wrapper.getPendingInputs();
    const pendingSteer = pendingInputs.find(item => item.commandId === "beta-pending-steer");
    const pendingFollowUp = pendingInputs.find(item => item.commandId === "beta-pending-follow-up");
    assert.equal(pendingSteer.kind, "steer");
    assert.equal(pendingFollowUp.kind, "followUp");
    assert.notEqual(pendingSteer.id, pendingFollowUp.id, "identical guidance retains independent runtime identities");
    for (const selected of [pendingSteer, pendingFollowUp]) {
      const recall = wrapper.prepareQueueRecall(selected.id);
      assert.equal(recall.messages.length, 1);
      assert.equal(recall.messages[0].commandId, selected.commandId);
      let persisted = false;
      recall.commit(() => { persisted = true; });
      assert.equal(persisted, true);
      await Promise.resolve();
      const remaining = pendingInputs.filter(item => item.id !== selected.id);
      assert.deepEqual(wrapper.getPendingInputs(), remaining, "single-input recall preserves all remaining IDs, kinds and order across a pending Beta toggle");
      const update = events.filter(event => event.type === "queue_update").at(-1);
      assert.deepEqual(update.pendingInputs, remaining, "queue events include the same complete identity snapshot");
      pendingInputs = remaining;
    }
    assert.equal(requests.length, activeStart + 1, "individual recall cannot start another model request");
    assert.equal(starts.filter(reason => reason === "reload").length, activeReloads, "admitting active queue entries never reloads the runtime");
    release(); release = undefined;
    await modelCommand;
    await waitFor(() => !wrapper.isRunning() && !wrapper.getActivePromptRunId(), "active queued turns settle");
    assert.ok(requests.length > activeStart + 1, "queued inputs reach a subsequent model request");
    for (const request of requests.slice(activeStart)) {
      assert.match(JSON.stringify(request.tools), /piora_render_ui/, "queued turns retain active run tools");
      assert.match(request.systemPrompt, /Intelligent UI decision policy: intent-2/, "queued turns retain active run instructions");
    }
    await wrapper.executeModelCommand("disabled-after-queue", "Apply disabled state on next idle command", { delivery: "followUp" }, () => {});
    assert.doesNotMatch(JSON.stringify(requests.at(-1).tools), /piora_render_ui/);
    assert.doesNotMatch(requests.at(-1).systemPrompt, /Intelligent UI decision policy/);
    assert.equal(events.some(event => event.type === "prompt_error" || event.type === "extension_error"), false);
  } finally {
    release?.();
    if (wrapper) await wrapper.shutdownForFileMutation();
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
    if (priorProtocol === undefined) delete process.env.PIORA_UI_INPUT_PROTOCOL; else process.env.PIORA_UI_INPUT_PROTOCOL = priorProtocol;
    assert.equal(dirname(root), tmpdir());
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
