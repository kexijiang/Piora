import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { alias: { "@": resolve(import.meta.dirname, "..") } });
const { UiGenerationPrototype, generationJournalPath } = await jiti.import("./intelligent-ui/generation-journal.ts");
const { compileUiPlan } = await jiti.import("./intelligent-ui/plan.ts");
const { formatSnapshot } = await jiti.import("./intelligent-ui/protocol.ts");
const { intelligentUiStatePath } = await jiti.import("./intelligent-ui/store.ts");
const { cacheSessionPath, invalidateSessionPathCache } = await jiti.import("./session-reader.ts");
const { writeBetaFeatures } = await jiti.import("./beta-features.ts");
const { GET, PUT } = await jiti.import("../app/api/sessions/[id]/intelligent-ui/route.ts");
const { saveUiOutput } = await jiti.import("./intelligent-ui/write-output.ts");
const { withUiFileLock, uiSessionLockPath } = await jiti.import("./intelligent-ui/session-lock.ts");

const plan = { planVersion: 1, id: "bill", title: "Shared bill", inputs: [{ id: "people", valueType: "number", label: "People", value: 4, min: 1, max: 20 }], derived: [{ id: "total", op: "multiply", args: [{ input: "people" }, { literal: 12 }] }], views: [{ id: "amount", kind: "metric", label: "Total", value: { derived: "total" } }] };
const compiled = revision => compileUiPlan(plan, { revision });
const user = text => ({ role: "user", content: text, timestamp: Date.now() });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "piora-output-write-"));
  const previous = process.env.PI_CODING_AGENT_DIR, baseline = [...(globalThis.__pioraSessionFileOwners?.keys() ?? [])].sort();
  process.env.PI_CODING_AGENT_DIR = root;
  const manager = SessionManager.create(root, join(root, "sessions")), id = manager.getSessionId();
  manager.appendMessage(user("Create an adjustable bill"));
  const file = manager.getSessionFile(), journal = generationJournalPath(id, root);
  cacheSessionPath(id, file); writeBetaFeatures({ intelligentUi: true }, root);
  const host = new UiGenerationPrototype({ manager, root });
  t.after(async () => {
    globalThis.__piSessions?.delete(id); invalidateSessionPathCache(id);
    try { assert.deepEqual([...(globalThis.__pioraSessionFileOwners?.keys() ?? [])].sort(), baseline, "parameter routes must not leak session ownership"); }
    finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
      assert.equal(dirname(root), resolve(tmpdir()));
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
  const context = () => ({ params: Promise.resolve({ id }) });
  const get = async (toolCallId, leafId, requiredAncestorLeafId) => {
    const query = new URLSearchParams({ toolCallId, ...(leafId ? { leafId } : {}), ...(requiredAncestorLeafId !== undefined ? { requiredAncestorLeafId } : {}) });
    const response = await GET(new Request(`http://localhost/api/sessions/${id}/intelligent-ui?${query}`, { headers: { host: "localhost" } }), context());
    return { response, body: await response.json() };
  };
  const put = async (toolCallId, expectedRevision, people, leafId = manager.getLeafId()) => {
    const response = await PUT(new Request(`http://localhost/api/sessions/${id}/intelligent-ui`, {
      method: "PUT", headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ toolCallId, leafId, expectedRevision, state: { people } }),
    }), context());
    return { response, body: await response.json() };
  };
  return {
    root, manager, id, file, journal, host, get, put,
    useLiveBranch: () => {
      globalThis.__piSessions ??= new Map();
      globalThis.__piSessions.set(id, { isAlive: () => true, inner: { sessionManager: manager } });
    },
    candidate: async (toolCallId = "generated", revision = 1) => {
      const capture = await host.captureContext("bill");
      const messageEntryId = manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "piora_render_ui_plan", arguments: plan }], timestamp: Date.now() });
      const created = await host.createCandidate(capture.contextId, toolCallId, compiled(revision));
      const resultEntryId = manager.appendMessage({ role: "toolResult", toolCallId, toolName: "piora_render_ui_plan", isError: false,
        content: [{ type: "text", text: created.details.answerOutput.snapshot }], details: created.details, timestamp: Date.now() });
      const receipt = await host.observePersistedCandidate(created.operationId, { messageEntryId, toolResultEntryIds: [resultEntryId] });
      return { ...created, receipt, toolCallId };
    },
    legacy: (toolCallId, revision = 1) => {
      const surface = compiled(revision).surface, snapshot = formatSnapshot(surface);
      manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "piora_render_ui", arguments: { surface } }], timestamp: Date.now() });
      return manager.appendMessage({ role: "toolResult", toolCallId, toolName: "piora_render_ui", content: [{ type: "text", text: snapshot }], details: { answerOutput: { kind: "intelligent-ui", version: 1, payload: surface, snapshot } }, timestamp: Date.now() });
    },
  };
}
async function publish(f, toolCallId = "generated", revision = 1) {
  await f.host.startRun();
  const created = await f.candidate(toolCallId, revision);
  return { ...created, commit: await f.host.commitCandidate(created.operationId) };
}
function status(result, expected) { assert.equal(result.response.status, expected, JSON.stringify(result.body)); }

