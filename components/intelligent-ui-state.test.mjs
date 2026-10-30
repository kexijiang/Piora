import assert from "node:assert/strict";
import test, { beforeEach, afterEach } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { SurfaceState } = await jiti.import("./intelligent-ui/client-state.ts");
const { flushPendingAnswerState, setAnswerStateEnabled, registerAnswerStateWriter } = await jiti.import("../lib/answer-output-client.ts");
const surface = { version: 1, id: "count", revision: 1, title: "Counter", nodes: [{ id: "count", type: "number", label: "Count", value: 1, min: 0, max: 100 }] };
const tick = () => new Promise(resolve => setImmediate(resolve));
function memoryStorage(disk = new Map()) {
  return { get length() { return disk.size; }, key: index => [...disk.keys()][index] ?? null,
    getItem: key => disk.get(key) ?? null, setItem: (key, value) => disk.set(key, value), removeItem: key => disk.delete(key) };
}
let originalWindowStorage;
beforeEach(() => { originalWindowStorage = globalThis.sessionStorage; globalThis.sessionStorage = memoryStorage(); });
afterEach(() => { globalThis.sessionStorage = originalWindowStorage; });
const pendingEntries = (disk, key) => [...disk].filter(([name]) => name.startsWith(`piora-ui-pending:${key}:`));
const pendingBytes = (disk, key) => pendingEntries(disk, key)[0]?.[1];

test("disabling an optional answer module retains pending writers without blocking normal chat", async () => {
  let attempts = 0;
  const unregister = registerAnswerStateWriter("suspended", "suspended-session", async () => { attempts++; throw new Error("unsaved draft"); });
  try {
    setAnswerStateEnabled(false);
    await flushPendingAnswerState("suspended-session");
    assert.equal(attempts, 0);
    setAnswerStateEnabled(true);
    await assert.rejects(flushPendingAnswerState("suspended-session"), /unsaved draft/);
    assert.equal(attempts, 1);
  } finally { unregister(); setAnswerStateEnabled(true); }
});

test("pending writes coalesce serially and every dependent flush awaits the final user edit", async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  let server = { surface, state: { count: 1 }, leafId: "leaf", revision: 0 }, active = 0, maximum = 0, writes = 0, release;
  const disk = new Map();
  globalThis.localStorage = { getItem: key => disk.get(key) ?? null, setItem: (key, value) => disk.set(key, value), removeItem: key => disk.delete(key) };
  globalThis.fetch = async (_url, options) => {
    if (options?.method === "PUT") {
      writes++; maximum = Math.max(maximum, ++active);
      if (writes === 1) await new Promise(resolve => { release = resolve; });
      const data = JSON.parse(options.body);
      assert.equal(data.expectedRevision, server.revision);
      server = { ...server, revision: server.revision + 1, state: data.state };
      active--;
    }
    return Response.json(server);
  };
  try {
    const store = new SurfaceState("serial", "serial-session", "tool", surface);
    await store.load(); store.change("count", 2);
    await tick(); store.change("count", 3); store.change("count", 4);
    const flushes = [flushPendingAnswerState("serial-session"), flushPendingAnswerState("serial-session")];
    release(); await Promise.all(flushes);
    assert.equal(maximum, 1); assert.equal(writes, 2); assert.equal(server.state.count, 4);
    assert.equal(store.getSnapshot().status, "saved"); assert.equal(disk.size, 0);
  } finally { globalThis.fetch = originalFetch; globalThis.localStorage = originalStorage; }
});

