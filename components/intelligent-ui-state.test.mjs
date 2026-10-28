import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { SurfaceState } = await jiti.import("./intelligent-ui/client-state.ts");
const { flushPendingAnswerState, setAnswerStateEnabled, registerAnswerStateWriter } = await jiti.import("../lib/answer-output-client.ts");
const surface = { version: 1, id: "count", revision: 1, title: "Counter", nodes: [{ id: "count", type: "number", label: "Count", value: 1, min: 0, max: 100 }] };
const tick = () => new Promise(resolve => setImmediate(resolve));

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
    server = { ...server, leafId: "branch-b", state: { count: 5 } }; fail = false;
    const restored = new SurfaceState("recovery", "recovery-session", "tool", surface);
    await restored.load();
    assert.equal(restored.getSnapshot().status, "conflict"); assert.equal(restored.getSnapshot().state.count, 9);
    await assert.rejects(flushPendingAnswerState("recovery-session"), /conflicting/);
    assert.equal(server.state.count, 5);
    await restored.resolve(false);
    await flushPendingAnswerState("recovery-session");
    assert.equal(restored.getSnapshot().state.count, 5); assert.equal(disk.size, 0);
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