test("migration reads require the draft anchor in the current branch, including live navigation and historical-query bypass", async t => {
  const f = await fixture(t), common = f.legacy("legacy");
  const left = f.manager.appendMessage(user("Left draft"));
  f.manager.branch(common);
  const right = f.manager.appendMessage(user("Right draft"));
  f.useLiveBranch();
  const before = await readFile(f.file, "utf8");
  status(await f.get("legacy", undefined, common), 200);
  status(await f.get("legacy", undefined, right), 200);
  status(await f.get("legacy", undefined, left), 409);
  status(await f.get("legacy", left, left), 409);
  status(await f.get("legacy", left, common), 409);
  status(await f.get("legacy", undefined, ""), 400);
  status(await f.get("legacy", undefined, "x".repeat(257)), 400);
  f.manager.branch(left);
  status(await f.get("legacy", undefined, left), 200);
  status(await f.get("legacy", undefined, right), 409);
  assert.equal(await readFile(f.file, "utf8"), before, "migration checks never persist SDK navigation or rewrite history");
});

test("real committed v2 GET/PUT saves in the journal, preserves immutable transcript data, and returns current publication on a stale revision", async t => {
  const f = await fixture(t), item = await publish(f);
  const initial = await f.get(item.toolCallId); status(initial, 200);
  assert.equal(initial.body.publication.status, "committed");
  assert.equal(initial.body.publication.operationId, item.operationId);
  assert.deepEqual(initial.body.state, { people: 4 });
  const transcript = await readFile(f.file, "utf8");
  const saved = await f.put(item.toolCallId, initial.body.revision, 8); status(saved, 200);
  assert.equal(saved.body.publication.status, "committed");
  assert.equal(saved.body.publication.operationId, item.operationId);
  assert.ok(saved.body.revision > initial.body.revision); assert.deepEqual(saved.body.state, { people: 8 });
  assert.equal(await readFile(f.file, "utf8"), transcript, "parameter writes must not replace the immutable tool result");
  const readBack = await f.get(item.toolCallId); status(readBack, 200);
  assert.deepEqual(readBack.body.state, { people: 8 }); assert.equal(readBack.body.revision, saved.body.revision);
  const journal = await readFile(f.journal, "utf8");
  const conflict = await f.put(item.toolCallId, initial.body.revision, 12); status(conflict, 409);
  assert.deepEqual(conflict.body.current.state, { people: 8 });
  assert.equal(conflict.body.current.revision, saved.body.revision);
  assert.equal(conflict.body.current.publication.status, "committed");
  assert.equal(conflict.body.current.publication.operationId, item.operationId);
  assert.equal(await readFile(f.journal, "utf8"), journal);
});

test("candidate and aborted v2 outputs cannot accept parameter writes or publish themselves through GET/PUT", async t => {
  const f = await fixture(t); await f.host.startRun();
  const item = await f.candidate();
  const before = await readFile(f.journal, "utf8");
  const preview = await f.get(item.toolCallId); status(preview, 200);
  assert.equal(preview.body.publication.status, "candidate");
  const write = await f.put(item.toolCallId, preview.body.revision, 9); status(write, 409);
  assert.equal(write.body.current.publication.status, "candidate");
  assert.equal(await readFile(f.journal, "utf8"), before);
  await f.host.cancelRun();
  const aborted = await f.get(item.toolCallId); status(aborted, 200);
  assert.equal(aborted.body.publication.status, "aborted");
  const afterCancel = await readFile(f.journal, "utf8");
  const stale = await f.put(item.toolCallId, aborted.body.revision, 7); status(stale, 409);
  assert.equal(stale.body.current.publication.status, "aborted");
  assert.equal(await readFile(f.journal, "utf8"), afterCancel);
});