test("unacknowledged recovery on another branch requires explicit resolution and cannot leak into a followup", async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  const disk = new Map();
  let server = { surface, state: { count: 1 }, leafId: "branch-a", revision: 0 }, fail = true;
  globalThis.localStorage = { getItem: key => disk.get(key) ?? null, setItem: (key, value) => disk.set(key, value), removeItem: key => disk.delete(key) };
  globalThis.fetch = async (_url, options) => {
    if (options?.method === "PUT" && fail) return Response.json({}, { status: 503 });
    if (options?.method === "PUT") { const data = JSON.parse(options.body); server = { ...server, state: data.state, revision: server.revision + 1 }; }
    return Response.json(server);
  };
  try {
    const first = new SurfaceState("recovery", "recovery-session", "tool", surface);
    await first.load(); first.change("count", 9);
    await assert.rejects(first.flush());
    assert.equal(disk.size, 1);
    const originatingDraft = [...disk][0];
    server = { ...server, leafId: "branch-b", state: { count: 5 } }; fail = false;
    const restored = new SurfaceState("recovery", "recovery-session", "tool", surface);
    await restored.load();
    assert.equal(restored.getSnapshot().status, "conflict"); assert.equal(restored.getSnapshot().state.count, 9);
    await assert.rejects(flushPendingAnswerState("recovery-session"), /conflicting/);
    assert.equal(server.state.count, 5);
    await restored.resolve(false);
    await flushPendingAnswerState("recovery-session");
    assert.equal(restored.getSnapshot().state.count, 5); assert.equal(restored.getSnapshot().hasPendingDraft, false);
    assert.equal(disk.size, 1); assert.equal(disk.get(originatingDraft[0]), originatingDraft[1], "settling the recovered copy preserves the originating document's draft");
  } finally { globalThis.fetch = originalFetch; globalThis.localStorage = originalStorage; }
});

test("branch revalidation waits out an older read and never leaves the old branch editable", async () => {
  const originalFetch = globalThis.fetch;
  let release, reads = 0;
  globalThis.fetch = async () => {
    reads++;
    const saved = { surface, state: { count: reads === 1 ? 1 : 7 }, leafId: reads === 1 ? "branch-a" : "branch-b", revision: 0 };
    if (reads === 1) await new Promise(resolve => { release = resolve; });
    return Response.json(saved);
  };
  try {
    const store = new SurfaceState("branch-read", "branch-read-session", "tool", surface);
    const first = store.load(); await tick();
    const refresh = store.load(true);
    release(); await Promise.all([first, refresh]);
    assert.equal(reads, 2);
    assert.equal(store.getSnapshot().leafId, "branch-b");
    assert.equal(store.getSnapshot().state.count, 7);
  } finally { globalThis.fetch = originalFetch; }
});

function clientFixture(t, initial, respond) {
  const originalFetch = globalThis.fetch, originalStorage = globalThis.localStorage;
  const disk = new Map();
  const fixture = { server: initial, writes: [], disk, dropRetainedWrites: false };
  globalThis.localStorage = {
    get length() { return disk.size; },
    key: index => [...disk.keys()][index] ?? null,
    getItem: key => disk.get(key) ?? null,
    setItem: (key, value) => { if (!(fixture.dropRetainedWrites && key.startsWith("piora-ui-retained:"))) disk.set(key, value); },
    removeItem: key => disk.delete(key),
  };
  globalThis.fetch = async (_url, options) => {
    if (options?.method === "PUT") {
      const body = JSON.parse(options.body); fixture.writes.push(body);
      if (respond) return respond(fixture, body);
      fixture.server = { ...fixture.server, state: body.state, revision: fixture.server.revision + 1 };
    }
    return Response.json(fixture.server);
  };
  t.after(() => { globalThis.fetch = originalFetch; globalThis.localStorage = originalStorage; setAnswerStateEnabled(true); });
  return fixture;
}
const publication = (status, operationId = "operation-1") => ({ status, operationId, ...(status === "superseded" ? { currentToolCallId: "new-tool" } : {}) });

