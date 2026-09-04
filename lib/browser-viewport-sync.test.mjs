import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { createBrowserViewportSync } = await createJiti(import.meta.url).import("./browser-viewport-sync.ts");
const bounds = { x: 500, y: 100, width: 600, height: 700 };
const hidden = { x: 0, y: 0, width: 0, height: 0 };
const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup() {
  const calls = [];
  const sync = createBrowserViewportSync((rect, visible) => new Promise((resolve, reject) => {
    calls.push({ rect, visible, resolve, reject });
  }));
  return { sync, calls };
}

test("viewport resizes coalesce to the newest bounds", async () => {
  const { sync, calls } = setup();
  sync.sync(bounds, true);
  sync.sync({ ...bounds, width: 400 }, true);
  sync.sync({ ...bounds, width: 300 }, true);
  assert.equal(calls.length, 1);
  calls[0].resolve();
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].rect.width, 300);
  calls[1].resolve();
  await tick();
  assert.equal(calls.length, 2);
});

test("collapse hides immediately without waiting for an in-flight resize reply", async () => {
  const { sync, calls } = setup();
  sync.sync(bounds, true);
  sync.sync({ ...bounds, width: 900 }, true);
  sync.sync(bounds, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].visible, false);
  assert.deepEqual(calls[1].rect, hidden);
  calls[0].resolve();
  await tick();
  assert.equal(calls.length, 2, "the queued pre-collapse show must be discarded");
});

test("unmount hides without DOM bounds and fences late resize callbacks", async () => {
  const { sync, calls } = setup();
  sync.sync(bounds, true);
  sync.sync({ ...bounds, width: 900 }, true);
  sync.dispose();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].visible, false);
  assert.deepEqual(calls[1].rect, hidden);
  sync.sync(bounds, true);
  sync.dispose();
  calls[0].resolve();
  await tick();
  assert.equal(calls.length, 2, "disposed controllers cannot resurrect a native view");
});

test("even an unmeasured panel sends a hide on unmount", () => {
  const { sync, calls } = setup();
  sync.dispose();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].visible, false);
});

test("reopening creates a fresh controller unaffected by old IPC replies", async () => {
  const { sync: oldSync, calls: oldCalls } = setup();
  oldSync.sync(bounds, true);
  oldSync.dispose();
  const { sync, calls } = setup();
  sync.sync(bounds, true);
  oldCalls[0].resolve();
  oldCalls[1].resolve();
  await tick();
  assert.equal(oldCalls.length, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].visible, true);
});

test("rejected IPC replies after collapse do not replay stale shows", async () => {
  const { sync, calls } = setup();
  sync.sync(bounds, true);
  sync.sync({ ...bounds, width: 900 }, true);
  sync.sync(bounds, false);
  calls[0].reject(new Error("renderer disconnected"));
  calls[1].reject(new Error("renderer disconnected"));
  await tick();
  assert.equal(calls.length, 2);
  sync.sync(bounds, true);
  assert.equal(calls.length, 3, "a subsequent layout can still show the panel");
});
