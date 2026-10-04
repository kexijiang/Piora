import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createHarmonyDeviceManager: rawManagerFactory, HarmonyError } = await jiti.import("./harmony/index.ts");
import { authorizedManagerFactory, fixtureQuality } from "./harmony/fixtures/authorized-manager.mjs";
const createHarmonyDeviceManager = authorizedManagerFactory(rawManagerFactory);

const capabilities = {
  uiTree: true, screenshot: true, tap: true, swipe: true,
  inputText: true, keys: true, launchApp: true,
};

function fakeBackend(overrides = {}) {
  const calls = [];
  const backend = {
    kind: "fake",
    async displayGeometry() { return { nativeWidth: 1440, nativeHeight: 3200, displayRotation: 0, displayId: "0" }; },
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
  const capture = backend.snapshot;
  backend.snapshot = async (...args) => { const snapshot = await capture(...args); return { quality: snapshot.nodes?.length ? fixtureQuality : undefined, ...snapshot }; };
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

test("verified device file copy and move receipts share the fenced action lane", async () => {
  const { backend, calls } = fakeBackend({
    async copyPath(_serial, scope, path, newPath, move) { calls.push(["copyPath", scope.kind, path, newPath, move]); },
  });
  const manager = createHarmonyDeviceManager({ backend });
  try {
    const lease = await manager.acquireLease({ serial: "phone-1", owner: { kind: "manual", id: "manual:files" } });
    const common = { serial: "phone-1", leaseToken: lease.token, scope: { kind: "shared" }, path: "/data/local/tmp/source.txt", newPath: "/data/local/tmp/target.txt" };
    const copied = await manager.copyPath({ ...common, move: false });
    const moved = await manager.copyPath({ ...common, move: true });
    assert.deepEqual(calls.filter(call => call[0] === "copyPath"), [
      ["copyPath", "shared", common.path, common.newPath, false],
      ["copyPath", "shared", common.path, common.newPath, true],
    ]);
    assert.equal(copied.receipt.verification, "passed");
    assert.equal(moved.receipt.effect, "applied");
  } finally { await manager.dispose(); }
});

test("a human gesture fences Agent input and can acquire a fresh lease without a full device stop", async () => {
  let resets = 0;
  const { backend } = fakeBackend({ async resetAutomation() { resets++; } });
  const manager = createHarmonyDeviceManager({ backend });
  try {
    const agent = await manager.acquireLease({ serial: "phone-1", owner: { kind: "agent", id: "agent:run" } });
    await manager.preemptAgentForManual("phone-1");
    assert.equal(resets, 1);
    assert.throws(() => manager.renewLease(agent.token), error => error instanceof HarmonyError && error.code === "LEASE_EXPIRED");
    const manual = await manager.acquireLease({ serial: "phone-1", owner: { kind: "manual", id: "manual:window" } });
    assert.equal(manual.owner.kind, "manual");
    await assert.rejects(() => manager.preemptAgentForManual("phone-1"), error => error instanceof HarmonyError && error.code === "LEASE_CONFLICT");
    manager.releaseLease(manual.token);
    const resumed = await manager.acquireLease({ serial: "phone-1", owner: { kind: "agent", id: "agent:run" } });
    assert.notEqual(resumed.token, agent.token, "the Agent must acquire a new lease after the human gesture");
  } finally { await manager.dispose(); }
});

test("human preemption waits for the in-flight Agent action before resetting device input", async () => {
  let finishTap;
  let tapStarted;
  const started = new Promise(resolve => { tapStarted = resolve; });
  const order = [];
  const { backend } = fakeBackend({
    async tap() { order.push("tap-start"); tapStarted(); await new Promise(resolve => { finishTap = resolve; }); order.push("tap-end"); },
    async resetAutomation() { order.push("reset"); },
  });
  const manager = createHarmonyDeviceManager({ backend });
  try {
    const agent = await manager.acquireLease({ serial: "phone-1", owner: { kind: "agent", id: "agent:run" } });
    const action = manager.tap({ serial: "phone-1", leaseToken: agent.token, x: 1, y: 2 }).catch(error => error);
    await started;
    const preemption = manager.preemptAgentForManual("phone-1");
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(order, ["tap-start"], "input reset must wait for the old driver call");
    finishTap();
    await preemption;
    assert.deepEqual(order, ["tap-start", "tap-end", "reset"]);
    const result = await action;
    assert.ok(result instanceof Error, "the old Agent action cannot claim success after preemption");
  } finally { await manager.dispose(); }
});

test("manual control hands off to a background transfer without exposing the old token", async () => {
  const { backend } = fakeBackend();
  let counter = 0;
  const manager = createHarmonyDeviceManager({ backend, token: () => `lease-${++counter}` });
  try {
    const manual = await manager.acquireLease({ serial: "phone-1", owner: { kind: "manual", id: "manual:window" } });
    const jobId = "12345678-1234-1234-1234-123456789abc";
    const task = manager.handoffTransferLease("phone-1", manual.token, jobId);
    assert.notEqual(task.token, manual.token);
    assert.deepEqual(task.owner, { kind: "agent", id: `transfer:${jobId}` });
    assert.equal(manager.releaseLease(manual.token), false);
    assert.equal(manager.renewLease(task.token).token, task.token);
    await assert.rejects(manager.acquireLease({ serial: "phone-1", owner: { kind: "manual", id: "manual:other" } }), error => error.code === "LEASE_CONFLICT");
    assert.equal(manager.releaseLease(task.token), true);
  } finally { await manager.dispose(); }
});

test("each upload freezes its source only for dispatch and removes the copy after success or failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "piora-upload-dispatch-"));
  const sourcePath = join(directory, "source.bin");
  writeFileSync(sourcePath, "selected bytes");
  const frozen = [];
  let shouldFail = false;
  const { backend } = fakeBackend({ async pushFile(_serial, _scope, source) {
    frozen.push(source);
    assert.notEqual(source, sourcePath);
    assert.equal(existsSync(source), true);
    if (shouldFail) throw new Error("device write failed");
  } });
  const manager = createHarmonyDeviceManager({ backend, configPath: join(directory, "config.json") });
  try {
    const lease = await manager.acquireLease({ serial: "phone-1", owner: { kind: "manual", id: "test" } });
    const upload = () => manager.uploadFile({ serial: "phone-1", scope: { kind: "shared" }, leaseToken: lease.token,
      sourcePath, path: "/data/local/tmp/source.bin", overwrite: true });
    await upload();
    assert.equal(existsSync(frozen[0]), false);
    shouldFail = true;
    await assert.rejects(upload(), error => error.code === "INTERNAL_ERROR" && error.cause?.message === "device write failed");
    assert.equal(existsSync(frozen[1]), false);
    assert.equal(existsSync(sourcePath), true);
  } finally { await manager.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

test("cancelled upload removes its frozen copy after the backend settles", async () => {
  const directory = mkdtempSync(join(tmpdir(), "piora-upload-cancel-"));
  const sourcePath = join(directory, "source.bin");
  writeFileSync(sourcePath, "selected bytes");
  let frozenPath;
  let dispatched;
  const started = new Promise(resolve => { dispatched = resolve; });
  const { backend } = fakeBackend({ async pushFile(_serial, _scope, source, _path, _overwrite, signal) {
    frozenPath = source; dispatched();
    await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("device transfer cancelled")), { once: true }));
  } });
  const manager = createHarmonyDeviceManager({ backend, configPath: join(directory, "config.json") });
  try {
    const lease = await manager.acquireLease({ serial: "phone-1", owner: { kind: "manual", id: "test" } });
    const controller = new AbortController();
    const upload = manager.uploadFile({ serial: "phone-1", scope: { kind: "shared" }, leaseToken: lease.token,
      sourcePath, path: "/data/local/tmp/source.bin", overwrite: true, signal: controller.signal });
    await started;
    assert.equal(existsSync(frozenPath), true);
    controller.abort();
    await assert.rejects(upload);
    assert.equal(existsSync(frozenPath), false);
  } finally { await manager.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

test("live log streams leave the device command lane free and abort on disposal", async () => {
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  let stopped = false;
  const { backend } = fakeBackend({ streamLogs: async (_serial, onEntries, signal) => {
    onEntries([{ level: "info", message: "live", raw: "live" }]); started();
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    stopped = true;
  } });
  const manager = createHarmonyDeviceManager({ backend });
  const rows = [];
  const stream = manager.streamLogs("phone-1", (entries) => rows.push(...entries));
  await ready;
  const lease = await manager.acquireLease({ serial: "phone-1", owner: { kind: "agent", id: "logs-test" } });
  assert.ok(lease.token);
  assert.equal(rows.length, 1);
  await manager.dispose(); await stream;
  assert.equal(stopped, true);
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

test("installs an immutable HAP without a second authorization through the lease-protected queue", async () => {
  const directory = mkdtempSync(join(tmpdir(), "piora-approved-hap-"));
  const hapPath = join(directory, "app.hap");
  writeFileSync(hapPath, "test-package");
  const { backend, calls } = fakeBackend();
  const manager = createHarmonyDeviceManager({ backend, configPath: join(directory, "config.json") });
  try {
    await assert.rejects(() => manager.installPackage({ serial: "phone-1", leaseToken: "", hapPath }),
      error => error.code === "LEASE_REQUIRED");
    const lease = await manager.acquireLease({ serial: "phone-1", owner: { kind: "agent", id: "design-validation:run-a" } });
    const install = () => manager.installPackage({ serial: lease.serial, leaseToken: lease.token, hapPath, replace: true });
    await install();
    const call = calls.find(item => item[0] === "installPackage");
    assert.notEqual(call[1], hapPath);
    assert.equal(existsSync(call[1]), true);
    assert.equal(call[2], true);
    const tasks = manager.operationTasks.list("phone-1");
    assert.equal(tasks[0].status, "completed");
    assert.equal(tasks[0].target, hapPath, "history retains the user's target rather than the frozen artifact path");
    assert.equal(tasks[0].verification, "device-confirmed");
    assert.equal(tasks[1].status, "failed", "a rejected lease cannot appear as a successful install");
    assert.ok(!JSON.stringify(tasks).includes(lease.token), "install history excludes device credentials");
  } finally { await manager.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

test("install refuses a changed preview before sending and passes only the matching frozen bytes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "piora-preview-install-"));
  const hapPath = join(directory, "app.hap"), bytes = Buffer.from("preview-package");
  const expectedHash = createHash("sha256").update(bytes).digest("hex");
  let installCalls = 0;
  const { backend } = fakeBackend({ async installPackage(_serial, frozen) {
    installCalls++; writeFileSync(hapPath, "changed-after-confirmation");
    assert.notEqual(frozen, hapPath); assert.deepEqual(readFileSync(frozen), bytes);
  } });
  const manager = createHarmonyDeviceManager({ backend, configPath: join(directory, "config.json") });
  try {
    const lease = await manager.acquireLease({ serial: "phone-1", owner: { kind: "manual", id: "preview-install" } });
    writeFileSync(hapPath, "changed-after-preview");
    await assert.rejects(() => manager.installPackage({ serial: lease.serial, leaseToken: lease.token, hapPath, expectedHash }),
      error => error.code === "STALE_SNAPSHOT" && error.details?.dispatchState === "not-sent");
    assert.equal(installCalls, 0);
    writeFileSync(hapPath, bytes);
    await manager.installPackage({ serial: lease.serial, leaseToken: lease.token, hapPath, expectedHash });
    assert.equal(installCalls, 1);
  } finally { await manager.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

test("scenario installs retain the original target and device rejection in operation history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "piora-scenario-install-"));
  const hapPath = join(directory, "scenario.hap");
  writeFileSync(hapPath, "test-package");
  const { backend } = fakeBackend({ async installPackage() { throw new HarmonyError("COMMAND_FAILED", "Signature rejected", {
    details: { reason: "signature-rejected", deviceErrorCode: "9568257", dispatchState: "sent" },
  }); } });
  const manager = createHarmonyDeviceManager({ backend, configPath: join(directory, "config.json") });
  try {
    const lease = await manager.acquireLease({ serial: "phone-1", owner: { kind: "agent", id: "scenario-install" } });
    const result = await manager.runScenario({ serial: lease.serial, leaseToken: lease.token, steps: [{ action: "install_app", hapPath }] });
    assert.equal(result.status, "failed");
    const tasks = manager.operationTasks.list("phone-1");
    assert.equal(tasks.length, 1); assert.equal(tasks[0].target, hapPath);
    assert.equal(tasks[0].status, "failed"); assert.equal(tasks[0].deviceErrorCode, "9568257");
  } finally { await manager.dispose(); rmSync(directory, { recursive: true, force: true }); }
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

test("manual input proceeds when a cancelled passive frame has settled with an abort error", async () => {
  let frameStarted;
  const started = new Promise(resolve => { frameStarted = resolve; });
  const { backend, calls } = fakeBackend({
    async snapshot(_serial, options) {
      frameStarted();
      await new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("frame cancelled")), { once: true }));
    },
  });
  const manager = createHarmonyDeviceManager({ backend, token: () => "lease-a" });
  try {
    const lease = await manager.acquireLease({ serial: "phone-1", owner: { kind: "manual", id: "manual:test" } });
    const frame = manager.captureLiveFrame({ serial: "phone-1" });
    const cancelled = assert.rejects(frame, /frame cancelled/);
    await started;
    await manager.tap({ serial: "phone-1", leaseToken: lease.token, x: 1, y: 2 });
    await cancelled;
    assert.deepEqual(calls.at(-1), ["tap", 1, 2]);
  } finally { await manager.dispose(); }
});

test("a device action waits for cancelled frame cleanup beyond the input-release deadline", async () => {
  let frameStarted, finishCleanup, frameAborted;
  const started = new Promise(resolve => { frameStarted = resolve; });
  const aborted = new Promise(resolve => { frameAborted = resolve; });
  const cleanup = new Promise(resolve => { finishCleanup = resolve; });
  const { backend, calls } = fakeBackend({
    async snapshot(_serial, options) {
      frameStarted();
      await new Promise(resolve => options.signal.addEventListener("abort", resolve, { once: true }));
      frameAborted();
      await cleanup;
      throw new Error("frame cleanup completed");
    },
  });
  const manager = createHarmonyDeviceManager({ backend, token: () => "lease-a", cleanupTimeoutMs: 10 });
  try {
    const lease = await manager.acquireLease({ serial: "phone-1", owner: { kind: "manual", id: "manual:test" } });
    const frame = manager.captureLiveFrame({ serial: "phone-1" });
    const cancelled = assert.rejects(frame, /frame cleanup completed/);
    await started;
    const action = manager.tap({ serial: "phone-1", leaseToken: lease.token, x: 1, y: 2 });
    // Attach a handler before crossing the old deadline, so a regression is a
    // normal failed assertion rather than an unhandled rejection.
    const outcome = action.then(() => "complete", error => error);
    await aborted;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(calls.some(call => call[0] === "tap"), false, "input cannot run before actual frame cleanup settles");
    finishCleanup();
    await cancelled;
    assert.equal(await outcome, "complete", "read-only cleanup can outlive the input-release timeout");
    assert.deepEqual(calls.at(-1), ["tap", 1, 2]);
  } finally { finishCleanup(); await manager.dispose(); }
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
    const recording = await manager.startRecording({ serial: "phone-1", ownerId: "media-a" });
    assert.equal(manager.renewLease(lease.token).owner.id, "run-a", "passive recording leaves AI input ownership intact");
    assert.equal(manager.getRecordingState("phone-1").recordingId, recording.recordingId);
    await assert.rejects(
      () => manager.stopRecording({ serial: "phone-1", ownerId: "media-b" }),
      (error) => error instanceof HarmonyError && error.code === "DEVICE_BUSY",
    );
    const artifact = await manager.stopRecording({ serial: "phone-1", ownerId: "media-a", recordingId: recording.recordingId });
    assert.equal(artifact.kind, "recording");
    assert.equal(artifact.path.startsWith(recordingDirectory), true);
    assert.equal(existsSync(artifact.path), true);
    assert.equal(manager.getRecordingState("phone-1"), undefined);
  } finally {
    await manager.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("recording startup remains private until the backend confirms an encoded frame", async () => {
  let ready, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const { backend } = fakeBackend({ startRecording: async () => {
    entered(); await new Promise(resolve => { ready = resolve; });
  }, stopRecording: async () => 0 });
  const manager = createHarmonyDeviceManager({ backend });
  try {
    const lease = await manager.acquireLease({ serial: "phone-1", owner: { kind: "manual", id: "recording-start" } });
    const pending = manager.startRecording({ serial: "phone-1", ownerId: lease.owner.id, leaseToken: lease.token });
    await started;
    const duringStartup = manager.getRecordingState("phone-1");
    ready();
    const recording = await pending;
    assert.equal(duringStartup, undefined, "polling cannot announce success during startup");
    assert.equal(manager.getRecordingState("phone-1").recordingId, recording.recordingId);
  } finally { ready?.(); await manager.dispose(); }
});

test("a reloaded recording error with confirmed cleanup never leaves a recording or recovery claim", async () => {
  const foreignError = Object.assign(new Error("Video component unavailable"), { code: "CAPABILITY_UNAVAILABLE",
    details: { recordingStopped: true, dispatchState: "not-sent" }, toJSON: () => ({ code: "CAPABILITY_UNAVAILABLE" }) });
  foreignError[Symbol.for("piora.harmony.error")] = true;
  const { backend } = fakeBackend({ startRecording: async () => { throw foreignError; } });
  const manager = createHarmonyDeviceManager({ backend });
  try {
    const lease = await manager.acquireLease({ serial: "phone-1", owner: { kind: "manual", id: "recording-failure" } });
    await assert.rejects(manager.startRecording({ serial: "phone-1", ownerId: lease.owner.id, leaseToken: lease.token }), error => error.code === "CAPABILITY_UNAVAILABLE");
    assert.equal(manager.getRecordingState("phone-1"), undefined);
    assert.equal(manager.getState().controls.some(control => control.serial === "phone-1" && control.status === "recovering"), false);
  } finally { await manager.dispose(); }
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

test("refuses recently captured bounds when fresh UiTest structure is empty", async () => {
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
  await assert.rejects(manager.tapRef({
    serial: "phone-1", leaseToken: lease.token, ref: snapshot.nodes[0].ref, generation: snapshot.generation,
  }), error => error.code === "OBSERVATION_UNAVAILABLE");
  assert.equal(calls.some(call => call[0] === "tap"), false);
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