test("v2 candidates and aborted previews stay read-only, and publication confirmation enables parameter writes", async t => {
  const f = clientFixture(t, { surface, state: { count: 1 }, leafId: "leaf", revision: 0, publication: publication("candidate") });
  const store = new SurfaceState("publication", "publication-session", "tool", surface, 2);
  await store.load();
  assert.equal(store.getSnapshot().status, "candidate"); assert.equal(store.isEditable(), false);
  store.change("count", 5); await store.flush();
  assert.equal(f.writes.length, 0); assert.equal(f.disk.size, 0);
  f.server.publication = publication("aborted"); await store.load(true);
  assert.equal(store.getSnapshot().status, "aborted"); assert.equal(store.isEditable(), false);
  f.server.publication = publication("committed"); await store.load(true);
  assert.equal(store.isEditable(), true);
  store.change("count", 6); await store.flush();
  assert.equal(f.writes.length, 1); assert.equal(f.server.state.count, 6);
  assert.equal(store.getSnapshot().status, "saved"); assert.equal(f.disk.size, 0);
});

test("v2 missing publication or operation identity fails closed, including after an earlier committed read", async t => {
  const f = clientFixture(t, { surface, state: { count: 1 }, leafId: "leaf", revision: 0 });
  const store = new SurfaceState("missing-publication", "missing-publication-session", "tool", surface, 2);
  await store.load();
  assert.equal(store.getSnapshot().status, "error"); assert.equal(store.isEditable(), false);
  f.server.publication = publication("committed"); await store.load(true);
  assert.equal(store.isEditable(), true);
  f.server.publication = { status: "committed" }; await store.load(true);
  assert.equal(store.getSnapshot().status, "error"); assert.equal(store.isEditable(), false);
  store.change("count", 8); await store.flush(); assert.equal(f.writes.length, 0);
});

test("superseded drafts survive reload and leave dependent-send flushes only after separately retained bytes are verified", async t => {
  const f = clientFixture(t, { surface, state: { count: 1 }, leafId: "original-leaf", revision: 2, publication: publication("committed") }, fixture => {
    fixture.server = { ...fixture.server, leafId: "new-leaf", revision: 8, publication: publication("superseded") };
    return Response.json({ current: fixture.server }, { status: 409 });
  });
  const store = new SurfaceState("superseded", "superseded-session", "old-tool", surface, 2);
  await store.load(); store.change("count", 9);
  await assert.rejects(store.flush());
  assert.equal(store.getSnapshot().status, "superseded"); assert.equal(store.isEditable(), false);
  assert.equal(store.getSnapshot().state.count, 9); assert.equal(f.writes.length, 1);
  const originalDraft = pendingBytes(f.disk, "superseded");
  assert.ok(originalDraft);
  for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(flushPendingAnswerState("superseded-session"), /old draft/);
  assert.equal(f.writes.length, 1, "a superseded writer must not repeatedly PUT the obsolete tool call");
  await store.load(true);
  assert.equal(store.getSnapshot().state.count, 9);
  const restored = new SurfaceState("superseded", "superseded-session", "old-tool", surface, 2);
  await restored.load();
  assert.equal(restored.getSnapshot().status, "superseded"); assert.equal(restored.getSnapshot().state.count, 9);
  f.dropRetainedWrites = true;
  await assert.rejects(restored.retainDraft(), /could not be retained/);
  assert.equal(pendingBytes(f.disk, "superseded"), originalDraft);
  assert.equal(restored.getSnapshot().hasPendingDraft, true);
  await assert.rejects(flushPendingAnswerState("superseded-session"));
  f.dropRetainedWrites = false;
  await restored.retainDraft();
  await flushPendingAnswerState("superseded-session");
  assert.equal(f.writes.length, 1); assert.equal(pendingEntries(f.disk, "superseded").length, 1);
  assert.equal(pendingBytes(f.disk, "superseded"), originalDraft, "the originating document's draft remains an independent recoverable record");
  assert.equal(restored.getSnapshot().hasPendingDraft, false);
  const archive = [...f.disk].filter(([key]) => key.startsWith("piora-ui-retained:superseded:")).map(([, value]) => JSON.parse(value));
  assert.equal(archive.length, 1); assert.deepEqual(archive[0].state, { count: 9 });
  assert.equal(archive[0].sessionId, "superseded-session"); assert.equal(archive[0].toolCallId, "old-tool");
  assert.equal(archive[0].leafId, "original-leaf"); assert.equal(archive[0].revision, 2);
  const reopened = new SurfaceState("superseded", "superseded-session", "old-tool", surface, 2);
  await reopened.load();
  assert.equal(reopened.getSnapshot().hasPendingDraft, false);
  assert.deepEqual(reopened.getSnapshot().retainedDrafts[0].state, { count: 9 });
  assert.equal(reopened.isEditable(), false);
  await flushPendingAnswerState("superseded-session");
});

