import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";
import { Type, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { alias: { "@": resolve(import.meta.dirname, "..") } });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { writeBetaFeatures } = await jiti.import("./beta-features.ts");
const { writeModelFallbackConfig } = await jiti.import("./model-fallback-config.ts");
const { bindAnswerOutputAdmission } = await jiti.import("./answer-output-admission.ts");
const { resolveExtensionLoadPlan, applyExtensionLoadPlan, installExtensionLoadPlanReload } = await jiti.import("./extension-config.ts");
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const surface = () => ({ id: "calculator", title: "Calculator", nodes: [{ id: "n", type: "number", label: "Number", value: 2 }, { id: "total", type: "metric", label: "Double", value: { op: "multiply", args: [{ ref: "n" }, 2] } }] });
const tool = (id, args, name = "piora_render_ui") => ({ type: "toolCall", id, name, arguments: args });
async function until(predicate, label) {
  const deadline = performance.now() + 15_000;
  while (!predicate()) { assert.ok(performance.now() < deadline, `Timeout: ${label}`); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test("binding fails closed without the SDK patch and off-mode does not instantiate a feature budget", async () => {
  const options = { agent: {}, identity: { sessionId: "s", runId: "r" }, loadedTools: [], isActive: () => true, onRepeatedDenial() {} };
  const off = bindAnswerOutputAdmission(options);
  assert.equal(options.agent.admitToolCall, undefined);
  assert.equal(off.snapshot(), undefined);
  off.cancel();
  assert.throws(() => bindAnswerOutputAdmission({ ...options, loadedTools: [{ name: "piora_render_ui" }] }), /verified tool admission runtime/);
});

test("real wrapper binds one budget per run, including nested/command/steering paths and old tool contexts", { timeout: 90_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "piora-admission-runtime-"));
  const previous = process.env.PI_CODING_AGENT_DIR, previousProtocol = process.env.PIORA_UI_INPUT_PROTOCOL;
  const cwd = join(root, "workspace"), agentDir = join(root, "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PIORA_UI_INPUT_PROTOCOL = "surface"; // This suite exercises the legacy Surface tool explicitly.
  let wrapper, release, scenario = "text", index = 0, captured;
  const realNow = Date.now; let clockOffset = 0;
  t.mock.method(Date, "now", () => realNow() + clockOffset);
  const requests = [], events = [];
  try {
    await mkdir(cwd); await mkdir(agentDir);
    writeBetaFeatures({ intelligentUi: true }, agentDir);
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const discover = async () => {
      await settingsManager.reload();
      const plan = await resolveExtensionLoadPlan({ cwd, agentDir, settingsManager, profile: "normal", preferences: { version: 1, disabled: [] } });
      plan.enabledPaths = plan.candidates.filter(c => c.id === "piora:intelligent-ui" && c.enabled).map(c => c.path);
      return plan;
    };
    const plan = await discover();
    const services = await createAgentSessionServices({ cwd, agentDir, settingsManager, resourceLoaderOptions: {
      additionalExtensionPaths: plan.enabledPaths, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionsOverride: result => applyExtensionLoadPlan(result, plan),
      extensionFactories: [pi => {
        pi.registerCommand("admission-fixture", { handler: async () => pi.sendUserMessage("Fixture command") });
        pi.registerTool({ name: "admission_parent", label: "Parent", description: "Nested fixture", parameters: Type.Object({ capture: Type.Boolean() }),
          async execute(_id, params, _signal, _update, ctx) {
            if (params.capture) { captured = ctx; return { content: [{ type: "text", text: "captured" }] }; }
            return (await ctx.executeTool("piora_render_ui", {})).result;
          } });
        pi.registerProvider("admission-fixture", { api: "admission-fixture-api", apiKey: "test", baseUrl: "https://unused.invalid",
          models: ["test", "backup"].map(id => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 10000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
          streamSimple(model) {
            const n = index++; requests.push({ scenario, n, runId: wrapper.getActivePromptRunId(), hook: wrapper.inner.agent.admitToolCall });
            let content = [{ type: "text", text: "done" }];
            if (scenario === "repair" && n < 2) content = [tool(`repair-${n}`, n ? surface() : {})];
            if (scenario === "valid" && n === 0) content = [tool("valid", surface())];
            if (scenario === "exhaust" || scenario === "truncated") { assert.ok(n < 5); content = [tool(`exhaust-${n}`, {})]; }
            if (scenario === "nested" && n < 3) content = n === 0 ? [tool("direct-invalid", {})] : [tool(`parent-${n}`, { capture: false }, "admission_parent")];
            if (scenario === "capture" && n === 0) content = [tool("capture", { capture: true }, "admission_parent")];
            if (scenario === "deadline" && n < 2) { if (n === 1) clockOffset += 61_000; content = [tool(`deadline-${n}`, surface())]; }
            if (scenario === "fallback" && [0, 2, 3].includes(n)) content = [tool(`fallback-${n}`, n === 3 ? surface() : {})];
            const reason = scenario === "fallback" && n === 1 ? "error" : scenario === "truncated" ? "length" : content[0].type === "toolCall" ? "toolUse" : "stop";
            const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, timestamp: Date.now(), usage, stopReason: reason,
              ...(reason === "error" ? { errorMessage: "503 Service unavailable" } : {}) };
            const stream = createAssistantMessageEventStream();
            const emit = () => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason, message }); };
            if (scenario === "hold" && n === 0) release = emit; else queueMicrotask(emit);
            return stream;
          },
        });
      }],
    } });
    installExtensionLoadPlanReload(services.resourceLoader, plan, discover);
    const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.create(cwd, join(agentDir, "sessions")), model: services.modelRuntime.getModel("admission-fixture", "test") });
    session.setAutoRetryEnabled(false); session.setAutoCompactionEnabled(false);
    wrapper = new AgentSessionWrapper(session); wrapper.initializeSessionCapabilities(); wrapper.start(); wrapper.beginExtensionBinding(); await wrapper.waitUntilReady();
    wrapper.onEvent(event => events.push(event));
    const run = async (name, invoke = () => wrapper.send({ type: "prompt", message: name })) => {
      await until(() => !wrapper.isRunning() && !wrapper.getActivePromptRunId(), "idle");
      scenario = name; index = 0; const start = events.length;
      await invoke();
      await until(() => !wrapper.isRunning() && !wrapper.getActivePromptRunId(), `${name} complete`);
      return events.slice(start);
    };
    const repaired = await run("repair");
    const results = repaired.filter(e => e.type === "tool_execution_end" && e.toolName === "piora_render_ui");
    assert.deepEqual(results.map(r => r.isError), [true, false]);
    const repairRequests = requests.filter(r => r.scenario === "repair");
    assert.equal(new Set(repairRequests.map(r => r.hook)).size, 1);
    assert.equal(new Set(repairRequests.map(r => r.runId)).size, 1);
    await run("exhaust"); assert.equal(index, 4);
    await run("truncated"); assert.equal(index, 4);
    const deadline = await run("deadline");
    const deadlineResults = deadline.filter(e => e.type === "tool_execution_end" && e.toolName === "piora_render_ui");
    assert.deepEqual(deadlineResults.map(e => e.isError), [false, true]);
    assert.equal(deadlineResults[1].result.details.intelligentUiDiagnostic.code, "UI_DEADLINE_EXCEEDED");
    clockOffset = 0;
    writeModelFallbackConfig({ enabled: true }, agentDir);
    const fallback = await run("fallback");
    assert.ok(fallback.some(e => e.type === "model_fallback"));
    const fallbackResults = fallback.filter(e => e.type === "tool_execution_end" && e.toolName === "piora_render_ui");
    assert.equal(fallbackResults.length, 3);
    assert.ok(fallbackResults.every(e => e.isError));
    assert.equal(fallbackResults.at(-1).result.details.intelligentUiDiagnostic.code, "UI_CORRECTIONS_EXHAUSTED");
    writeModelFallbackConfig({ enabled: false }, agentDir);
    const fresh = await run("valid"); assert.ok(fresh.some(e => e.type === "tool_execution_end" && !e.isError));
    const nested = await run("nested");
    const nestedResults = nested.filter(e => e.type === "tool_execution_end" && e.toolName === "piora_render_ui");
    assert.equal(nestedResults.length, 3);
    assert.ok(nestedResults.every(e => e.isError));
    assert.equal(nestedResults.at(-1).result.details.intelligentUiDiagnostic.code, "UI_CORRECTIONS_EXHAUSTED");
    await run("capture"); assert.ok(captured);
    scenario = "hold"; index = 0;
    await wrapper.send({ type: "prompt", message: "held new run" });
    await until(() => !!release, "held provider");
    const newHook = session.agent.admitToolCall;
    const late = await captured.executeTool("piora_render_ui", surface(), { signal: new AbortController().signal });
    assert.equal(late.isError, true);
    assert.equal(late.result.details.intelligentUiDiagnostic.code, "UI_RUN_UNAVAILABLE");
    assert.equal(session.agent.admitToolCall, newHook);
    await wrapper.send({ type: "follow_up", message: "queued" });
    assert.equal(session.agent.admitToolCall, newHook, "queue cannot reset the active run budget");
    release(); release = undefined;
    await until(() => !wrapper.isRunning() && !wrapper.getActivePromptRunId(), "held run settle");
    await run("repair", () => wrapper.executeChatCommand("admission-command", "/admission-fixture"));
    await run("repair", () => wrapper.send({ type: "steer", message: "idle steering", inputMode: "text" }));
    writeBetaFeatures({ intelligentUi: false }, agentDir);
    await run("text");
    assert.equal(session.getAllTools().some(t => t.name === "piora_render_ui"), false);
    writeBetaFeatures({ intelligentUi: true }, agentDir);
    const enabled = await run("valid"); assert.ok(enabled.some(e => e.type === "tool_execution_end" && !e.isError));
    await wrapper.send({ type: "set_tool_permission", mode: "auto" });
    let approvalRequests = 0;
    const unsubscribe = wrapper.onEvent(event => {
      if (event.type === "extension_ui_request" && event.toolApproval === true) {
        approvalRequests++;
        queueMicrotask(() => { void wrapper.send({ type: "extension_ui_response", id: event.id, confirmed: false }); });
      }
    });
    const denied = await run("valid");
    unsubscribe();
    assert.ok(approvalRequests > 0);
    assert.equal(denied.some(e => e.type === "tool_execution_end" && e.toolName === "piora_render_ui" && !e.isError), false);
    await wrapper.send({ type: "set_tool_permission", mode: "full" });
    assert.equal(events.filter(e => e.type === "prompt_error").length, 0);
  } finally {
    release?.();
    if (wrapper) await wrapper.shutdownForFileMutation();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    if (previousProtocol === undefined) delete process.env.PIORA_UI_INPUT_PROTOCOL; else process.env.PIORA_UI_INPUT_PROTOCOL = previousProtocol;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
