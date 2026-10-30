import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { SurfaceState, surfaceState } = await jiti.import("./intelligent-ui/client-state.ts");
const { mapDraftValues } = await jiti.import("../lib/intelligent-ui/draft-migration.ts");
const { setAnswerStateEnabled, flushPendingAnswerState } = await jiti.import("../lib/answer-output-client.ts");
const old = { version: 1, id: "order", revision: 1, title: "Original order", nodes: [{ id: "people", type: "number", label: "People", min: 1, max: 20, value: 2 }] };
const next = { ...old, revision: 2, title: "Updated order", nodes: [{ id: "guests", type: "number", label: "Guests", min: 1, max: 10, value: 3 }, { id: "delivery", type: "checkbox", label: "Delivery", value: true }] };
function storage(disk = new Map()) { return { get length() { return disk.size; }, key: i => [...disk.keys()][i] ?? null, getItem: k => disk.get(k) ?? null, setItem: (k,v) => disk.set(k,v), removeItem: k => disk.delete(k) }; }
async function fixture(t) {
  const previous = { fetch: globalThis.fetch, local: globalThis.localStorage, session: globalThis.sessionStorage };
  const disk = new Map(), session = crypto.randomUUID();
  const f = { disk, session, writes: [], denied: false, fail: false, source: { surface: old, state: { people: 2 }, revision: 0, leafId: "old-leaf", publication: { status: "committed", operationId: "old-op" } }, target: { surface: next, state: { guests: 3, delivery: true }, revision: 0, leafId: "new-leaf", publication: { status: "committed", operationId: "new-op" } } };
  globalThis.localStorage = storage(disk); globalThis.sessionStorage = storage();
  globalThis.fetch = async (url, options) => {
    const query = new URL(url, "https://fixture.test").searchParams;
    if (query.has("requiredAncestorLeafId")) {
      assert.equal(query.get("requiredAncestorLeafId"), "old-leaf");
      if (f.denied) return Response.json({}, { status: 409 });
    }
    if (options?.method === "PUT") {
      const body = JSON.parse(options.body); f.writes.push(body);
      assert.equal(body.toolCallId, "new-tool"); assert.equal(body.leafId, f.target.leafId); assert.equal(body.expectedRevision, f.target.revision);
      if (f.fail) return Response.json({}, { status: 503 });
      f.target = { ...f.target, state: body.state, revision: f.target.revision + (f.revisionAdvance ?? 1), leafId: f.savedLeafId ?? f.target.leafId };
      return Response.json(f.target);
    }
    if (f.onRead) await f.onRead(query);
    return Response.json(query.get("toolCallId") === "new-tool" ? f.target : f.source);
  };
  t.after(() => { globalThis.fetch = previous.fetch; globalThis.localStorage = previous.local; globalThis.sessionStorage = previous.session; setAnswerStateEnabled(true); });
  f.store = new SurfaceState(`migration-${session}`, session, "old-tool", old, 2);
  await f.store.load(); setAnswerStateEnabled(false); f.store.change("people", 7); setAnswerStateEnabled(true);
  f.source = { ...f.source, leafId: "new-leaf", publication: { ...f.source.publication, status: "superseded", currentToolCallId: "new-tool" } };
  await f.store.load(true);
  return f;
}
test("explicit mapping copies only selected compatible values; no inferred IDs, conversion or clamping", () => {
  assert.deepEqual(mapDraftValues(old, { people: 7 }, next, { guests: 3, delivery: true }, {}), { guests: 3, delivery: true });
  assert.deepEqual(mapDraftValues(old, { people: 7 }, next, { guests: 3, delivery: true }, { guests: "people" }), { guests: 7, delivery: true });
  assert.throws(() => mapDraftValues(old, { people: 11 }, next, { guests: 3, delivery: true }, { guests: "people" }));
  assert.throws(() => mapDraftValues(old, { people: 7 }, next, { guests: 3, delivery: true }, { delivery: "people" }));
});
test("reviewed migration saves into latest version and retains a linked original", async t => {
  const f = await fixture(t); await f.store.prepareMigration();
  const review = f.store.getSnapshot().migration;
  assert.equal(review.source.state.people, 7); assert.equal(review.target.state.guests, 3); assert.equal(f.writes.length, 0);
  await f.store.migrateDraft(review.id, { guests: "people" });
  assert.deepEqual(f.target.state, { guests: 7, delivery: true }); assert.equal(f.writes.length, 1);
  assert.equal(f.store.getSnapshot().hasPendingDraft, false); assert.equal(f.store.getSnapshot().migrationSaved, true);
  assert.equal(f.store.getSnapshot().retainedDrafts[0].state.people, 7);
  const transfer = [...f.disk].find(([key]) => key.startsWith("piora-ui-transfer:"));
  const record = JSON.parse(transfer[1]); assert.equal(record.status, "saved"); assert.equal(record.sourceDraftId, f.store.getSnapshot().retainedDrafts[0].id);
  await flushPendingAnswerState(f.session);
});
test("target changes after review require new review and leave the source pending", async t => {
  const f = await fixture(t); await f.store.prepareMigration(); const review = f.store.getSnapshot().migration;
  f.target = { ...f.target, state: { ...f.target.state, guests: 4 }, revision: 1 };
  await assert.rejects(f.store.migrateDraft(review.id, { guests: "people" }), /changed/);
  assert.equal(f.writes.length, 0); assert.equal(f.store.getSnapshot().hasPendingDraft, true); assert.equal(f.store.getSnapshot().migration, undefined);
  await assert.rejects(flushPendingAnswerState(f.session));
});
test("branch ancestry rejection and cancellation never write a migration", async t => {
  const f = await fixture(t); f.denied = true;
  await assert.rejects(f.store.prepareMigration(), /branch/); f.denied = false;
  await f.store.prepareMigration(); const review = f.store.getSnapshot().migration; f.store.cancelMigration();
  await assert.rejects(f.store.migrateDraft(review.id, { guests: "people" }), /Review/); assert.equal(f.writes.length, 0);
});
test("failed target save retains independently linked drafts and does not claim transfer", async t => {
  const f = await fixture(t); await f.store.prepareMigration(); f.fail = true;
  await assert.rejects(f.store.migrateDraft(f.store.getSnapshot().migration.id, { guests: "people" }));
  assert.equal(f.store.getSnapshot().hasPendingDraft, false); assert.equal(f.store.getSnapshot().retainedDrafts[0].state.people, 7);
  assert.equal(f.store.getSnapshot().migrationSaved, false);
  const pending = [...f.disk].filter(([key]) => key.startsWith("piora-ui-pending:")); assert.equal(pending.length, 1);
  const targetDraft = JSON.parse(pending[0][1]); assert.equal(targetDraft.state.guests, 7); assert.ok(targetDraft.migration.sourceDraftId);
  assert.equal(JSON.parse([...f.disk].find(([key]) => key.startsWith("piora-ui-transfer:"))[1]).status, "prepared");
  await assert.rejects(flushPendingAnswerState(f.session));
  f.fail = false; await flushPendingAnswerState(f.session); assert.equal(f.target.state.guests, 7);
  assert.equal(JSON.parse([...f.disk].find(([key]) => key.startsWith("piora-ui-transfer:"))[1]).status, "saved");
});
test("a destination's existing local edits cannot be overwritten by migration", async t => {
  const f = await fixture(t); const dest = surfaceState(f.session, "new-tool", next, 2); await dest.load();
  setAnswerStateEnabled(false); dest.change("guests", 9); setAnswerStateEnabled(true);
  await f.store.prepareMigration(); await assert.rejects(f.store.migrateDraft(f.store.getSnapshot().migration.id, { guests: "people" }), /unsaved edits/);
  assert.equal(dest.getSnapshot().state.guests, 9); assert.equal(f.writes.length, 0); assert.equal(f.store.getSnapshot().hasPendingDraft, true);
});
test("source archive storage failure preserves its pending writer and sends no PUT", async t => {
  const f = await fixture(t); await f.store.prepareMigration(); const set = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = (key, value) => { if (!key.startsWith("piora-ui-retained:")) set(key, value); };
  await assert.rejects(f.store.migrateDraft(f.store.getSnapshot().migration.id, { guests: "people" }), /retained/);
  assert.equal(f.writes.length, 0); assert.equal(f.store.getSnapshot().hasPendingDraft, true); await assert.rejects(flushPendingAnswerState(f.session));
});
test("retained drafts can be migrated without restoring a stale pending writer", async t => {
  const f = await fixture(t); await f.store.retainDraft(); const archived = f.store.getSnapshot().retainedDrafts[0];
  await f.store.prepareMigration(archived.id); await f.store.migrateDraft(f.store.getSnapshot().migration.id, { guests: "people" });
  assert.equal(f.target.state.guests, 7); assert.equal(f.store.getSnapshot().hasPendingDraft, false);
  assert.ok(f.store.getSnapshot().retainedDrafts.some(record => record.id === archived.id));
});