test("legacy drafts superseded by a committed v2 output do not require a legacy operationId or retry the old write", async t => {
  const f = clientFixture(t, { surface, state: { count: 1 }, leafId: "leaf", revision: 0 }, fixture => {
    fixture.server = { ...fixture.server, publication: { status: "superseded", currentToolCallId: "v2-tool" } };
    return Response.json({}, { status: 409 });
  });
  const store = new SurfaceState("legacy-superseded", "legacy-superseded-session", "legacy-tool", surface);
  await store.load(); store.change("count", 7); await assert.rejects(store.flush());
  assert.equal(store.getSnapshot().status, "superseded"); assert.equal(store.getSnapshot().state.count, 7);
  await assert.rejects(store.resolve(true), /read-only/);
  await assert.rejects(store.resolve(false), /read-only/);
  assert.equal(f.writes.length, 1); assert.equal(pendingEntries(f.disk, "legacy-superseded").length, 1);
  await store.retainDraft(); await flushPendingAnswerState("legacy-superseded-session");
  assert.equal(f.writes.length, 1);
});

test("a pending send rechecks publication before PUT and preserves the old draft if another window published", async t => {
  const f = clientFixture(t, { surface, state: { count: 1 }, leafId: "leaf", revision: 0, publication: publication("committed") });
  const store = new SurfaceState("preflight", "preflight-session", "tool", surface, 2);
  await store.load();
  setAnswerStateEnabled(false); store.change("count", 8);
  f.server.publication = publication("superseded"); setAnswerStateEnabled(true);
  await assert.rejects(flushPendingAnswerState("preflight-session"), /no longer editable/);
  assert.equal(f.writes.length, 0); assert.equal(store.getSnapshot().state.count, 8);
  await store.retainDraft(); await flushPendingAnswerState("preflight-session");
  assert.equal(f.writes.length, 0);
});

test("a v2 preflight without publication cannot retain an earlier editing grant or delete a pending draft", async t => {
  const f = clientFixture(t, { surface, state: { count: 1 }, leafId: "leaf", revision: 0, publication: publication("committed") });
  const store = new SurfaceState("missing-preflight", "missing-preflight-session", "tool", surface, 2);
  await store.load();
  setAnswerStateEnabled(false); store.change("count", 8); setAnswerStateEnabled(true);
  delete f.server.publication;
  await assert.rejects(flushPendingAnswerState("missing-preflight-session"), /Publication confirmation/);
  assert.equal(store.isEditable(), false); assert.equal(f.writes.length, 0);
  assert.equal(JSON.parse(pendingBytes(f.disk, "missing-preflight")).state.count, 8);
  f.server.publication = publication("superseded");
  await store.load(true); await store.retainDraft(); await flushPendingAnswerState("missing-preflight-session");
});

test("reconnecting a dirty writer preserves its original branch anchor after a failed refresh", async t => {
  const f = clientFixture(t, { surface, state: { count: 1 }, leafId: "original-leaf", revision: 0, publication: publication("committed") });
  const store = new SurfaceState("refresh-failure", "refresh-failure-session", "tool", surface, 2);
  await store.load(); setAnswerStateEnabled(false); store.change("count", 8); setAnswerStateEnabled(true);
  const responding = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("offline"); };
  await store.load(true);
  assert.equal(store.getSnapshot().leafId, ""); assert.equal(store.isEditable(), false);
  globalThis.fetch = responding;
  await flushPendingAnswerState("refresh-failure-session");
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].leafId, "original-leaf");
  assert.equal(f.server.state.count, 8); assert.equal(f.disk.size, 0);
});

