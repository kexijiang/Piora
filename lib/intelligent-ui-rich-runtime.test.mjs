import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAgentSessionServices, createAgentSessionFromServices, SettingsManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { alias: { "@": resolve(import.meta.dirname, "..") } });
const { compileUiRichPlan } = await jiti.import("./intelligent-ui/rich-plan.ts");
const { compileUiPlan } = await jiti.import("./intelligent-ui/plan.ts");
const { UiGenerationPrototype, generationJournalPath, generationDigest } = await jiti.import("./intelligent-ui/generation-journal.ts");
const { bindUiGenerationRuntime } = await jiti.import("./intelligent-ui/generation-runtime.ts");
const { evaluateRichSurface } = await jiti.import("./intelligent-ui/rich-protocol.ts");
const { extractSurface } = await jiti.import("./intelligent-ui/protocol.ts");
const { formatUiDecisionContext } = await jiti.import("./intelligent-ui/decision-context.ts");
const { readUiOutput, readUiDecisionRecords, readUiSnapshots } = await jiti.import("./intelligent-ui/read-output.ts");
const { copyAnswerOutputState } = await jiti.import("./answer-output-server.ts");
const { createOwnedSessionManager } = await jiti.import("./session-owned-manager.ts");
const { readOnlySessionManager } = await jiti.import("./session-readonly-manager.ts");
const { persistLazySessionManager } = await jiti.import("./session-persistence.ts");
const { writeBetaFeatures } = await jiti.import("./beta-features.ts");
const { cacheSessionPath, invalidateSessionPathCache } = await jiti.import("./session-reader.ts");
const { GET, PUT } = await jiti.import("../app/api/sessions/[id]/intelligent-ui/route.ts");
const { GET: exportSession } = await jiti.import("../app/api/sessions/[id]/export/route.ts");
const register = (await jiti.import("../extensions/piora-intelligent-ui.ts")).default;
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const clone = value => JSON.parse(JSON.stringify(value));
const literal = value => ({ literal: value });

