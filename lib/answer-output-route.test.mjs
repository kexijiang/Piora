import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { alias: { "@": resolve(import.meta.dirname, "..") } });
const { cacheSessionPath, invalidateSessionPathCache } = await jiti.import("./session-reader.ts");
const { persistLazySessionManager } = await jiti.import("./session-persistence.ts");
const { saveSurfaceState } = await jiti.import("./intelligent-ui/store.ts");
const { writeBetaFeatures, readBetaFeatures } = await jiti.import("./beta-features.ts");
const { GET } = await jiti.import("../app/api/sessions/[id]/answer-output/route.ts");
const { GET: getInteractive } = await jiti.import("../app/api/sessions/[id]/intelligent-ui/route.ts");
const { UiGenerationPrototype, generationJournalPath } = await jiti.import("./intelligent-ui/generation-journal.ts");
const { compileUiPlan } = await jiti.import("./intelligent-ui/plan.ts");
const { answerOutputExportAppendix } = await jiti.import("./answer-output-server.ts");

test("disabled answer fallback reads current saved values without creating a runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "piora-output-snapshot-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const manager = SessionManager.create(root, join(root, "sessions"));
  const id = manager.getSessionId();
  const surface = { id: "shopping", title: "Shopping", version: 1, revision: 1, nodes: [
    { id: "people", type: "slider", label: "People", value: 2, min: 1, max: 20 },
    { id: "bread", type: "metric", label: "Bread", value: { op: "multiply", args: [{ ref: "people" }, 2] } },
  ] };
  try {
    const userId = manager.appendMessage({ role: "user", content: "Shopping quantities", timestamp: 1 });
    manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "ui-call", name: "piora_render_ui", arguments: {} }], timestamp: 2 });
    manager.appendMessage({ role: "toolResult", toolCallId: "ui-call", toolName: "piora_render_ui", content: [{ type: "text", text: "People: 2; Bread: 4" }], details: { answerOutput: { kind: "intelligent-ui", version: 1, snapshot: "People: 2; Bread: 4", payload: surface } }, timestamp: 3 });
    persistLazySessionManager(manager);
    const path = manager.getSessionFile(); cacheSessionPath(id, path);
    writeBetaFeatures({ intelligentUi: true }, root);
    await saveSurfaceState({ sessionId: id, toolCallId: "ui-call", leafId: manager.getLeafId(), expectedRevision: 0, state: { people: 7 }, branch: () => manager.getBranch(), enabled: () => true, root });
    writeBetaFeatures({ intelligentUi: false }, root);
    const query = toolCallId => new Request(`http://localhost/api/sessions/${id}/answer-output?kind=intelligent-ui&toolCallId=${toolCallId}`, { headers: { host: "localhost" } });
    const context = { params: Promise.resolve({ id }) };
    const response = await GET(query("ui-call"), context);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const body = await response.json();
    assert.deepEqual(Object.keys(body), ["snapshot"]);
    assert.match(body.snapshot, /People: 7/);
    assert.match(body.snapshot, /Bread: 14/);
    assert.equal(readBetaFeatures(root).intelligentUi, false);
    assert.equal(globalThis.__piSessions?.has(id) ?? false, false);
    assert.equal((await GET(query("another-call"), context)).status, 404);
    const crossSite = query("ui-call"); crossSite.headers.set("sec-fetch-site", "cross-site");
    assert.equal((await GET(crossSite, context)).status, 403);
    globalThis.__piSessions ??= new Map();
    globalThis.__piSessions.set(id, { isAlive: () => true, inner: { sessionManager: manager } });
    assert.equal((await GET(query("ui-call"), context)).status, 200, "live selected branch can read its saved output");
    manager.branch(userId);
    assert.equal((await GET(query("ui-call"), context)).status, 404, "snapshots do not cross the active branch boundary");
  } finally {
    globalThis.__piSessions?.delete(id);
    invalidateSessionPathCache(id);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    assert.equal(dirname(root), tmpdir());
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("version 2 API and disabled snapshot require journal receipts and never publish on read", async () => {
  const root = await mkdtemp(join(tmpdir(), "piora-generation-read-")), previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const manager = SessionManager.create(root, join(root, "sessions")), id = manager.getSessionId();
  const userId = manager.appendMessage({ role: "user", content: "Adjust the quantity", timestamp: 1 });
  const plan = { planVersion: 1, id: "bill", title: "<script>saved</script>", inputs: [{ id: "people", valueType: "number", label: "People", value: 4 }], derived: [], views: [{ id: "value", kind: "metric", label: "Value", value: { input: "people" } }] };
  const host = new UiGenerationPrototype({ manager, root });
  const params = { params: Promise.resolve({ id }) };
  const request = path => new Request(`http://localhost/api/sessions/${id}/${path}`, { headers: { host: "localhost" } });
  try {
    await host.startRun(); const context = await host.captureContext("bill");
    manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "generated", name: "piora_render_ui_plan", arguments: plan }], timestamp: 2 });
    const created = await host.createCandidate(context.contextId, "generated", compileUiPlan(plan, { revision: 1 }));
    await host.persistCandidate(created.operationId);
    cacheSessionPath(id, manager.getSessionFile());
    writeBetaFeatures({ intelligentUi: false }, root);
    const journalBefore = await readFile(generationJournalPath(id, root), "utf8");
    const previewResponse = await getInteractive(request("intelligent-ui?toolCallId=generated"), params);
    assert.equal(previewResponse.status, 200);
    assert.equal((await previewResponse.json()).publication.status, "candidate");
    assert.equal(await answerOutputExportAppendix(id, manager.getSessionFile()), "");
    assert.equal(await readFile(generationJournalPath(id, root), "utf8"), journalBefore);
    assert.equal(globalThis.__piSessions?.has(id) ?? false, false);
    const committed = await host.commitCandidate(created.operationId);
    await host.saveParameters(created.operationId, committed.stateRevision, { people: 9 });
    const saved = await getInteractive(request("intelligent-ui?toolCallId=generated"), params);
    const body = await saved.json();
    assert.equal(body.publication.status, "committed"); assert.deepEqual(body.state, { people: 9 });
    const fallback = await GET(request("answer-output?kind=intelligent-ui&toolCallId=generated"), params);
    assert.match((await fallback.json()).snapshot, /People: 9/);
    assert.equal(readBetaFeatures(root).intelligentUi, false);
    const appendix = await answerOutputExportAppendix(id, manager.getSessionFile());
    assert.match(appendix, /People: 9/); assert.match(appendix, /&lt;script&gt;/); assert.doesNotMatch(appendix, /<script>/);
    const otherBranch = await getInteractive(request(`intelligent-ui?toolCallId=generated&leafId=${userId}`), params);
    assert.equal(otherBranch.status, 404, JSON.stringify(await otherBranch.json()));
    await rm(generationJournalPath(id, root));
    assert.equal((await getInteractive(request("intelligent-ui?toolCallId=generated"), params)).status, 409);
    assert.equal((await GET(request("answer-output?kind=intelligent-ui&toolCallId=generated"), params)).status, 404);
    assert.equal(await answerOutputExportAppendix(id, manager.getSessionFile()), "", "without sidecar evidence the exporter adds no purported saved parameters; original transcript snapshots remain readable");
  } finally {
    invalidateSessionPathCache(id);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