test("a journal revision advanced by another surface still acknowledges the exact migration", async t => {
  const f = await fixture(t); f.revisionAdvance = 4;
  await f.store.prepareMigration(); await f.store.migrateDraft(f.store.getSnapshot().migration.id, { guests: "people" });
  assert.equal(f.target.revision, 4); assert.equal(f.target.state.guests, 7);
  assert.equal(f.store.getSnapshot().migrationSaved, true);
  const transfers = [...f.disk].filter(([key]) => key.startsWith("piora-ui-transfer:"));
  assert.equal(JSON.parse(transfers[0][1]).status, "saved");
  assert.equal([...f.disk].filter(([key]) => key.startsWith("piora-ui-pending:")).length, 0);
});

test("an acknowledged save advancing along the server-validated continuation completes migration", async t => {
  const f = await fixture(t); f.savedLeafId = "next-linear-entry";
  await f.store.prepareMigration(); await f.store.migrateDraft(f.store.getSnapshot().migration.id, { guests: "people" });
  assert.equal(f.writes[0].leafId, "new-leaf"); assert.equal(f.target.leafId, "next-linear-entry");
  assert.equal(f.store.getSnapshot().migrationSaved, true); assert.equal(f.target.state.guests, 7);
  const transfers = [...f.disk].filter(([key]) => key.startsWith("piora-ui-transfer:"));
  assert.equal(JSON.parse(transfers[0][1]).status, "saved");
  assert.equal(JSON.parse(transfers[0][1]).target.leafId, "next-linear-entry");
  assert.equal([...f.disk].filter(([key]) => key.startsWith("piora-ui-pending:")).length, 0);
});