function richPlan() {
  return { planVersion: 2, id: "choices", title: "Compare travel choices", inputs: [
    { id: "quantity", label: "Travellers", valueType: "number", value: 2, min: 1, max: 10 },
    { id: "budget", label: "Budget", valueType: "number", value: 20, min: 0, max: 100 },
    { id: "category", label: "Category", valueType: "string", value: "All", options: ["All", "A", "B"] },
  ], derived: [
    { id: "alphaPrice", op: "multiply", args: [{ input: "quantity" }, literal(5)] },
    { id: "betaPrice", op: "multiply", args: [{ input: "quantity" }, literal(8)] },
    { id: "gammaPrice", op: "multiply", args: [{ input: "quantity" }, literal(12)] },
  ], views: [
    { id: "alpha", kind: "metric", label: "Alpha total", value: { derived: "alphaPrice" } },
    { id: "beta", kind: "metric", label: "Beta total", value: { derived: "betaPrice" } },
    { id: "prices", kind: "table", columns: ["Choice", "Category", "Price"], rows: [
      [literal("Alpha"), literal("A"), { derived: "alphaPrice" }],
      [literal("Beta"), literal("B"), { derived: "betaPrice" }],
      [literal("Gamma"), literal("A"), { derived: "gammaPrice" }],
    ] },
  ], layout: [
    { id: "inputs", type: "group", title: "Adjust your trip", columns: 3, nodeIds: ["quantity", "budget", "category"] },
    { id: "compare", type: "comparison", title: "Price comparison", cards: [
      { id: "alphaCard", title: "Alpha offer", nodeIds: ["alpha"] },
      { id: "betaCard", title: "Beta offer", nodeIds: ["beta"] },
    ] },
    { id: "matching", type: "filteredTable", title: "Matching trips", tableId: "prices", filters: [
      { column: 1, controlId: "category", operator: "equals", inactiveValue: "All" },
      { column: 2, controlId: "budget", operator: "lte" },
    ] },
  ] };
}
function flatPlan() { const value = richPlan(); delete value.layout; value.planVersion = 1; return value; }
const appendCall = (manager, id, arguments_, name = "piora_render_ui_plan") => manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: arguments_ }], stopReason: "toolUse", api: "openai-completions", provider: "fixture", model: "fixture", usage, timestamp: Date.now() });
const appendResult = (manager, id, details, name = "piora_render_ui_plan") => manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: name, isError: false, content: [{ type: "text", text: details.answerOutput.snapshot }], details, timestamp: Date.now() });

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "piora-rich-runtime-"));
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PIORA_UI_INPUT_PROTOCOL: process.env.PIORA_UI_INPUT_PROTOCOL };
  process.env.PI_CODING_AGENT_DIR = root; process.env.PIORA_UI_INPUT_PROTOCOL = "plan-2";
  writeBetaFeatures({ intelligentUi: true }, root);
  const owned = createOwnedSessionManager(root, join(root, "sessions"), root), manager = owned.manager;
  manager.appendMessage({ role: "user", content: "Compare and filter these supplied trips", timestamp: Date.now() });
  persistLazySessionManager(manager);
  const id = manager.getSessionId(), file = manager.getSessionFile(), ids = [id], runtimes = [];
  cacheSessionPath(id, file);
  const host = new UiGenerationPrototype({ manager, root });
  t.after(async () => {
    await Promise.all(runtimes.map(runtime => runtime.cancel().catch(() => {})));
    owned.release();
    for (const sessionId of ids) { invalidateSessionPathCache(sessionId); globalThis.__piSessions?.delete(sessionId); }
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const bind = runId => {
    const runtime = bindUiGenerationRuntime({ manager, root, identity: { sessionId: manager.getSessionId(), runId }, isActive: () => true, assertOwned: owned.assertOwned });
    runtimes.push(runtime); return runtime;
  };
  const get = async (toolCallId, sessionId = id) => {
    const response = await GET(new Request(`http://localhost/api/sessions/${sessionId}/intelligent-ui?${new URLSearchParams({ toolCallId })}`, { headers: { host: "localhost" } }), { params: Promise.resolve({ id: sessionId }) });
    return { status: response.status, body: await response.json() };
  };
  const put = async (toolCallId, saved, state, sessionId = id) => {
    const response = await PUT(new Request(`http://localhost/api/sessions/${sessionId}/intelligent-ui`, { method: "PUT", headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ toolCallId, leafId: saved.leafId, expectedRevision: saved.revision, state }) }), { params: Promise.resolve({ id: sessionId }) });
    return { status: response.status, body: await response.json() };
  };
  const fork = async () => {
    const source = manager.getSessionId(), sourceFile = manager.getSessionFile(), sourceLeafId = manager.getLeafId();
    const targetFile = manager.createBranchedSession(sourceLeafId), target = manager.getSessionId(); ids.push(target); cacheSessionPath(target, targetFile);
    await copyAnswerOutputState(source, target, manager.getBranch().map(entry => entry.id), { sourceFile, targetFile, sourceLeafId, root });
    return { id: target, file: targetFile, reader: readOnlySessionManager(targetFile) };
  };
  return { root, manager, owned, id, file, host, bind, get, put, fork,
    journal: () => JSON.parse(readFileSync(generationJournalPath(id, root), "utf8")),
    reader: () => readOnlySessionManager(file),
  };
}
async function candidate(f, id = "rich", value = richPlan()) {
  const context = await f.host.captureContext(value.id);
  const revision = context.source.surfaceRevision + 1;
  const messageEntryId = appendCall(f.manager, id, value);
  const compiled = value.planVersion === 2 ? compileUiRichPlan(value, { revision }) : compileUiPlan(value, { revision });
  const created = await f.host.createCandidate(context.contextId, id, compiled);
  const entryId = appendResult(f.manager, id, created.details);
  return { ...created, entryId, messageEntryId, receipt: { messageEntryId, toolResultEntryIds: [entryId] } };
}
async function publish(f, id = "rich", value = richPlan()) {
  const created = await candidate(f, id, value);
  await f.host.observePersistedCandidate(created.operationId, created.receipt);
  await f.host.commitCandidate(created.operationId); return created;
}
function ok(result, expected = 200) { assert.equal(result.status, expected, JSON.stringify(result.body)); return result.body; }

