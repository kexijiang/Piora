import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createHarmonyDeviceManager, HarmonyError } = await jiti.import("./harmony/index.ts");

const capabilities = {
  uiTree: true, screenshot: true, tap: true, swipe: true,
  inputText: true, keys: true, launchApp: true,
};

function fakeBackend(overrides = {}) {
  const calls = [];
  const backend = {
    kind: "fake",
    hdcPath: "C:\\fake\\hdc.exe",
    async listDevices() {
      calls.push(["listDevices"]);
      return [{ serial: "phone-1", state: "online", model: "Mate", capabilities }];
    },
    async snapshot() {
      calls.push(["snapshot"]);
      return {
        tree: { children: [] },
        nodes: [{ text: "Open", clickable: true, enabled: true, visible: true, bounds: { left: 10, top: 20, right: 110, bottom: 60 } }],
        screenshot: { mimeType: "image/png", data: Buffer.from("png") },
      };
    },
    async tap(_serial, x, y) { calls.push(["tap", x, y]); },
    async swipe(...args) { calls.push(["swipe", ...args.slice(1, 6)]); },
    async inputText(_serial, text) { calls.push(["inputText", text]); },
    async pressKey(_serial, key) { calls.push(["pressKey", key]); },
    async launchApp(_serial, bundle, ability) { calls.push(["launchApp", bundle, ability]); },
    async installPackage(_serial, hapPath, replace) { calls.push(["installPackage", hapPath, replace]); },
    ...overrides,
  };
  return { backend, calls };
}

test("enforces one expiring lease per physical device", async () => {
  let now = Date.parse("2026-08-12T00:00:00.000Z");
  const { backend } = fakeBackend();
  const manager = createHarmonyDeviceManager({ backend, now: () => now, token: () => "lease-a" });
  const lease = await manager.acquireLease({ serial: "phone-1", owner: { kind: "agent", id: "run-a" }, ttlMs: 5000 });
  assert.equal(lease.token, "lease-a");
  await assert.rejects(
    () => manager.acquireLease({ serial: "phone-1", owner: { kind: "agent", id: "run-b" } }),
    (error) => error instanceof HarmonyError && error.code === "LEASE_CONFLICT",
  );
  now += 5001;
  assert.throws(() => manager.renewLease(lease.token),
    (error) => error instanceof HarmonyError && error.code === "LEASE_EXPIRED");
  await manager.dispose();
});

test("requires leases for writes and safely revalidates retained semantic refs", async () => {
  const { backend, calls } = fakeBackend();
  const manager = createHarmonyDeviceManager({ backend, token: () => "lease-a" });
  await assert.rejects(() => manager.tap({ serial: "phone-1", leaseToken: "", x: 1, y: 2 }),
    (error) => error instanceof HarmonyError && error.code === "LEASE_REQUIRED");
  const lease = await manager.acquireLease({ serial: "phone-1", owner: { kind: "agent", id: "run-a" } });
  const first = await manager.snapshot({ serial: "phone-1", leaseToken: lease.token });
  assert.match(first.nodes[0].ref, /^g1-r1-n0$/);
  await manager.tapRef({ serial: "phone-1", leaseToken: lease.token, ref: first.nodes[0].ref, generation: first.generation });
  assert.deepEqual(calls.at(-1), ["tap", 60, 40]);
  await manager.snapshot({ serial: "phone-1", leaseToken: lease.token });
  const reused = await manager.tapRef({
    serial: "phone-1",
    leaseToken: lease.token,
    ref: first.nodes[0].ref,
    generation: first.generation,
  });
  assert.deepEqual(calls.at(-1), ["tap", 60, 40]);
  assert.match(reused.strategy, /semantic/);
  await manager.dispose();
});

test("installs HAP packages through the existing lease-protected device queue", async () => {
  const { backend, calls } = fakeBackend();
  const manager = createHarmonyDeviceManager({ backend, token: () => "lease-a" });
  await assert.rejects(() => manager.installPackage({ serial: "phone-1", leaseToken: "", hapPath: "C:\\preview\\app.hap" }),
    (error) => error instanceof HarmonyError && error.code === "LEASE_REQUIRED");
  const lease = await manager.acquireLease({ serial: "phone-1", owner: { kind: "agent", id: "design-validation:run-a" } });
  await manager.installPackage({ serial: "phone-1", leaseToken: lease.token, hapPath: "C:\\preview\\app.hap", replace: true });
  assert.deepEqual(calls.at(-1), ["installPackage", "C:\\preview\\app.hap", true]);
  await manager.dispose();
});