test("a committed v2 replaces the legacy writer while retaining legacy history and returning its superseded identity", async t => {
  const f = await fixture(t); f.legacy("legacy");
  const oldSaved = await f.put("legacy", 0, 7); status(oldSaved, 200);
  const oldPath = intelligentUiStatePath(f.id, f.root), oldBytes = await readFile(oldPath, "utf8");
  const item = await publish(f, "replacement", 2);
  const legacyRead = await f.get("legacy"); status(legacyRead, 200);
  assert.deepEqual(legacyRead.body.state, { people: 7 });
  assert.equal(legacyRead.body.publication.status, "superseded");
  assert.equal(legacyRead.body.publication.currentToolCallId, item.toolCallId);
  const before = await readFile(f.journal, "utf8");
  const rejected = await f.put("legacy", oldSaved.body.revision, 11); status(rejected, 409);
  assert.equal(rejected.body.current.publication.status, "superseded");
  assert.equal(rejected.body.current.publication.currentToolCallId, item.toolCallId);
  assert.equal(await readFile(oldPath, "utf8"), oldBytes);
  assert.equal(await readFile(f.journal, "utf8"), before);
  assert.deepEqual((await f.get(item.toolCallId)).body.state, { people: 7 });
});

test("a later legacy output replaces v2 by branch order and the old v2 cannot overwrite either state", async t => {
  const f = await fixture(t), item = await publish(f);
  f.legacy("rollback", 2);
  const old = await f.get(item.toolCallId); status(old, 200);
  assert.equal(old.body.publication.status, "superseded");
  assert.equal(old.body.publication.currentToolCallId, "rollback");
  const before = await readFile(f.journal, "utf8");
  const rejected = await f.put(item.toolCallId, old.body.revision, 10); status(rejected, 409);
  assert.equal(rejected.body.current.publication.status, "superseded");
  assert.equal(rejected.body.current.publication.currentToolCallId, "rollback");
  const legacy = await f.put("rollback", 0, 6); status(legacy, 200);
  assert.deepEqual(legacy.body.state, { people: 6 });
  assert.deepEqual((await f.get(item.toolCallId)).body.state, { people: 4 });
  assert.equal(await readFile(f.journal, "utf8"), before);
});

test("switching branches rejects both another branch's leaf and an ambiguous ancestor without changing current parameters", async t => {
  const f = await fixture(t), item = await publish(f), ancestor = f.manager.getLeafId();
  const left = f.manager.appendMessage(user("Left branch"));
  f.manager.branch(ancestor);
  const right = f.manager.appendMessage(user("Right branch"));
  f.useLiveBranch();
  const before = await readFile(f.journal, "utf8");
  for (const staleLeaf of [left, ancestor]) {
    const rejected = await f.put(item.toolCallId, item.commit.stateRevision, 10, staleLeaf); status(rejected, 409);
    assert.equal(rejected.body.current.leafId, right);
    assert.equal(rejected.body.current.publication.status, "committed");
    assert.deepEqual(rejected.body.current.state, { people: 4 });
  }
  assert.equal(await readFile(f.journal, "utf8"), before);
  assert.deepEqual((await f.get(item.toolCallId, left)).body.state, { people: 4 });
});

test("a single continuation can advance the save anchor while ancestor edits freeze existing children and future branches inherit the new values", async t => {
  const f = await fixture(t), item = await publish(f), ancestor = f.manager.getLeafId();
  const child = f.manager.appendMessage(user("Existing continuation"));
  const grandchild = f.manager.appendMessage(user("Further continuation"));
  f.useLiveBranch();
  const advanced = await f.put(item.toolCallId, item.commit.stateRevision, 7, ancestor); status(advanced, 200);
  assert.equal(advanced.body.leafId, grandchild); assert.deepEqual(advanced.body.state, { people: 7 });
  f.manager.branch(ancestor);
  const earlier = await f.get(item.toolCallId); status(earlier, 200);
  assert.deepEqual(earlier.body.state, { people: 4 });
  const edited = await f.put(item.toolCallId, earlier.body.revision, 9, ancestor); status(edited, 200);
  assert.deepEqual(edited.body.state, { people: 9 });
  const frozen = await f.get(item.toolCallId, child); status(frozen, 200);
  assert.deepEqual(frozen.body.state, { people: 4 }, "an already-created child retains the values visible before its ancestor changed");
  assert.deepEqual((await f.get(item.toolCallId, grandchild)).body.state, { people: 7 }, "a descendant's own saved edit survives ancestor changes");
  const future = f.manager.appendMessage(user("New branch after the ancestor edit"));
  const inherited = await f.get(item.toolCallId, future); status(inherited, 200);
  assert.deepEqual(inherited.body.state, { people: 9 });
  assert.equal(inherited.body.revision, edited.body.revision);
  f.manager.branch(ancestor);
  const editedAgain = await f.put(item.toolCallId, edited.body.revision, 11, ancestor); status(editedAgain, 200);
  const frozenAgain = await f.get(item.toolCallId, child);
  assert.deepEqual(frozenAgain.body.state, { people: 4 }); assert.equal(frozenAgain.body.revision, item.commit.stateRevision);
  assert.deepEqual((await f.get(item.toolCallId, grandchild)).body.state, { people: 7 });
  const previousFuture = await f.get(item.toolCallId, future);
  assert.deepEqual(previousFuture.body.state, { people: 9 }); assert.equal(previousFuture.body.revision, edited.body.revision);
  const latestChild = f.manager.appendMessage(user("Newest branch"));
  const latest = await f.get(item.toolCallId, latestChild);
  assert.deepEqual(latest.body.state, { people: 11 }); assert.equal(latest.body.revision, editedAgain.body.revision);
});