test("real plan-2 extension publishes exact SDK receipts; HTTP saves, resumed context, second fork and HTML retain rich filtered state", { timeout: 60_000 }, async t => {
  const f = fixture(t), runtime = f.bind("sdk-rich"), contexts = [], turns = [], early = [];
  let request = 0, session;
  const services = await createAgentSessionServices({ cwd: f.root, agentDir: f.root,
    settingsManager: SettingsManager.create(f.root, f.root, { projectTrusted: true }), resourceLoaderOptions: {
      additionalExtensionPaths: [resolve(import.meta.dirname, "../extensions/piora-intelligent-ui.ts")], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [api => {
        api.on("turn_end", event => { turns.push({ messageEntryId: event.messageEntryId, toolResultEntryIds: [...event.toolResultEntryIds] }); });
        api.registerProvider("rich-runtime-fixture", { api: "rich-runtime-api", apiKey: "fixture", baseUrl: "https://unused.invalid",
          models: [{ id: "test", name: "test", reasoning: false, input: ["text"], contextWindow: 20000, maxTokens: 200, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
          streamSimple(model, context) {
            contexts.push(JSON.stringify(context.messages));
            const content = request++ === 0 ? [{ type: "toolCall", id: "sdk-rich", name: "piora_render_ui_plan", arguments: richPlan() }] : [{ type: "text", text: "These are the acknowledged matching trips." }];
            const reason = content[0].type === "toolCall" ? "toolUse" : "stop";
            const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, timestamp: Date.now(), usage, stopReason: reason };
            const stream = createAssistantMessageEventStream();
            queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason, message }); }); return stream;
          },
        });
      }],
    } });
  try {
    ({ session } = await createAgentSessionFromServices({ services, sessionManager: f.manager, model: services.modelRuntime.getModel("rich-runtime-fixture", "test") }));
    session.setAutoRetryEnabled(false); session.setAutoCompactionEnabled(false); await session.bindExtensions({ mode: "rpc" });
    const tools = session.getAllTools().filter(tool => tool.name.startsWith("piora_render_ui"));
    assert.deepEqual(tools.map(tool => tool.name), ["piora_render_ui_plan"]);
    assert.equal(tools[0].parameters.properties.planVersion.const, 2);
    session.subscribe(event => {
      if (event.type === "tool_execution_end" && event.toolCallId === "sdk-rich") early.push(f.journal().records[0].status);
    });
    await session.prompt("Create the comparison and filters.");
    assert.deepEqual(early, ["candidate"]);
    const record = f.journal().records[0], toolTurn = turns.find(turn => turn.toolResultEntryIds.length);
    assert.equal(record.status, "committed"); assert.equal(record.planVersion, 2); assert.equal(record.surface.version, 2);
    assert.equal(record.callEntryId, toolTurn.messageEntryId);
    assert.deepEqual(record.turnReceipt.entryIds, toolTurn.toolResultEntryIds);
    assert.equal(record.receipt.entryId, toolTurn.toolResultEntryIds[0]);
    const diskEntries = readFileSync(f.file, "utf8").trimEnd().split("\n").map(JSON.parse);
    const diskResult = diskEntries.find(entry => entry.id === record.receipt.entryId);
    assert.equal(record.receipt.entryHash, generationDigest(diskResult));
    assert.deepEqual(diskResult.message.details.answerOutput.payload.layout, richPlan().layout);
    assert.equal(record.surfaceHash, generationDigest(compileUiRichPlan(richPlan(), { revision: 1 }).surface));
    const created = ok(await f.get("sdk-rich"));
    assert.deepEqual(evaluateRichSurface(created.surface, created.state).tableViews.matching.visibleRowIndices, [0, 1]);
    const bytes = readFileSync(f.file), state = { quantity: 4, budget: 50, category: "A" };
    const saved = ok(await f.put("sdk-rich", created, state));
    assert.ok(saved.revision > created.revision); assert.deepEqual(saved.state, state);
    assert.deepEqual(evaluateRichSurface(saved.surface, saved.state).tableViews.matching.visibleRowIndices, [0, 2]);
    assert.match(saved.snapshot, /\[shown\] Gamma \| A \| 48/); assert.match(saved.snapshot, /\[filtered\] Beta \| B \| 32/);
    assert.deepEqual(readFileSync(f.file), bytes, "parameter saves leave the original tool result immutable");
    await session.prompt("Explain my current filtered choices without replacing them.");
    assert.match(contexts.at(-1), /Travellers: 4/); assert.match(contexts.at(-1), /\[shown\] Gamma/);
    assert.equal(f.journal().records.length, 1);
  } finally { await runtime.cancel(); await session?.abort(); session?.dispose(); }
  const restored = await readUiOutput(f.reader(), "sdk-rich", { root: f.root });
  const frozen = await readUiDecisionRecords(f.reader(), f.root);
  assert.deepEqual(frozen.records[0].surface.layout, richPlan().layout);
  assert.match(formatUiDecisionContext(frozen.records, frozen.leafId), /Price comparison/);
  assert.match((await readUiSnapshots(f.reader(), f.root))[0], /Rows shown: 2\/3/);
  const sourceBytes = readFileSync(f.file), sourceJournal = readFileSync(generationJournalPath(f.id, f.root));
  for (let generation = 1; generation <= 2; generation++) {
    const child = await f.fork(), output = await readUiOutput(child.reader, "sdk-rich", { root: f.root });
    assert.deepEqual(output.surface, restored.surface); assert.deepEqual(output.state, restored.state);
    const copied = JSON.parse(readFileSync(generationJournalPath(child.id, f.root), "utf8")).records[0];
    const original = JSON.parse(sourceJournal).records[0];
    assert.deepEqual(copied.receipt, original.receipt); assert.equal(copied.surfaceHash, original.surfaceHash);
    const response = await exportSession(new Request(`http://localhost/api/sessions/${child.id}/export`), { params: Promise.resolve({ id: child.id }) });
    const html = await response.text(); assert.equal(response.status, 200, html);
    assert.match(html, /Adjust your trip/); assert.match(html, /Alpha offer/);
    assert.match(html, /\[shown\] Gamma \| A \| 48/); assert.match(html, /\[filtered\] Beta \| B \| 32/);
  }
  assert.deepEqual(readFileSync(f.file), sourceBytes); assert.deepEqual(readFileSync(generationJournalPath(f.id, f.root)), sourceJournal);
});