test("disabling during migration preflight preserves pending records without PUT or false success, and resume saves", async t => {
  const f = await fixture(t); await f.store.prepareMigration();
  let targetReads = 0;
  f.onRead = query => { if (query.get("toolCallId") === "new-tool" && ++targetReads === 2) setAnswerStateEnabled(false); };
  await assert.rejects(f.store.migrateDraft(f.store.getSnapshot().migration.id, { guests: "people" }), /disabled/);
  assert.equal(f.writes.length, 0); assert.equal(f.target.state.guests, 3);
  assert.equal(f.store.getSnapshot().migrationSaved, false); assert.equal(f.store.getSnapshot().retainedDrafts[0].state.people, 7);
  const transfer = () => JSON.parse([...f.disk].find(([key]) => key.startsWith("piora-ui-transfer:"))[1]);
  assert.equal(transfer().status, "prepared");
  assert.equal([...f.disk].filter(([key]) => key.startsWith("piora-ui-pending:")).length, 1);
  await flushPendingAnswerState(f.session); assert.equal(f.writes.length, 0);
  setAnswerStateEnabled(true); await flushPendingAnswerState(f.session);
  assert.equal(f.writes.length, 1); assert.equal(f.target.state.guests, 7); assert.equal(transfer().status, "saved");
  assert.equal([...f.disk].filter(([key]) => key.startsWith("piora-ui-pending:")).length, 0);
});

test("disabled flush cannot claim a transfer until its durable save receipt exists", async t => {
  const f = await fixture(t); await f.store.prepareMigration();
  const write = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = (key, value) => { write(key, value); if (key.startsWith("piora-ui-transfer:") && JSON.parse(value).status === "prepared") setAnswerStateEnabled(false); };
  await assert.rejects(f.store.migrateDraft(f.store.getSnapshot().migration.id, { guests: "people" }), /pending/);
  assert.equal(f.writes.length, 0); assert.equal(f.store.getSnapshot().migrationSaved, false);
  assert.equal([...f.disk].filter(([key]) => key.startsWith("piora-ui-pending:")).length, 1);
  setAnswerStateEnabled(true); await flushPendingAnswerState(f.session);
  assert.equal(f.writes.length, 1); assert.equal(f.target.state.guests, 7);
});

