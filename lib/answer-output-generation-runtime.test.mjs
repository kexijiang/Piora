import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAgentSessionServices, createAgentSessionFromServices, SettingsManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { alias: { "@": resolve(import.meta.dirname, "..") } });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { writeBetaFeatures } = await jiti.import("./beta-features.ts");
const { createOwnedSessionManager } = await jiti.import("./session-owned-manager.ts");
const { readOnlySessionManager } = await jiti.import("./session-readonly-manager.ts");
const { readUiOutput } = await jiti.import("./intelligent-ui/read-output.ts");
const { saveUiOutput } = await jiti.import("./intelligent-ui/write-output.ts");
const { generationJournalPath } = await jiti.import("./intelligent-ui/generation-journal.ts");
const { getAnswerOutputGeneration } = await jiti.import("./answer-output-generation.ts");
const { loadedBetaFeatureSignature } = await jiti.import("./beta-feature-types.ts");
const { resolveSessionPath } = await jiti.import("./session-reader.ts");
const { resolveExtensionLoadPlan, applyExtensionLoadPlan } = await jiti.import("./extension-config.ts");
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const plan = (id = "bill") => ({ planVersion: 1, id, title: "分账", inputs: [{ id: "people", valueType: "number", label: "人数", value: 4, min: 1, max: 20 }], derived: [{ id: "total", op: "multiply", args: [{ input: "people" }, { literal: 12 }] }], views: [{ id: "amount", kind: "metric", label: "总价", value: { derived: "total" } }] });
async function until(predicate, label) {
  const deadline = performance.now() + 20_000;
  while (!predicate()) { assert.ok(performance.now() < deadline, `Timeout: ${label}`); await new Promise(resolve => setTimeout(resolve, 10)); }
}