test("rich candidates require exact disk evidence and remain read-only after cancellation, reload and copy", async t => {
  const f = fixture(t); await f.host.startRun(); const created = await candidate(f);
  await assert.rejects(f.host.observePersistedCandidate(created.operationId, { messageEntryId: created.messageEntryId, toolResultEntryIds: [] }), error => error.code === "RECEIPT");
  assert.equal(f.journal().records[0].receipt, undefined);
  const preview = ok(await f.get("rich")); assert.equal(preview.publication.status, "candidate");
  ok(await f.put("rich", preview, { ...preview.state, budget: 50 }), 409);
  await f.host.observePersistedCandidate(created.operationId, created.receipt);
  await f.host.cancelRun();
  await assert.rejects(f.host.commitCandidate(created.operationId), error => error.code === "CANCELLED");
  const cancelled = ok(await f.get("rich")); assert.equal(cancelled.publication.status, "aborted");
  ok(await f.put("rich", cancelled, { ...cancelled.state, budget: 50 }), 409);
  const before = readFileSync(generationJournalPath(f.id, f.root));
  assert.equal((await readUiOutput(f.reader(), "rich", { root: f.root })).surface.version, 2);
  assert.deepEqual(await readUiSnapshots(f.reader(), f.root), []);
  assert.deepEqual(readFileSync(generationJournalPath(f.id, f.root)), before, "reads never promote or rewrite cancelled work");
  const child = await f.fork(), inherited = await readUiOutput(child.reader, "rich", { root: f.root });
  assert.equal(inherited.publication.status, "aborted"); assert.deepEqual(inherited.surface, cancelled.surface);
  assert.deepEqual(await readUiSnapshots(child.reader, f.root), []);
  const targetJournal = JSON.parse(readFileSync(generationJournalPath(child.id, f.root), "utf8"));
  assert.deepEqual(targetJournal.records, []); assert.deepEqual(targetJournal.excludedOutputs[0].receipt, f.journal().records[0].receipt);
});