test("live-view screenshot polling does not replace the latest UI-tree refs", async () => {
  const { backend, calls } = fakeBackend();
  const manager = createHarmonyDeviceManager({ backend, token: () => "lease-a" });
  const lease = await manager.acquireLease({ serial: "phone-1", owner: { kind: "agent", id: "run-a" } });
  const treeSnapshot = await manager.snapshot({ serial: "phone-1", leaseToken: lease.token });
  const frameSnapshot = await manager.snapshot({
    serial: "phone-1",
    includeTree: false,
    includeScreenshot: true,
  });
  assert.equal(frameSnapshot.nodes, undefined);
  assert.equal(frameSnapshot.revision, treeSnapshot.revision + 1);
  await manager.tapRef({
    serial: "phone-1",
    leaseToken: lease.token,
    ref: treeSnapshot.nodes[0].ref,
    generation: treeSnapshot.generation,
  });
  assert.deepEqual(calls.at(-1), ["tap", 60, 40]);
  await manager.dispose();
});

test("live frames bypass queued controls and coalesce passive screenshot work", async () => {
  let releaseTap;
  let snapshotCalls = 0;
  const { backend } = fakeBackend({
    async tap() { await new Promise((resolve) => { releaseTap = resolve; }); },
    async snapshot() {
      snapshotCalls += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return { screenshot: { mimeType: "image/png", data: Buffer.from("png") } };
    },
  });
  const manager = createHarmonyDeviceManager({ backend, token: () => "lease-a" });
  const lease = await manager.acquireLease({ serial: "phone-1", owner: { kind: "manual", id: "manual:test" } });
  const tap = manager.tap({ serial: "phone-1", leaseToken: lease.token, x: 1, y: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  const first = manager.captureLiveFrame({ serial: "phone-1" });
  const second = manager.captureLiveFrame({ serial: "phone-1" });
  const [left, right] = await Promise.all([first, second]);
  assert.equal(snapshotCalls, 1);
  assert.equal(left.revision, right.revision);
  releaseTap();
  await tap;
  await manager.dispose();
});

test("persists screenshots and downloaded recordings in configured folders", async () => {
  const directory = mkdtempSync(join(tmpdir(), "piora-harmony-media-"));
  const configPath = join(directory, "harmony.json");
  const screenshotDirectory = join(directory, "screenshots");
  const recordingDirectory = join(directory, "recordings");
  writeFileSync(configPath, JSON.stringify({ storage: { screenshotDirectory, recordingDirectory } }));
  const { backend, calls } = fakeBackend({
    async startRecording(_serial, name) { calls.push(["startRecording", name]); },
    async stopRecording(_serial, name, destinationPath) {
      calls.push(["stopRecording", name, destinationPath]);
      writeFileSync(destinationPath, Buffer.from("video"));
      return 5;
    },
  });
  const manager = createHarmonyDeviceManager({ backend, configPath, token: () => "lease-a" });
  try {
    const lease = await manager.acquireLease({ serial: "phone-1", owner: { kind: "agent", id: "run-a" } });
    const screenshot = await manager.captureScreenshotArtifact({ serial: "phone-1", leaseToken: lease.token });
    assert.equal(screenshot.kind, "screenshot");
    assert.equal(screenshot.path.startsWith(screenshotDirectory), true);
    assert.equal(existsSync(screenshot.path), true);
    const recording = await manager.startRecording({ serial: "phone-1", leaseToken: lease.token, ownerId: "run-a" });
    assert.equal(manager.getRecordingState("phone-1").recordingId, recording.recordingId);
    const artifact = await manager.stopRecording({ serial: "phone-1", leaseToken: lease.token, ownerId: "run-a" });
    assert.equal(artifact.kind, "recording");
    assert.equal(artifact.path.startsWith(recordingDirectory), true);
    assert.equal(existsSync(artifact.path), true);
    assert.equal(manager.getRecordingState("phone-1"), undefined);
  } finally {
    await manager.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("revalidates a UI ref against a fresh tree and invalidates refs after every write", async () => {
  let snapshotCount = 0;
  const { backend, calls } = fakeBackend({
    async snapshot() {
      snapshotCount += 1;
      return {
        tree: { children: [] },
        nodes: [{ text: snapshotCount === 1 ? "Delete" : "Cancel", clickable: true, enabled: true, visible: true, bounds: { left: 10, top: 20, right: 110, bottom: 60 } }],
        screenshot: { mimeType: "image/png", data: Buffer.from("png") },
      };
    },
  });
  const manager = createHarmonyDeviceManager({ backend, token: () => "lease-a" });
  const lease = await manager.acquireLease({ serial: "phone-1", owner: { kind: "agent", id: "run-a" } });
  const snapshot = await manager.snapshot({ serial: "phone-1", leaseToken: lease.token });
  await assert.rejects(
    () => manager.tapRef({ serial: "phone-1", leaseToken: lease.token, ref: snapshot.nodes[0].ref, generation: snapshot.generation }),
    (error) => error instanceof HarmonyError && error.code === "STALE_SNAPSHOT",
  );
  assert.equal(calls.some((call) => call[0] === "tap"), false);
  assert.equal(manager.getState().snapshots.length, 0);
  await manager.dispose();
});

test("refuses stale coordinate fallback when the fresh UiTest tree is empty", async () => {
  let snapshotCount = 0;
  const { backend, calls } = fakeBackend({
    async snapshot() {
      snapshotCount += 1;
      if (snapshotCount > 1) return { nodes: [] };
      return {
        nodes: [{ text: "Settings", type: "Button", clickable: true, enabled: true, visible: true, bounds: { left: 10, top: 20, right: 110, bottom: 60 } }],
      };
    },
  });
  const manager = createHarmonyDeviceManager({ backend, token: () => "lease-a" });
  const lease = await manager.acquireLease({ serial: "phone-1", owner: { kind: "agent", id: "run-a" } });
  const snapshot = await manager.snapshot({ serial: "phone-1", leaseToken: lease.token, includeScreenshot: false });
  await assert.rejects(
    () => manager.tapRef({
      serial: "phone-1", leaseToken: lease.token, ref: snapshot.nodes[0].ref, generation: snapshot.generation,
    }),
    (error) => error instanceof HarmonyError && error.code === "STALE_SNAPSHOT",
  );
  assert.equal(calls.some((call) => call[0] === "tap"), false);
  await manager.dispose();
});

test("releases a device lease as soon as the device becomes offline", async () => {
  let online = true;
  const { backend } = fakeBackend({
    async listDevices() {
      return [{ serial: "phone-1", state: online ? "online" : "offline", model: "Mate", capabilities }];
    },
  });
  const manager = createHarmonyDeviceManager({ backend, token: () => "lease-a" });
  await manager.acquireLease({ serial: "phone-1", owner: { kind: "manual", id: "manual:test" } });
  online = false;
  await manager.listDevices();
  assert.equal(manager.getState().leases.length, 0);
  await manager.dispose();
});

test("keeps an online device and lease through transient discovery misses without changing generation", async () => {
  let visible = true;
  let now = Date.parse("2026-08-30T00:00:00.000Z");
  const { backend } = fakeBackend({
    async listDevices() {
      return visible ? [{ serial: "phone-1", state: "online", model: "Mate", capabilities }] : [];
    },
  });
  const manager = createHarmonyDeviceManager({ backend, now: () => now, token: () => "lease-a" });
  const lease = await manager.acquireLease({ serial: "phone-1", owner: { kind: "manual", id: "manual:test" } });
  const initial = manager.getState().devices[0];

  visible = false;
  now += 5_000;
  await manager.listDevices();
  const missingOnce = manager.getState();
  assert.equal(missingOnce.devices[0].state, "online");
  assert.equal(missingOnce.devices[0].generation, initial.generation);
  assert.equal(missingOnce.devices[0].lastSeenAt, initial.lastSeenAt);
  assert.equal(missingOnce.leases[0].token, lease.token);

  now += 5_000;
  await manager.listDevices();
  const missingTwice = manager.getState();
  assert.equal(missingTwice.devices[0].state, "online");
  assert.equal(missingTwice.devices[0].generation, initial.generation);
  assert.equal(missingTwice.devices[0].lastSeenAt, initial.lastSeenAt);
  assert.equal(missingTwice.leases[0].token, lease.token);

  visible = true;
  now += 5_000;
  await manager.listDevices();
  const recovered = manager.getState();
  assert.equal(recovered.devices[0].generation, initial.generation);
  assert.equal(recovered.leases[0].token, lease.token);
  await manager.dispose();
});

test("confirms a disconnected device after three consecutive discovery misses", async () => {
  let visible = true;
  const { backend } = fakeBackend({
    async listDevices() {
      return visible ? [{ serial: "phone-1", state: "online", model: "Mate", capabilities }] : [];
    },
  });
  const manager = createHarmonyDeviceManager({ backend, token: () => "lease-a" });
  await manager.acquireLease({ serial: "phone-1", owner: { kind: "manual", id: "manual:test" } });

  visible = false;
  await manager.listDevices();
  assert.equal(manager.getState().devices.length, 1);
  assert.equal(manager.getState().leases.length, 1);
  await manager.listDevices();
  assert.equal(manager.getState().devices.length, 1);
  assert.equal(manager.getState().leases.length, 1);
  await manager.listDevices();
  assert.equal(manager.getState().devices.length, 0);
  assert.equal(manager.getState().leases.length, 0);
  await manager.dispose();
});

test("rejects an invalid HDC reconfiguration before changing the persisted or active runtime", async () => {
  const directory = mkdtempSync(join(tmpdir(), "piora-harmony-manager-config-"));
  const configPath = join(directory, "harmony.json");
  const { backend, calls } = fakeBackend();
  let candidateDisposed = false;
  const manager = createHarmonyDeviceManager({
    configPath,
    backendFactory(config) {
      if (config.hdcPath) return {
        ...backend,
        async listDevices() { throw new HarmonyError("HDC_INVALID", "bad candidate"); },
        async dispose() { candidateDisposed = true; },
      };
      return backend;
    },
  });
  try {
    await assert.rejects(
      () => manager.updateConfig({ hdcPath: "C:\\bad\\hdc.exe" }),
      (error) => error instanceof HarmonyError && error.code === "HDC_INVALID",
    );
    assert.deepEqual(manager.getConfig(), {});
    assert.equal(existsSync(configPath), false);
    assert.equal(candidateDisposed, true);
    await manager.listDevices();
    assert.equal(calls.some((call) => call[0] === "listDevices"), true);
  } finally {
    await manager.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("serializes backend operations for the same device", async () => {
  let releaseTap;
  const started = [];
  const { backend } = fakeBackend({
    async tap() {
      started.push("tap");
      await new Promise((resolve) => { releaseTap = resolve; });
    },
    async pressKey() { started.push("key"); },
  });
  const manager = createHarmonyDeviceManager({ backend, token: () => "lease-a" });
  const lease = await manager.acquireLease({ serial: "phone-1", owner: { kind: "agent", id: "run-a" } });
  const tap = manager.tap({ serial: "phone-1", leaseToken: lease.token, x: 1, y: 2 });
  const key = manager.pressKey({ serial: "phone-1", leaseToken: lease.token, key: "back" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["tap"]);
  releaseTap();
  await Promise.all([tap, key]);
  assert.deepEqual(started, ["tap", "key"]);
  await manager.dispose();
});

test("runs independent physical-device lanes concurrently", async () => {
  const started = [];
  let releaseFirst;
  let tokenIndex = 0;
  const { backend } = fakeBackend({
    async listDevices() {
      return ["phone-1", "phone-2"].map((serial) => ({ serial, state: "online", capabilities }));
    },
    async tap(serial) {
      started.push(serial);
      if (serial === "phone-1") await new Promise((resolve) => { releaseFirst = resolve; });
    },
  });
  const manager = createHarmonyDeviceManager({ backend, token: () => `lease-${++tokenIndex}` });
  const firstLease = await manager.acquireLease({ serial: "phone-1", owner: { kind: "agent", id: "run-a" } });
  const secondLease = await manager.acquireLease({ serial: "phone-2", owner: { kind: "agent", id: "run-b" } });
  const first = manager.tap({ serial: "phone-1", leaseToken: firstLease.token, x: 1, y: 2 });
  const second = manager.tap({ serial: "phone-2", leaseToken: secondLease.token, x: 3, y: 4 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["phone-1", "phone-2"]);
  releaseFirst();
  await Promise.all([first, second]);
  await manager.dispose();
});

test("one cancelled caller does not abort a shared device refresh needed by another lane", async () => {
  let completeRefresh;
  const { backend } = fakeBackend({
    async listDevices() {
      await new Promise((resolve) => { completeRefresh = resolve; });
      return [{ serial: "phone-1", state: "online", capabilities }];
    },
  });
  const manager = createHarmonyDeviceManager({ backend });
  const controller = new AbortController();
  const cancelled = manager.listDevices(controller.signal);
  const surviving = manager.snapshot({ serial: "phone-1", includeTree: true, includeScreenshot: false });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(cancelled, (error) => error.code === "COMMAND_ABORTED");
  completeRefresh();
  await surviving;
  await manager.dispose();
});

test("executes a complete scenario inside one lease-protected device lane", async () => {
  const { backend, calls } = fakeBackend({
    async semanticAction(_serial, request) { calls.push(["semanticAction", request.action]); return { strategy: "hypium_semantic_rpc" }; },
    async waitForIdle() {},
  });
  const manager = createHarmonyDeviceManager({ backend, token: () => "lease-a" });
  const lease = await manager.acquireLease({ serial: "phone-1", owner: { kind: "agent", id: "run-a" } });
  const result = await manager.runScenario({
    serial: "phone-1",
    leaseToken: lease.token,
    steps: [{ action: "tap", selector: { text: "Open" } }],
  });
  assert.equal(result.status, "passed");
  assert.equal(result.steps[0].strategy, "hypium_semantic_rpc");
  assert.equal(calls.some((call) => call[0] === "semanticAction"), true);
  await manager.dispose();
});

test("emergency stop aborts active work, drops queued work, leases, and snapshots", async () => {
  let activeSignal;
  const { backend } = fakeBackend({
    async tap(_serial, _x, _y, signal) {
      activeSignal = signal;
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new HarmonyError("COMMAND_ABORTED", "aborted")), { once: true }));
    },
  });
  const manager = createHarmonyDeviceManager({ backend, token: () => "lease-a" });
  const lease = await manager.acquireLease({ serial: "phone-1", owner: { kind: "agent", id: "run-a" } });
  await manager.snapshot({ serial: "phone-1" });
  const active = manager.tap({ serial: "phone-1", leaseToken: lease.token, x: 1, y: 2 });
  const queued = manager.pressKey({ serial: "phone-1", leaseToken: lease.token, key: "home" });
  await new Promise((resolve) => setImmediate(resolve));
  await manager.emergencyStop();
  assert.equal(activeSignal.aborted, true);
  await assert.rejects(active, (error) => error.code === "COMMAND_ABORTED");
  await assert.rejects(queued, (error) => error.code === "COMMAND_ABORTED");
  assert.equal(manager.getState().leases.length, 0);
  assert.equal(manager.getState().snapshots.length, 0);
  await manager.dispose();
});

test("releaseOwner cancels that agent's active and queued device work", async () => {
  let activeSignal;
  const { backend } = fakeBackend({
    async tap(_serial, _x, _y, signal) {
      activeSignal = signal;
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new HarmonyError("COMMAND_ABORTED", "aborted")), { once: true }));
    },
  });
  const manager = createHarmonyDeviceManager({ backend, token: () => "lease-a" });
  const lease = await manager.acquireLease({ serial: "phone-1", owner: { kind: "agent", id: "run-a" } });
  const active = manager.tap({ serial: "phone-1", leaseToken: lease.token, x: 1, y: 2 });
  const queued = manager.pressKey({ serial: "phone-1", leaseToken: lease.token, key: "home" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.releaseOwner("run-a"), 1);
  assert.equal(activeSignal.aborted, true);
  await assert.rejects(active, (error) => error.code === "COMMAND_ABORTED");
  await assert.rejects(queued, (error) => error.code === "LEASE_REQUIRED" || error.code === "COMMAND_ABORTED");
  await manager.dispose();
});

test("releaseOwner cancels a queued lease acquisition before it can create a lease", async () => {
  let unblockDiscovery;
  let calls = 0;
  const { backend } = fakeBackend({
    async listDevices() {
      calls += 1;
      if (calls === 1) await new Promise((resolve) => { unblockDiscovery = resolve; });
      return [{ serial: "phone-1", state: "online", model: "Mate", capabilities }];
    },
  });
  const manager = createHarmonyDeviceManager({ backend, token: () => "lease-a" });
  const blocker = manager.listDevices();
  const acquire = manager.acquireLease({ serial: "phone-1", owner: { kind: "agent", id: "run-a" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.releaseOwner("run-a"), 0);
  unblockDiscovery();
  await blocker;
  await assert.rejects(acquire, (error) => error.code === "COMMAND_ABORTED");
  assert.equal(manager.getState().leases.length, 0);
  await manager.dispose();
});