test("explicitly retaining an unchanged foreign recovery unlocks migration without deleting its source", async t => {
  const f = await fixture(t);
  const targetKey = JSON.stringify([f.session, "new-tool", next.id, next.revision, 2]);
  const original = new SurfaceState(targetKey, f.session, "new-tool", next, 2);
  await original.load(); setAnswerStateEnabled(false); original.change("guests", 8); setAnswerStateEnabled(true);
  const originalRecord = [...f.disk].find(([key]) => key.startsWith(`piora-ui-pending:${targetKey}:`));
  // A new document's store copies and then saves its inherited recovery.
  const reloaded = surfaceState(f.session, "new-tool", next, 2);
  await reloaded.load(); await reloaded.flush();
  assert.equal(f.target.state.guests, 8); assert.equal(f.disk.get(originalRecord[0]), originalRecord[1]);
  await f.store.prepareMigration();
  await assert.rejects(f.store.migrateDraft(f.store.getSnapshot().migration.id, { guests: "people" }), /unsaved edits/);
  await reloaded.retainRecovery(JSON.parse(originalRecord[1]).id);
  await f.store.prepareMigration(); await f.store.migrateDraft(f.store.getSnapshot().migration.id, { guests: "people" });
  assert.equal(f.target.state.guests, 7); assert.equal(f.disk.get(originalRecord[0]), originalRecord[1]);
  // The originating writer can still change independently; retaining the earlier
  // bytes must not authorize overriding this new value.
  setAnswerStateEnabled(false); original.change("guests", 9); setAnswerStateEnabled(true);
  const retained = f.store.getSnapshot().retainedDrafts[0];
  await f.store.prepareMigration(retained.id);
  await assert.rejects(f.store.migrateDraft(f.store.getSnapshot().migration.id, { guests: "people" }), /unsaved edits/);
  assert.equal(JSON.parse(f.disk.get(originalRecord[0])).state.guests, 9);
});

test("v1 drafts migrate into validated Surface2 and rich recovery retains its complete layout", async t => {
  const f = await fixture(t);
  const rich = { ...next, version: 2, layout: [{ id: "inputs", type: "group", title: "New parameters", columns: 2, nodeIds: ["guests", "delivery"] }] };
  f.target = { ...f.target, surface: rich };
  await f.store.prepareMigration(); f.fail = true;
  await assert.rejects(f.store.migrateDraft(f.store.getSnapshot().migration.id, { guests: "people" }));
  const pending = [...f.disk].find(([key]) => key.startsWith("piora-ui-pending:")); const snapshot = JSON.parse(pending[1]);
  assert.equal(snapshot.surface.version, 2); assert.deepEqual(snapshot.surface.layout, rich.layout);
  const key = JSON.stringify([f.session, "new-tool", rich.id, rich.revision, 2]);
  const refreshed = new SurfaceState(key, f.session, "new-tool", rich, 2);
  await refreshed.load(); await assert.rejects(refreshed.flush());
  assert.equal(refreshed.getSnapshot().state.guests, 7); assert.deepEqual(refreshed.getSnapshot().surface.layout, rich.layout);
  assert.equal(f.disk.get(pending[0]), pending[1], "refresh recovers into an independent rich draft without changing the origin");
  assert.equal(f.store.getSnapshot().retainedDrafts[0].surface.version, 1);
});

test("invalid Surface2 destinations are rejected instead of dropping layout and accepting a v1 projection", async t => {
  const f = await fixture(t);
  f.target = { ...f.target, surface: { ...next, version: 2, layout: [{ id: "inputs", type: "group", title: "Incomplete", columns: 2, nodeIds: ["guests"] }] } };
  await assert.rejects(f.store.prepareMigration());
  assert.equal(f.store.getSnapshot().migration, undefined); assert.equal(f.store.getSnapshot().hasPendingDraft, true); assert.equal(f.writes.length, 0);
});