test("envelope1 stays strictly Surface1; Plan1 upgrades preserve controls and cannot downgrade a rich saved layout", async t => {
  const f = fixture(t), flat = compileUiPlan(flatPlan(), { revision: 1 }).surface;
  const legacyDetails = { answerOutput: { kind: "intelligent-ui", version: 1, snapshot: "Legacy", payload: flat } };
  assert.deepEqual(extractSurface(legacyDetails), flat);
  assert.equal(extractSurface({ answerOutput: { ...legacyDetails.answerOutput, payload: compileUiRichPlan(richPlan(), { revision: 1 }).surface } }), null);
  assert.equal(extractSurface({ answerOutput: { ...legacyDetails.answerOutput, payload: { ...flat, layout: richPlan().layout } } }), null);
  appendCall(f.manager, "legacy", {}, "piora_render_ui"); appendResult(f.manager, "legacy", legacyDetails, "piora_render_ui");
  const legacy = ok(await f.get("legacy")), state = { quantity: 4, budget: 50, category: "A" };
  ok(await f.put("legacy", legacy, state));
  await f.host.startRun(); await publish(f, "flat", flatPlan());
  assert.deepEqual(ok(await f.get("flat")).state, state, "Plan1 publication retains legacy acknowledged inputs");
  const rich = await publish(f, "upgrade");
  assert.deepEqual(ok(await f.get("upgrade")).state, state, "rich layout adds no implicit control reset");
  const captured = await f.host.captureContext("choices"), before = readFileSync(generationJournalPath(f.id, f.root));
  appendCall(f.manager, "downgrade", flatPlan());
  await assert.rejects(f.host.createCandidate(captured.contextId, "downgrade", compileUiPlan(flatPlan(), { revision: 4 })), error => error.code === "UI_PROTOCOL_UNAVAILABLE");
  assert.deepEqual(readFileSync(generationJournalPath(f.id, f.root)), before);
  assert.equal((await f.host.readActive("choices")).operationId, rich.operationId);
  process.env.PIORA_UI_INPUT_PROTOCOL = "surface";
  const tools = []; register({ registerTool: tool => tools.push(tool), on() {} });
  const result = await tools[0].execute("legacy-downgrade", { id: flat.id, title: flat.title, nodes: flat.nodes }, undefined, undefined, { sessionManager: f.manager });
  assert.equal(result.details.intelligentUiDiagnostic.code, "UI_PROTOCOL_UNAVAILABLE");
  assert.equal(result.details.intelligentUiDiagnostic.repairable, false);
  assert.deepEqual((await f.host.readActive("choices")).state, state);
});

test("the host-selected Plan1 contract rejects Plan2 and corrupted compiler metadata never downgrades persisted rich data", async t => {
  const f = fixture(t), runtime = f.bind("contract"); await runtime.captureContext();
  appendCall(f.manager, "wrong-contract", richPlan());
  const rejected = await runtime.executePlan("wrong-contract", richPlan(), undefined, 1);
  assert.equal(rejected.isError, true); assert.match(rejected.details.intelligentUiDiagnostic.code, /^PLAN_/);
  assert.equal(f.journal().records.length, 0);
  await runtime.cancel(); await f.host.startRun(); await publish(f);
  const journalPath = generationJournalPath(f.id, f.root), original = readFileSync(journalPath), damaged = clone(JSON.parse(original));
  damaged.records[0].planVersion = 1; writeFileSync(journalPath, JSON.stringify(damaged));
  await assert.rejects(readUiOutput(f.reader(), "rich", { root: f.root }), error => error.code === "CORRUPT");
  await assert.rejects(readUiSnapshots(f.reader(), f.root), error => error.code === "CORRUPT");
  assert.deepEqual(readFileSync(journalPath), Buffer.from(JSON.stringify(damaged)));
  writeFileSync(journalPath, original);
  assert.equal((await readUiOutput(f.reader(), "rich", { root: f.root })).surface.version, 2);
});
