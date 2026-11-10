import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { controlledBackend } from "./harmony/fixtures/controlled-backend.mjs";
const jiti = createJiti(import.meta.url);
const { createHarmonyDeviceManager } = await jiti.import("./harmony/index.ts");
const { validateWorkerRequest } = await jiti.import("./harmony/runtime/worker-protocol.ts");

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "piora-pointer-test-"));
  const { backend, calls } = controlledBackend();
  let rotation = 0;
  backend.displayGeometry = async () => ({ nativeWidth: 1440, nativeHeight: 3200, displayId: "0", displayRotation: rotation });
  backend.pointerPhase = async (serial, phase, id, x, y) => { calls.push({ phase, serial, id, x, y }); };
  const manager = createHarmonyDeviceManager({ backend, configPath: join(directory, "config.json"), arbitrationDirectory: join(directory, "locks") });
  try {
    const lease = await manager.acquireLease({ serial: "phone-1", owner: { kind: "manual", id: "pointer-test" } });
    const generation = manager.getState().devices.find(device => device.serial === "phone-1").generation;
    // Server-observed video metadata fixture; no claim of a physical video feed.
    manager.recordFrameDimensions("phone-1", "video", 720, 1600);
    manager.frameCapturedAt.set("phone-1:video", { capturedAt: Date.now(), generation });
    const geometry = await manager.getFrameGeometry("phone-1", "video");
    const options = { serial: "phone-1", leaseToken: lease.token, generation, coordinateSpace: "frame", geometryId: geometry.geometryId, x: 360, y: 800 };
    await run({ manager, backend, calls, options, rotate: () => { rotation = 180; } });
  } finally { await manager.dispose(); await rm(directory, { recursive: true, force: true }); }
}

test("manual pointer dispatches DOWN immediately and holds the lane until UP", async () => fixture(async ({ manager, calls, options }) => {
  const { gestureId } = await manager.beginManualPointer(options);
  assert.deepEqual(calls.filter(call => call.phase).map(({ phase, x, y }) => ({ phase, x, y })), [{ phase: "down", x: 720, y: 1600 }]);
  const key = manager.pressKey({ serial: options.serial, leaseToken: options.leaseToken, key: "back" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.some(call => call.action === "press_key"), false);
  await assert.rejects(manager.updateManualPointer({ ...options, gestureId: "f".repeat(32), phase: "up" }), e => e.code === "STALE_SNAPSHOT");
  await manager.updateManualPointer({ ...options, gestureId, phase: "move", x: 400, y: 900 });
  await manager.updateManualPointer({ ...options, gestureId, phase: "up" });
  await key;
  assert.deepEqual(calls.filter(call => call.phase).map(({ phase, x, y }) => ({ phase, x, y })), [
    { phase: "down", x: 720, y: 1600 }, { phase: "move", x: 800, y: 1800 }, { phase: "up", x: 800, y: 1800 },
  ]);
  assert.equal(calls.at(-1).action, "press_key");
}));

test("lease revocation releases a held pointer without requiring the revoked lease", async () => fixture(async ({ manager, calls, options }) => {
  await manager.beginManualPointer(options);
  manager.releaseLease(options.leaseToken);
  for (let i = 0; i < 50 && !calls.some(call => call.phase === "up"); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls.filter(call => call.phase === "up").length, 1);
  assert.equal(calls.filter(call => call.phase === "down").length, 1);
}));

test("same-size rotation releases the pointer and rejects subsequent moves", async () => fixture(async ({ manager, calls, options, rotate }) => {
  const { gestureId } = await manager.beginManualPointer(options);
  rotate();
  for (let i = 0; i < 60 && !calls.some(call => call.phase === "up"); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls.filter(call => call.phase === "up").length, 1);
  await assert.rejects(manager.updateManualPointer({ ...options, gestureId, phase: "move", x: 100, y: 100 }));
  assert.equal(calls.filter(call => call.phase === "move").length, 0);
}));

test("worker live pointer requests bind a gesture identity and bounded coordinates", () => {
  const request = { protocol: 1, epoch: "worker", id: 1, deadline: Date.now() + 1000, method: "execute", serial: "phone", args: ["pointer_down", ["a".repeat(32), 10, 20]] };
  assert.doesNotThrow(() => validateWorkerRequest(request, "worker", "phone"));
  for (const values of [["foreign", 10, 20], ["a".repeat(32), -1, 20], ["a".repeat(32), 1.5, 20], ["a".repeat(32), 10, 17000]]) {
    assert.throws(() => validateWorkerRequest({ ...request, args: ["pointer_up", values] }, "worker", "phone"));
  }
});

test("failed pointer release remains uncertain and prevents another mutation", async () => fixture(async ({ manager, backend, calls, options }) => {
  const original = backend.pointerPhase;
  backend.pointerPhase = async (...args) => { await original(...args); if (args[1] === "up") throw new Error("lost release confirmation"); };
  const { gestureId } = await manager.beginManualPointer(options);
  await assert.rejects(manager.updateManualPointer({ ...options, gestureId, phase: "up" }), error => error.details?.cleanup === "uncertain");
  await assert.rejects(manager.pressKey({ serial: options.serial, leaseToken: options.leaseToken, key: "back" }));
  assert.equal(calls.some(call => call.action === "press_key"), false);
  assert.deepEqual(calls.filter(call => call.phase).map(call => call.phase), ["down", "up"]);
}));

test("a stale-generation or future-dated frame cannot continue a held pointer", async () => {
  for (const update of [{ capturedAt: Date.now() + 60000, generation: 1 }, { capturedAt: Date.now(), generation: 999 }]) {
    await fixture(async ({ manager, calls, options }) => {
      const { gestureId } = await manager.beginManualPointer(options);
      manager.frameCapturedAt.set("phone-1:video", update);
      await assert.rejects(manager.updateManualPointer({ ...options, gestureId, phase: "move", x: 1, y: 2 }));
      assert.deepEqual(calls.filter(call => call.phase).map(call => call.phase), ["down", "up"]);
    });
  }
});