for (const planVersion of [1, 2]) test(`real wrapper and ${planVersion === 2 ? 'default Beta' : 'explicit Plan1'} extension publish, save, explain, revise and cancel using disk evidence`, { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "piora-generation-wrapper-"));
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PIORA_UI_INPUT_PROTOCOL: process.env.PIORA_UI_INPUT_PROTOCOL };
  const cwd = join(root, "workspace"), agentDir = join(root, "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  if (planVersion === 2) delete process.env.PIORA_UI_INPUT_PROTOCOL; else process.env.PIORA_UI_INPUT_PROTOCOL = 'plan-1';
  let wrapper, owned, releaseBoundary, boundaryWaiting = false, scenario = "create", index = 0;
  const events = [], requests = [], prepublication = [];
  try {
    await mkdir(cwd); await mkdir(agentDir);
    writeBetaFeatures({ intelligentUi: true }, agentDir);
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const loadPlan = await resolveExtensionLoadPlan({ cwd, agentDir, settingsManager, profile: "normal", preferences: { version: 1, disabled: [] } });
    loadPlan.enabledPaths = loadPlan.candidates.filter(c => c.id === "piora:intelligent-ui" && c.enabled).map(c => c.path);
    const services = await createAgentSessionServices({ cwd, agentDir, settingsManager, resourceLoaderOptions: {
      additionalExtensionPaths: loadPlan.enabledPaths, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionsOverride: result => applyExtensionLoadPlan(result, loadPlan),
      extensionFactories: [api => api.registerProvider("generation-wrapper-fixture", { api: "generation-wrapper-api", apiKey: "test", baseUrl: "https://unused.invalid",
        models: [{ id: "test", name: "test", reasoning: false, input: ["text"], contextWindow: 10000, maxTokens: 200, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        streamSimple(model, context) {
          const n = index++; requests.push({ scenario, n, context: JSON.stringify(context) });
          const runtime = getAnswerOutputGeneration(wrapper.inner.sessionManager);
          assert.ok(runtime, "the run binding is ready before the first model request");
          // The title provider can finish after UI context capture but before
          // this provider's assistant is persisted. Exercise the real SDK path.
          if (n === 0 && (scenario === "create" || scenario === "migration")) {
            wrapper.inner.sessionManager.appendSessionInfo(`Automatic title: ${scenario}`);
          }
          if (scenario === "cancel" && n === 0) {
            const original = runtime.onTurnEnd.bind(runtime);
            const gate = new Promise(resolve => { releaseBoundary = resolve; });
            runtime.onTurnEnd = async boundary => {
              if (boundary.toolResultEntryIds.length) { boundaryWaiting = true; await gate; }
              return original(boundary);
            };
          }
          let content = [{ type: "text", text: "done" }];
          if (scenario !== "explain" && (n === 0 || scenario === "repair" && n === 1)) {
            const args = plan(scenario === "repair" ? "repaired" : "bill");
            if (scenario === "update") args.views.push({ id: "note", kind: "text", text: "已增加说明" });
            if (scenario === "migration") args.inputs[0].min = 2;
            if (planVersion === 2) {
              args.planVersion = 2;
              args.views.push({ id: "summary", kind: "dynamicText", parts: ["Current people: ", { input: "people" }, "; total: ", { derived: "total" }] });
              args.layout = [{ id: "parameters", type: "group", title: "调整条件", columns: 1, nodeIds: args.inputs.map(input => input.id) },
                { id: "results", type: "group", title: "计算结果", columns: 2, nodeIds: args.views.map(view => view.id) }];
            }
            if (scenario === "repair" && n === 0) args.derived[0].args = [{ input: "missing" }, { literal: 12 }];
            content = [{ type: "toolCall", id: `${scenario}-${n}`, name: "piora_render_ui_plan", arguments: args }];
          }
          const reason = content[0].type === "toolCall" ? "toolUse" : "stop";
          const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, timestamp: Date.now(), usage, stopReason: reason };
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason, message }); });
          return stream;
        },
      })],
    } });
    owned = createOwnedSessionManager(cwd, join(agentDir, "sessions"), agentDir);
    const { session } = await createAgentSessionFromServices({ services, sessionManager: owned.manager, model: services.modelRuntime.getModel("generation-wrapper-fixture", "test") });
    session.setAutoRetryEnabled(false); session.setAutoCompactionEnabled(false);
    wrapper = new AgentSessionWrapper(session, "normal", { ownedSessionManager: owned });
    wrapper.initializeSessionCapabilities(); wrapper.start(); wrapper.beginExtensionBinding(); await wrapper.waitUntilReady();
    const id = session.sessionId, file = session.sessionFile;
    const journalPath = generationJournalPath(id, agentDir);
    const readJournal = () => JSON.parse(readFileSync(journalPath, "utf8"));
    const readManager = () => readOnlySessionManager(file, { expectedSessionId: id, leafId: session.sessionManager.getLeafId() });
    const read = toolCallId => readUiOutput(readManager(), toolCallId, { root: agentDir });
    const tools = session.getAllTools();
    assert.ok(tools.some(tool => tool.name === "piora_render_ui_plan"));
    assert.equal(tools.some(tool => tool.name === "piora_render_ui"), false);
    assert.equal(loadedBetaFeatureSignature(tools), "intelligentUi:true");
    wrapper.onEvent(event => {
      events.push(event);
      if (event.type === "tool_execution_end" && event.toolName === "piora_render_ui_plan" && !event.isError) {
        prepublication.push(readJournal().records.find(record => record.toolCallId === event.toolCallId)?.status);
      }
    });
    const run = async name => {
      await until(() => !wrapper.isRunning() && !wrapper.getActivePromptRunId(), "idle before request");
      scenario = name; index = 0;
      await wrapper.send({ type: "prompt", message: name });
      await until(() => !wrapper.isRunning() && !wrapper.getActivePromptRunId(), `${name} finished`);
    };
    await run("create");
    assert.deepEqual(prepublication, ["candidate"], "a tool result is not yet a publication receipt");
    const created = await read("create-0");
    assert.equal(created.publication.status, "committed");
    assert.equal(created.surface.revision, 1);
    assert.equal(created.surface.version, planVersion);
    if (planVersion === 2) assert.deepEqual(created.surface.layout.map(block => block.id), ["parameters", "results"]);
    assert.match(requests.find(request => request.scenario === "create" && request.n === 1).context, /committed/);
    const saved = await saveUiOutput({ sessionId: id, toolCallId: "create-0", leafId: created.leafId, expectedRevision: created.revision,
      state: { people: 8 }, enabled: () => true, readManager, root: agentDir });
    assert.deepEqual(saved.state, { people: 8 });
    assert.match((await read("create-0")).snapshot, /96/);
    if (planVersion === 2) assert.match((await read("create-0")).snapshot, /Current people: 8; total: 96/);
    await run("explain");
    const explain = requests.find(request => request.scenario === "explain");
    assert.match(explain.context, /people[^\d]+8/);
    if (planVersion === 2) assert.match(explain.context, /Current people: 8; total: 96/);
    assert.equal(readJournal().records.length, 1, "text-only follow-up does not create a generation");
    await run("update");
    const updated = await read("update-0");
    assert.equal(updated.publication.status, "committed");
    assert.equal(updated.surface.revision, 2);
    assert.deepEqual(updated.state, { people: 8 }, "unchanged input meaning preserves acknowledged values");
    assert.equal((await read("create-0")).publication.status, "superseded");
    await run("repair");
    const repaired = events.filter(event => event.type === "tool_execution_end" && event.toolCallId?.startsWith("repair-"));
    assert.deepEqual(repaired.map(event => !!event.isError), [true, false]);
    assert.equal((await read("repair-1")).publication.status, "committed");
    scenario = "cancel"; index = 0;
    await wrapper.send({ type: "prompt", message: "cancel before publication" });
    await until(() => boundaryWaiting, "candidate awaiting publication");
    assert.equal(readJournal().records.find(record => record.toolCallId === "cancel-0").status, "candidate");
    const aborting = wrapper.send({ type: "abort" });
    await until(() => !wrapper.getActivePromptRunId(), "run revoked");
    releaseBoundary(); releaseBoundary = undefined;
    await aborting;
    await until(() => !wrapper.isRunning(), "cancelled task settled");
    assert.equal((await read("cancel-0")).publication.status, "aborted");
    assert.equal((await read("update-0")).publication.status, "committed");
    assert.equal(getAnswerOutputGeneration(session.sessionManager), undefined);
    await run("migration");
    assert.equal((await read("migration-0")).publication.status, "awaiting_confirmation");
    assert.equal(readJournal().records.find(record => record.toolCallId === "migration-0").migration.status, "ready", "normal wrapper cleanup seals a proposal after revoking generation");
    assert.equal((await read("update-0")).publication.status, "committed");
    const migrationContext = requests.find(request => request.scenario === "migration" && request.n === 1).context;
    assert.match(migrationContext, /awaiting_confirmation/);
    assert.match(migrationContext, /people[^\d]+8/);
    assert.equal(getAnswerOutputGeneration(session.sessionManager), undefined);
    await run("explain");
    const forkPoint = session.sessionManager.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "user");
    const forked = await wrapper.send({ type: "fork", entryId: forkPoint.id });
    assert.equal(forked.cancelled, false);
    const childFile = await resolveSessionPath(forked.newSessionId);
    assert.ok(childFile && !childFile.includes("session-forks"), "only the completed published path is discoverable");
    const child = readOnlySessionManager(childFile, { expectedSessionId: forked.newSessionId });
    assert.equal(child.getHeader().parentSession, file);
    assert.deepEqual((await readUiOutput(child, "update-0", { root: agentDir })).state, { people: 8 });
    assert.deepEqual((await readUiOutput(child, "update-0", { root: agentDir })).surface, updated.surface, "actual fork preserves the complete versioned layout");
    if (planVersion === 2) assert.match((await readUiOutput(child, "update-0", { root: agentDir })).snapshot, /Current people: 8; total: 96/);
    assert.equal((await readUiOutput(child, "cancel-0", { root: agentDir })).publication.status, "aborted");
    assert.equal(events.filter(event => event.type === "prompt_error").length, 0);
    await wrapper.shutdownForFileMutation(); wrapper = undefined; owned = undefined;
    const restored = readOnlySessionManager(file, { expectedSessionId: id });
    assert.deepEqual((await readUiOutput(restored, "update-0", { root: agentDir })).state, { people: 8 });
    assert.deepEqual((await readUiOutput(restored, "update-0", { root: agentDir })).surface, updated.surface);
    assert.equal((await readUiOutput(restored, "cancel-0", { root: agentDir })).publication.status, "aborted");
    assert.ok(existsSync(file));
  } finally {
    releaseBoundary?.();
    if (wrapper) await wrapper.shutdownForFileMutation(); else owned?.release();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    const taskPath = resolve(root);
    assert.equal(taskPath.startsWith(`${resolve(tmpdir())}\\`) || taskPath.startsWith(`${resolve(tmpdir())}/`), true);
    await rm(taskPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