test("independent window drafts survive another window retaining its old version and an offline reload", async t => {
  const f = clientFixture(t, { surface, state: { count: 1 }, leafId: "leaf", revision: 0, publication: publication("committed") });
  const firstWindow = memoryStorage(), secondWindow = memoryStorage();
  globalThis.sessionStorage = firstWindow;
  const first = new SurfaceState("windows", "windows-session", "tool", surface, 2);
  globalThis.sessionStorage = secondWindow;
  const second = new SurfaceState("windows", "windows-session", "tool", surface, 2);
  await first.load(); await second.load();
  setAnswerStateEnabled(false); first.change("count", 7); second.change("count", 8); setAnswerStateEnabled(true);
  const before = pendingEntries(f.disk, "windows");
  assert.equal(before.length, 2);
  const secondRecord = before.find(([, bytes]) => JSON.parse(bytes).state.count === 8);
  f.server.publication = publication("superseded");
  await first.retainDraft();
  assert.equal(f.disk.get(secondRecord[0]), secondRecord[1], "retaining 7 cannot remove or rewrite the other window's 8");
  assert.deepEqual(first.getSnapshot().retainedDrafts.map(draft => draft.state), [{ count: 7 }]);
  assert.equal(first.getSnapshot().recoverableDrafts[0].state.count, 8);
  const responding = globalThis.fetch;
  globalThis.fetch = async () => Response.json({}, { status: 503 });
  globalThis.sessionStorage = secondWindow;
  const restored = new SurfaceState("windows", "windows-session", "tool", surface, 2);
  await restored.load();
  assert.equal(restored.getSnapshot().state.count, 8); assert.equal(restored.getSnapshot().hasPendingDraft, true);
  assert.equal(restored.getSnapshot().status, "error"); assert.equal(restored.isEditable(), false);
  await assert.rejects(flushPendingAnswerState("windows-session"), /503/);
  assert.equal(f.disk.get(secondRecord[0]), secondRecord[1]); assert.equal(f.writes.length, 0);
  globalThis.fetch = responding;
  await restored.load(true); await restored.retainDraft();
  assert.deepEqual(restored.getSnapshot().retainedDrafts.map(draft => draft.state.count).sort(), [7, 8]);
});

test("saving and loading saved values settle only the current window's draft", async t => {
  const f = clientFixture(t, { surface, state: { count: 1 }, leafId: "leaf", revision: 0, publication: publication("committed") });
  globalThis.sessionStorage = memoryStorage();
  const first = new SurfaceState("save-windows", "save-windows-session", "tool", surface, 2);
  globalThis.sessionStorage = memoryStorage();
  const second = new SurfaceState("save-windows", "save-windows-session", "tool", surface, 2);
  await first.load(); await second.load();
  setAnswerStateEnabled(false); first.change("count", 7); second.change("count", 8); setAnswerStateEnabled(true);
  const other = pendingEntries(f.disk, "save-windows").find(([, bytes]) => JSON.parse(bytes).state.count === 8);
  await first.flush();
  assert.equal(f.server.state.count, 7); assert.equal(f.disk.get(other[0]), other[1]);
  setAnswerStateEnabled(false); first.change("count", 9); setAnswerStateEnabled(true);
  await first.resolve(false);
  assert.equal(first.getSnapshot().state.count, 7); assert.equal(f.disk.get(other[0]), other[1]);
  assert.equal(pendingEntries(f.disk, "save-windows").length, 1);
  await second.discard();
});

