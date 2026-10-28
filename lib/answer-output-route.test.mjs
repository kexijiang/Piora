import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
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
