import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url);
const { answerOutputExportAppendix, copyAnswerOutputState } = await jiti.import("./answer-output-server.ts");
const { getSurfaceState, saveSurfaceState, hasIntelligentUiState } = await jiti.import("./intelligent-ui/store.ts");
const { persistLazySessionManager } = await jiti.import("./session-persistence.ts");
const { retainSessionFileOwnership, sessionOwnershipPath } = await jiti.import("./session-file-ownership.ts");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "piora-answer-export-")), previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const manager = SessionManager.create(root, join(root, "sessions")), sessionId = manager.getSessionId();
  t.after(() => {
    globalThis.__piSessions?.delete(sessionId);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const userId = manager.appendMessage({ role: "user", content: "Shopping list", timestamp: 1 });
  manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "ui-call", name: "piora_render_ui", arguments: {} }], timestamp: 2 });
  const surface = { id: "shopping", title: "<script>alert('x')</script> & \"shopping\"", version: 1, revision: 1, nodes: [
    { id: "people", type: "slider", label: "People", value: 2, min: 1, max: 20 },
    { id: "bread", type: "metric", label: "Bread", value: { op: "multiply", args: [{ ref: "people" }, 2] } },
    { id: "literal", type: "text", text: "</pre><img src=x onerror=alert(1)>" },
  ] };
  manager.appendMessage({ role: "toolResult", toolCallId: "ui-call", toolName: "piora_render_ui", content: [{ type: "text", text: "People: 2; Bread: 4" }], details: { answerOutput: { kind: "intelligent-ui", version: 1, snapshot: "People: 2; Bread: 4", payload: surface } }, timestamp: 3 });
  persistLazySessionManager(manager);
  const save = (people, expectedRevision = 0, target = sessionId) => saveSurfaceState({ sessionId: target, toolCallId: "ui-call", leafId: manager.getLeafId(), expectedRevision, state: { people }, branch: () => manager.getBranch(), allEntries: () => manager.getEntries(), enabled: () => true });
  return { root, manager, sessionId, userId, save };
}

test("ordinary output without saved state returns no appendix and does not create a session", async t => {
  const { root, sessionId } = fixture(t);
  assert.equal(hasIntelligentUiState(sessionId), false);
  const sessionsBefore = new Set(globalThis.__piSessions?.keys() ?? []);
  // A nonexistent path makes accidental session loading observable.
  assert.equal(await answerOutputExportAppendix(sessionId, join(root, "missing-session.jsonl")), "");
  await copyAnswerOutputState(sessionId, "no-output-copy", []);
  assert.equal(hasIntelligentUiState("no-output-copy"), false);
  assert.deepEqual(new Set(globalThis.__piSessions?.keys() ?? []), sessionsBefore);
});

test("copy rechecks ownership after loading its adapter and preserves state when the lease is lost", async t => {
  const { root, manager, sessionId, save } = fixture(t); await save(7);
  const owner = retainSessionFileOwnership(sessionId, root);
  try {
    const pending = copyAnswerOutputState(sessionId, "revoked-copy", manager.getBranch().map(entry => entry.id));
    const stale = new Date(Date.now() - 180_000);
    utimesSync(sessionOwnershipPath(sessionId, root), stale, stale);
    await assert.rejects(pending, error => error.code === "SESSION_IN_USE");
    assert.equal(hasIntelligentUiState("revoked-copy"), false);
    assert.equal(getSurfaceState(sessionId, manager.getBranch(), "ui-call").state.people, 7);
  } finally { owner.release(); }
});

test("export appendix uses saved current values and escapes every HTML injection boundary", async t => {
  const { manager, sessionId, save } = fixture(t);
  await save(7);
  const appendix = await answerOutputExportAppendix(sessionId, manager.getSessionFile());
  assert.match(appendix, /People: 7/);
  assert.match(appendix, /Bread: 14/);
  assert.doesNotMatch(appendix, /People: 2/);
  assert.match(appendix, /&lt;script&gt;alert\(&#39;x&#39;\)&lt;\/script&gt; &amp; &quot;shopping&quot;/);
  assert.match(appendix, /&lt;\/pre&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(appendix, /<script|<img/i);
  assert.match(appendix, /interactive controls require Piora/);
  assert.equal(globalThis.__piSessions?.has(sessionId) ?? false, false);
});

test("export follows the active live branch instead of a stale chronological disk leaf", async t => {
  const { manager, sessionId, userId, save } = fixture(t);
  await save(6);
  const uiLeaf = manager.getLeafId();
  globalThis.__piSessions ??= new Map();
  globalThis.__piSessions.set(sessionId, { isAlive: () => true, inner: { sessionManager: manager } });
  assert.match(await answerOutputExportAppendix(sessionId, manager.getSessionFile()), /People: 6/);
  manager.branch(userId);
  assert.equal(SessionManager.open(manager.getSessionFile()).getLeafId(), uiLeaf, "navigation has not rewritten disk history");
  assert.equal(await answerOutputExportAppendix(sessionId, manager.getSessionFile()), "", "UI from a different branch is excluded");
  manager.branch(uiLeaf);
  assert.match(await answerOutputExportAppendix(sessionId, manager.getSessionFile()), /Bread: 12/);
});

test("export reads a complete missing-LF snapshot without SDK disk repair", async t => {
  const { manager, sessionId, save } = fixture(t); await save(8);
  const path = manager.getSessionFile(); writeFileSync(path, readFileSync(path, "utf8").trimEnd());
  const bytes = readFileSync(path), mtime = statSync(path).mtimeMs;
  assert.match(await answerOutputExportAppendix(sessionId, path), /Bread: 16/);
  assert.deepEqual(readFileSync(path), bytes); assert.equal(statSync(path).mtimeMs, mtime);
  assert.equal(globalThis.__piSessions?.has(sessionId) ?? false, false);
});

test("generic copy adapter filters retained ancestry and keeps copied parameters independent", async t => {
  const { manager, sessionId, save } = fixture(t);
  const firstLeaf = manager.getLeafId(), firstBranch = manager.getBranch();
  await save(5);
  manager.appendMessage({ role: "user", content: "Continue original branch", timestamp: 4 });
  await save(9, 1);
  await copyAnswerOutputState(sessionId, "fork-before-continuation", firstBranch.map(entry => entry.id));
  assert.deepEqual(getSurfaceState("fork-before-continuation", firstBranch, "ui-call").state, { people: 5 });
  manager.branch(firstLeaf);
  await save(8, 1, "fork-before-continuation");
  assert.deepEqual(getSurfaceState(sessionId, firstBranch, "ui-call").state, { people: 5 });
  assert.deepEqual(getSurfaceState("fork-before-continuation", firstBranch, "ui-call").state, { people: 8 });
  await copyAnswerOutputState(sessionId, "fork-without-ui", [firstBranch[0].id]);
  assert.equal(hasIntelligentUiState("fork-without-ui"), false);
});