test("foreign drafts require an explicit choice and restoration copies them without changing their source", async t => {
  const f = clientFixture(t, { surface, state: { count: 1 }, leafId: "leaf", revision: 0, publication: publication("committed") });
  for (const value of [7, 8]) {
    globalThis.sessionStorage = memoryStorage();
    const owner = new SurfaceState("choose", "choose-session", "tool", surface, 2);
    await owner.load(); setAnswerStateEnabled(false); owner.change("count", value); setAnswerStateEnabled(true);
  }
  globalThis.sessionStorage = memoryStorage();
  const chooser = new SurfaceState("choose", "choose-session", "tool", surface, 2);
  await chooser.load();
  assert.equal(chooser.getSnapshot().state.count, 1); assert.equal(chooser.getSnapshot().hasPendingDraft, false);
  assert.equal(chooser.getSnapshot().recoverableDrafts.length, 2);
  await chooser.flush(); assert.equal(f.writes.length, 0);
  const source = pendingEntries(f.disk, "choose").find(([, bytes]) => JSON.parse(bytes).state.count === 8);
  await chooser.restoreDraft(JSON.parse(source[1]).id);
  assert.equal(chooser.getSnapshot().state.count, 8); assert.equal(chooser.getSnapshot().status, "conflict");
  assert.equal(pendingEntries(f.disk, "choose").length, 3); assert.equal(f.disk.get(source[0]), source[1]);
  await assert.rejects(chooser.flush(), /conflicting/);
  await chooser.retainDraft();
  assert.equal(f.disk.get(source[0]), source[1]); assert.equal(pendingEntries(f.disk, "choose").length, 2);
});

test("a duplicated tab can inherit a recovery pointer but edits use a different draft identity", async t => {
  const f = clientFixture(t, { surface, state: { count: 1 }, leafId: "leaf", revision: 0, publication: publication("committed") });
  const originalWindow = memoryStorage(); globalThis.sessionStorage = originalWindow;
  const original = new SurfaceState("cloned", "cloned-session", "tool", surface, 2);
  await original.load(); setAnswerStateEnabled(false); original.change("count", 7); setAnswerStateEnabled(true);
  const source = pendingEntries(f.disk, "cloned")[0];
  const cloneWindow = memoryStorage();
  cloneWindow.setItem("piora-ui-window:cloned", originalWindow.getItem("piora-ui-window:cloned"));
  globalThis.sessionStorage = cloneWindow;
  f.server.revision = 1;
  const clone = new SurfaceState("cloned", "cloned-session", "tool", surface, 2);
  await clone.load(); assert.equal(clone.getSnapshot().state.count, 7);
  clone.change("count", 8);
  assert.equal(f.disk.get(source[0]), source[1]); assert.equal(pendingEntries(f.disk, "cloned").length, 2);
  assert.notEqual(cloneWindow.getItem("piora-ui-window:cloned"), originalWindow.getItem("piora-ui-window:cloned"));
  await clone.retainDraft(); assert.equal(f.disk.get(source[0]), source[1]);
});

test("a duplicated tab that never edits can discard or load saved parameters without deleting its origin's draft", async t => {
  const f = clientFixture(t, { surface, state: { count: 1 }, leafId: "leaf", revision: 0, publication: publication("committed") });
  const originalWindow = memoryStorage(); globalThis.sessionStorage = originalWindow;
  const original = new SurfaceState("clone-settle", "clone-settle-session", "tool", surface, 2);
  await original.load(); setAnswerStateEnabled(false); original.change("count", 7); setAnswerStateEnabled(true);
  const source = pendingEntries(f.disk, "clone-settle")[0];
  f.server.revision = 1;
  for (const action of [clone => clone.discard(), clone => clone.resolve(false)]) {
    const cloneWindow = memoryStorage();
    cloneWindow.setItem("piora-ui-window:clone-settle", originalWindow.getItem("piora-ui-window:clone-settle"));
    globalThis.sessionStorage = cloneWindow;
    const clone = new SurfaceState("clone-settle", "clone-settle-session", "tool", surface, 2);
    await clone.load();
    assert.equal(clone.getSnapshot().state.count, 7);
    assert.notEqual(cloneWindow.getItem("piora-ui-window:clone-settle"), originalWindow.getItem("piora-ui-window:clone-settle"), "even an unedited recovered tab owns a separate snapshot");
    assert.equal(pendingEntries(f.disk, "clone-settle").length, 2);
    await action(clone);
    assert.equal(clone.getSnapshot().hasPendingDraft, false); assert.equal(clone.getSnapshot().state.count, 1);
    assert.equal(f.disk.get(source[0]), source[1]); assert.equal(pendingEntries(f.disk, "clone-settle").length, 1);
    assert.equal(f.server.state.count, 1); assert.equal(f.writes.length, 0);
  }
});