test("navigation while a v2 writer waits for the session lock is rechecked before any journal mutation", async t => {
  const f = await fixture(t), item = await publish(f), ancestor = f.manager.getLeafId();
  const left = f.manager.appendMessage(user("Left"));
  f.manager.branch(ancestor); const right = f.manager.appendMessage(user("Right"));
  f.manager.branch(left);
  const before = await readFile(f.journal, "utf8");
  let release, acquired;
  const gate = new Promise(resolve => { release = resolve; });
  const held = new Promise(resolve => { acquired = resolve; });
  const blocker = withUiFileLock(uiSessionLockPath(f.id, f.root), async () => { acquired(); await gate; });
  await held;
  let settled = false;
  const saving = saveUiOutput({ sessionId: f.id, toolCallId: item.toolCallId, leafId: left, expectedRevision: item.commit.stateRevision,
    state: { people: 10 }, readManager: () => f.manager, enabled: () => true, root: f.root }).finally(() => { settled = true; });
  try {
    await nextTurn();
    assert.equal(settled, false, "the write must remain pending behind the real shared session lock");
    f.manager.branch(right);
  } finally { release(); await blocker; }
  await assert.rejects(saving, error => error.code === "CONFLICT");
  assert.equal(await readFile(f.journal, "utf8"), before);
});

test("different branches may reuse a provider toolCallId while v2 writes resolve the active branch's operation identity", async t => {
  const f = await fixture(t), rootLeaf = f.manager.getLeafId();
  const left = await publish(f, "reused-call"), leftLeaf = f.manager.getLeafId();
  f.manager.branch(rootLeaf); f.manager.appendMessage(user("Independent right branch"));
  const right = await publish(f, "reused-call"), rightLeaf = f.manager.getLeafId();
  assert.notEqual(left.operationId, right.operationId);
  f.useLiveBranch();
  const rightSaved = await f.put("reused-call", right.commit.stateRevision, 9, rightLeaf); status(rightSaved, 200);
  assert.equal(rightSaved.body.publication.operationId, right.operationId);
  assert.deepEqual(rightSaved.body.state, { people: 9 });
  f.manager.branch(leftLeaf);
  const leftRead = await f.get("reused-call"); status(leftRead, 200);
  assert.equal(leftRead.body.publication.operationId, left.operationId); assert.deepEqual(leftRead.body.state, { people: 4 });
  const leftSaved = await f.put("reused-call", left.commit.stateRevision, 6, leftLeaf); status(leftSaved, 200);
  assert.equal(leftSaved.body.publication.operationId, left.operationId);
  const rightRead = await f.get("reused-call", rightLeaf); status(rightRead, 200);
  assert.equal(rightRead.body.publication.operationId, right.operationId); assert.deepEqual(rightRead.body.state, { people: 9 });
});

test("disabling the feature rejects committed v2 writes with 403 while saved GET remains readable", async t => {
  const f = await fixture(t), item = await publish(f);
  const before = await readFile(f.journal, "utf8");
  writeBetaFeatures({ intelligentUi: false }, f.root);
  const rejected = await f.put(item.toolCallId, item.commit.stateRevision, 8); status(rejected, 403);
  const saved = await f.get(item.toolCallId); status(saved, 200);
  assert.equal(saved.body.publication.status, "committed"); assert.deepEqual(saved.body.state, { people: 4 });
  assert.equal(await readFile(f.journal, "utf8"), before);
});