test("an unedited recovered tab retains its own draft and send blocker after the origin archives its record", async t => {
  const f = clientFixture(t, { surface, state: { count: 1 }, leafId: "leaf", revision: 0, publication: publication("committed") });
  const originalWindow = memoryStorage(); globalThis.sessionStorage = originalWindow;
  const original = new SurfaceState("clone-archive", "clone-archive-session", "tool", surface, 2);
  await original.load(); setAnswerStateEnabled(false); original.change("count", 7); setAnswerStateEnabled(true);
  const cloneWindow = memoryStorage();
  cloneWindow.setItem("piora-ui-window:clone-archive", originalWindow.getItem("piora-ui-window:clone-archive"));
  globalThis.sessionStorage = cloneWindow; f.server.publication = publication("superseded");
  const clone = new SurfaceState("clone-archive", "clone-archive-session", "tool", surface, 2);
  await clone.load(); const cloneId = cloneWindow.getItem("piora-ui-window:clone-archive");
  await original.retainDraft();
  assert.ok(f.disk.has(`piora-ui-pending:clone-archive:${cloneId}`));
  const reloadedClone = new SurfaceState("clone-archive", "clone-archive-session", "tool", surface, 2);
  await reloadedClone.load();
  assert.equal(reloadedClone.getSnapshot().state.count, 7); assert.equal(reloadedClone.getSnapshot().hasPendingDraft, true);
  await assert.rejects(reloadedClone.flush(), /old draft/);
  assert.equal(f.server.state.count, 1); assert.equal(f.writes.length, 0);
});

test("legacy shared drafts migrate to a verified visible archive without deleting or silently selecting the source", async t => {
  const f = clientFixture(t, { surface, state: { count: 1 }, leafId: "leaf", revision: 0, publication: publication("committed") });
  const source = JSON.stringify({ surface, state: { count: 9 }, revision: 0, leafId: "leaf", surfaceRevision: 1, publication: publication("committed") });
  f.disk.set("piora-ui-pending:legacy-window", source); f.dropRetainedWrites = true;
  const store = new SurfaceState("legacy-window", "legacy-window-session", "tool", surface, 2);
  await store.load();
  assert.equal(store.getSnapshot().status, "error");
  await assert.rejects(flushPendingAnswerState("legacy-window-session"), /local draft needs recovery/);
  assert.equal(f.disk.get("piora-ui-pending:legacy-window"), source);
  f.dropRetainedWrites = false; await store.load(true);
  assert.equal(store.getSnapshot().state.count, 1); assert.equal(store.getSnapshot().hasPendingDraft, false);
  assert.equal(store.getSnapshot().retainedDrafts.length, 1); assert.equal(store.getSnapshot().retainedDrafts[0].state.count, 9);
  await flushPendingAnswerState("legacy-window-session"); assert.equal(f.writes.length, 0);
  await store.load(true); assert.equal(store.getSnapshot().retainedDrafts.length, 1, "migration is idempotent after readback confirmation");
  await store.restoreDraft(store.getSnapshot().retainedDrafts[0].id);
  assert.equal(store.getSnapshot().state.count, 9); assert.equal(store.getSnapshot().status, "conflict");
  assert.equal(f.disk.get("piora-ui-pending:legacy-window"), source);
  await store.retainDraft(); assert.equal(f.disk.get("piora-ui-pending:legacy-window"), source);
});
