import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { controlledBackend, deferred } from "./harmony/fixtures/controlled-backend.mjs";

const jiti = createJiti(import.meta.url, { alias: { "@": join(import.meta.dirname, "..") } });
const { HarmonyDeviceManager } = await jiti.import("./harmony/device-manager.ts");
const { HarmonyError } = await jiti.import("./harmony/errors.ts");
const { HarmonyOperationTasks } = await jiti.import("./harmony/operation-tasks.ts");
const serial = "phone-1", ownerId = "gui:media";
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), "the asynchronous cleanup did not settle");
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "piora-passive-media-"));
  const configPath = join(directory, "harmony.json");
  await writeFile(configPath, JSON.stringify({ storage: { screenshotDirectory: join(directory, "screenshots"), recordingDirectory: join(directory, "recordings") } }));
  const { backend, state, calls } = controlledBackend();
  const notifications = [], stops = [];
  backend.startRecording = async (_serial, name, signal, onFailure) => { notifications.push({ name, signal, onFailure }); };
  backend.stopRecording = async (_serial, name, destination) => { stops.push(name); await writeFile(destination, "video"); return 5; };
  const { physicalLock = false, ...managerOptions } = options;
  const arbitrationDirectory = physicalLock ? join(directory, "locks") : managerOptions.arbitrationDirectory;
  const manager = new HarmonyDeviceManager({ backend, configPath, ...managerOptions, arbitrationDirectory });
  t.after(async () => { await manager.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { directory, configPath, arbitrationDirectory, backend, state, calls, manager, notifications, stops };
}

async function passiveView(t, manager, backend) {
  let controller, closed = 0;
  backend.openVideoStream = async () => ({
    stream: new ReadableStream({ start(value) { controller = value; } }),
    async close() { if (!closed++) controller.close(); },
  });
  const connection = await manager.openVideoStream({ serial });
  const reader = connection.stream.getReader();
  t.after(() => reader.cancel().catch(() => undefined));
  const send = async (type, payload) => {
    const bytes = Buffer.alloc(8 + payload.length); bytes.writeUInt32BE(type); bytes.writeUInt32BE(payload.length, 4); payload.copy(bytes, 8);
    controller.enqueue(bytes);
    const result = await reader.read(); assert.equal(result.done, false); assert.deepEqual(Buffer.from(result.value), bytes);
  };
  const config = Buffer.alloc(13); config.writeUInt32BE(1440, 1); config.writeUInt32BE(3200, 5); config.writeUInt32BE(30, 9);
  await send(2, config); await send(3, Buffer.from("initial-frame"));
  return { connection, reader, send, closed: () => closed };
}

test("real physical-lock owner release preserves the viewer, logs, epoch and subsequent GUI recording", async t => {
  const { manager, backend, arbitrationDirectory, configPath, stops } = await fixture(t, { physicalLock: true });
  const video = await passiveView(t, manager, backend);
  const logReady = deferred(); let logSignal;
  backend.streamLogs = async (_serial, _entries, signal) => {
    logSignal = signal; logReady.resolve();
    await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", resolve, { once: true }); });
  };
  const logs = manager.streamLogs(serial, () => {}); await logReady.promise;
  let resets = 0; backend.resetAutomation = async () => { resets++; };
  const lease = await manager.acquireLease({ serial, owner: { kind: "agent", id: "ai:finished" } });
  const competitor = new HarmonyDeviceManager({ backend, configPath, arbitrationDirectory });
  t.after(() => competitor.dispose());
  await assert.rejects(competitor.acquireLease({ serial, owner: { kind: "agent", id: "other:window" } }), error => error.code === "DEVICE_BUSY");
  const recording = await manager.startRecording({ serial, ownerId });
  await manager.stopRecording({ serial, ownerId, recordingId: recording.recordingId });
  assert.equal(stops.length, 1);
  assert.equal(manager.releaseOwner("ai:finished"), 1);
  await waitFor(() => resets === 1 && manager.getState().controls.length === 0);
  assert.equal(video.closed(), 0, "ordinary agent cleanup must preserve the viewer after the GUI recording has already ended");
  assert.equal(logSignal.aborted, false, "read-only logs are independent of an input lease");
  assert.equal(manager.getState().devices.find(device => device.serial === serial).generation, lease.deviceEpoch);
  await video.send(3, Buffer.from("after-owner-release"));
  assert.equal((await manager.getFrameGeometry(serial, "video")).frameWidth, 1440, "new complete frames must still belong to the unchanged epoch");
  const next = await manager.startRecording({ serial, ownerId });
  await manager.stopRecording({ serial, ownerId, recordingId: next.recordingId });
  const acquired = await competitor.acquireLease({ serial, owner: { kind: "agent", id: "other:window" } });
  assert.ok(acquired.token, "verified input cleanup must safely release the physical arbitration lock");
  competitor.releaseOwner("other:window"); await waitFor(() => competitor.getState().controls.length === 0);
  assert.equal((await manager.stopDevice(serial)).cleanup, "complete");
  assert.equal(video.closed(), 1); assert.equal(logSignal.aborted, true); await logs;
});

test("owner release ends only that owner's recording while retaining its passive viewer", async t => {
  const { manager, backend, stops } = await fixture(t, { physicalLock: true });
  const video = await passiveView(t, manager, backend);
  const lease = await manager.acquireLease({ serial, owner: { kind: "agent", id: "ai:recording" } });
  await manager.startRecording({ serial, ownerId: "ai:recording", leaseToken: lease.token });
  manager.releaseOwner("ai:recording");
  await waitFor(() => manager.getState().controls.length === 0);
  assert.equal(stops.length, 1); assert.equal(manager.getRecordingState(serial), undefined);
  assert.equal(video.closed(), 0);
  assert.equal(manager.getState().devices.find(device => device.serial === serial).generation, lease.deviceEpoch);
  await video.send(3, Buffer.from("after-owned-recording-stop"));
});

test("explicit stop from the input-cleanup state event still upgrades the settling input-only promise", async t => {
  const { manager, backend } = await fixture(t, { physicalLock: true });
  const video = await passiveView(t, manager, backend);
  const lease = await manager.acquireLease({ serial, owner: { kind: "agent", id: "ai:listener" } });
  let requested = false, fullStop;
  manager.subscribe(event => {
    if (event.type === "state" && !requested && !manager.getState().leases.length) {
      requested = true; fullStop = manager.stopDevice(serial, "state-listener-explicit-stop");
    }
  });
  manager.releaseOwner("ai:listener");
  await waitFor(() => fullStop !== undefined); assert.equal((await fullStop).cleanup, "complete");
  assert.equal(video.closed(), 1, "an explicit stop must not reuse the completed input-only cleanup");
  assert.ok(manager.getState().devices.find(device => device.serial === serial).generation > lease.deviceEpoch);
});

test("owner release does not cancel or wait for a GUI recording still checking the device", async t => {
  let now = Date.now();
  const { manager, backend, state, notifications } = await fixture(t, { physicalLock: true, now: () => now });
  await manager.acquireLease({ serial, owner: { kind: "agent", id: "ai:preflight" } });
  now += 10_001;
  const checking = deferred(), checked = deferred(); let mediaSignal;
  t.after(() => checked.resolve());
  backend.listDevices = async signal => { mediaSignal = signal; checking.resolve(); await checked.promise; return structuredClone(state.devices); };
  const pending = manager.startRecording({ serial, ownerId });
  const observed = pending.catch(error => error);
  await checking.promise;
  assert.equal(notifications.length, 0, "ownership has not reached the backend recording yet");
  manager.releaseOwner("ai:preflight");
  await waitFor(() => manager.getState().controls.length === 0);
  assert.equal(mediaSignal.aborted, false);
  checked.resolve(); const recording = await observed;
  assert.equal(recording.ownerId, ownerId);
  assert.equal(notifications.length, 1);
  await manager.stopRecording({ serial, ownerId, recordingId: recording.recordingId });
});

test("input cleanup cannot clear an unrelated GUI recording's unknown cleanup state", async t => {
  const { manager, backend } = await fixture(t, { physicalLock: true });
  const reset = deferred(), resetting = deferred(); t.after(() => reset.resolve());
  backend.resetAutomation = async () => { resetting.resolve(); await reset.promise; };
  await manager.acquireLease({ serial, owner: { kind: "agent", id: "ai:release" } });
  const recording = await manager.startRecording({ serial, ownerId });
  const stop = backend.stopRecording;
  backend.stopRecording = async () => { throw new HarmonyError("COMMAND_TIMEOUT", "GUI recording close unconfirmed", { details: { cleanup: "uncertain" } }); };
  manager.releaseOwner("ai:release"); await resetting.promise;
  await assert.rejects(manager.stopRecording({ serial, ownerId, recordingId: recording.recordingId }), /close unconfirmed/);
  reset.resolve(); await nextTurn(); await nextTurn();
  assert.equal(manager.getRecordingState(serial).recordingId, recording.recordingId);
  assert.ok(manager.getState().controls.some(control => control.serial === serial && control.status === "recovering"));
  await assert.rejects(manager.acquireLease({ serial, owner: { kind: "agent", id: "ai:still-blocked" } }), error => error.code === "DEVICE_BUSY");
  backend.stopRecording = stop;
  await manager.stopRecording({ serial, ownerId, recordingId: recording.recordingId });
  assert.deepEqual(manager.getState().controls, []);
});

test("input-only cleanup keeps a late driver's physical lock and full stop upgrades it without stale unlock", async t => {
  const { manager, backend, state, configPath, arbitrationDirectory } = await fixture(t, { physicalLock: true, cleanupTimeoutMs: 20 });
  const video = await passiveView(t, manager, backend);
  const actionEntered = deferred(), finishAction = deferred(), resetEntered = deferred(), finishReset = deferred();
  t.after(() => { finishAction.resolve(); finishReset.resolve(); });
  const order = []; let actionSignal;
  state.tapHook = async (_serial, signal) => {
    actionSignal = signal; actionEntered.resolve(); await finishAction.promise; order.push("late-action-ended");
  };
  backend.resetAutomation = async () => { order.push("reset-started"); resetEntered.resolve(); await finishReset.promise; order.push("reset-ended"); };
  const lease = await manager.acquireLease({ serial, owner: { kind: "agent", id: "ai:late" } });
  const action = manager.tap({ serial, leaseToken: lease.token, x: 1, y: 2 }).catch(error => error);
  await actionEntered.promise; manager.releaseOwner("ai:late");
  assert.equal(actionSignal.aborted, true);
  await waitFor(() => manager.getState().controls.some(control => control.serial === serial && control.status === "recovering"));
  assert.deepEqual(order, [], "reset must not run before a driver that ignores abort has settled");
  assert.equal(video.closed(), 0);
  await assert.rejects(manager.acquireLease({ serial, owner: { kind: "agent", id: "ai:too-soon" } }), error => error.code === "DEVICE_BUSY");
  const competitor = new HarmonyDeviceManager({ backend, configPath, arbitrationDirectory });
  t.after(() => competitor.dispose());
  await assert.rejects(competitor.acquireLease({ serial, owner: { kind: "agent", id: "other:late" } }), error => error.code === "DEVICE_BUSY");
  const fullStop = manager.stopDevice(serial);
  await assert.rejects(manager.openVideoStream({ serial }), error => error.code === "DEVICE_BUSY");
  await nextTurn();
  assert.equal(video.closed(), 1, "full stop must close the viewer without waiting for the pending input cleanup");
  assert.equal((await fullStop).cleanup, "uncertain");
  finishAction.resolve(); await action; await resetEntered.promise;
  assert.deepEqual(order, ["late-action-ended", "reset-started"]);
  await assert.rejects(manager.acquireLease({ serial, owner: { kind: "agent", id: "ai:before-reset" } }), error => error.code === "DEVICE_BUSY");
  await assert.rejects(competitor.acquireLease({ serial, owner: { kind: "agent", id: "other:before-reset" } }), error => error.code === "DEVICE_BUSY");
  finishReset.resolve(); await waitFor(() => manager.getState().controls.length === 0);
  assert.deepEqual(order, ["late-action-ended", "reset-started", "reset-ended"]);
  const next = await competitor.acquireLease({ serial, owner: { kind: "agent", id: "other:released" } });
  assert.ok(next.token);
  competitor.releaseOwner("other:released"); await waitFor(() => competitor.getState().controls.length === 0);
});

for (const disconnected of [false, true]) {
  test(`a ${disconnected ? "disconnected" : "offline"} device closes its passive viewer without an active lease`, async t => {
    const { manager, backend, state } = await fixture(t);
    const video = await passiveView(t, manager, backend);
    if (disconnected) state.devices = state.devices.filter(device => device.serial !== serial);
    else state.devices.find(device => device.serial === serial).state = "offline";
    for (let attempt = 0; attempt < 4 && !video.closed(); attempt++) await manager.listDevices();
    await waitFor(() => video.closed() === 1);
  });
}

test("GUI recording starts and saves while an independent AI action remains in flight", async t => {
  const { manager, state, notifications, stops } = await fixture(t);
  state.observation.screenshot = { mimeType: "image/png", data: Buffer.from("png") };
  const entered = deferred(), finish = deferred();
  t.after(() => finish.resolve());
  let actionSignal;
  state.tapHook = async (_serial, signal) => { actionSignal = signal; entered.resolve(); await finish.promise; };
  const lease = await manager.acquireLease({ serial, owner: { kind: "agent", id: "ai:run" } });
  const action = manager.tap({ serial, leaseToken: lease.token, x: 1, y: 2 });
  const observedAction = action.catch(error => error);
  await entered.promise;
  const recording = await manager.startRecording({ serial, ownerId });
  const screenshot = await manager.captureScreenshotArtifact({ serial });
  assert.equal(screenshot.kind, "screenshot", "a screenshot bypasses the long AI action as well");
  assert.equal(actionSignal.aborted, false);
  assert.equal(manager.renewLease(lease.token).owner.id, "ai:run");
  const artifact = await manager.stopRecording({ serial, ownerId, recordingId: recording.recordingId });
  assert.equal(artifact.size, 5);
  assert.equal(actionSignal.aborted, false, "media stop must not interrupt the AI action");
  assert.equal(notifications.length, 1); assert.equal(stops.length, 1);
  finish.resolve(); assert.equal((await observedAction).receipt.dispatchState, "sent");
});

test("a GUI recording permits a new AI lease and survives its release during pending media startup", async t => {
  const { manager, backend, notifications, stops } = await fixture(t);
  const ready = deferred(), entered = deferred();
  t.after(() => ready.resolve());
  const start = backend.startRecording;
  backend.startRecording = async (...args) => { await start(...args); entered.resolve(); await ready.promise; };
  const pending = manager.startRecording({ serial, ownerId });
  await entered.promise;
  const lease = await manager.acquireLease({ serial, owner: { kind: "agent", id: "ai:pending" } });
  manager.releaseLease(lease.token);
  assert.equal(notifications[0].signal.aborted, false, "input cleanup must leave another owner's media startup alive");
  await waitFor(() => manager.getState().controls.length === 0);
  const nextLease = await manager.acquireLease({ serial, owner: { kind: "agent", id: "ai:next" } });
  assert.ok(nextLease.token, "an unrelated pending GUI startup must not delay verified input cleanup");
  ready.resolve(); const recording = await pending;
  await nextTurn();
  assert.equal(manager.getRecordingState(serial).recordingId, recording.recordingId);
  assert.equal(stops.length, 0);
  await manager.stopRecording({ serial, ownerId, recordingId: recording.recordingId });
});

test("media startup stays queued until a real frame confirmation, with one task across start and save", async t => {
  const { manager, backend, directory } = await fixture(t);
  const ready = deferred(), entered = deferred(), saved = deferred(), stopping = deferred();
  t.after(() => { ready.resolve(); saved.resolve(); });
  backend.startRecording = async () => { entered.resolve(); await ready.promise; };
  const stop = backend.stopRecording;
  backend.stopRecording = async (...args) => { stopping.resolve(); await saved.promise; return stop(...args); };
  const pending = manager.startRecording({ serial, ownerId });
  await entered.promise;
  const queued = manager.operationTasks.list(serial)[0];
  assert.equal(queued.status, "queued"); assert.equal(queued.phase, "starting");
  assert.equal(manager.getRecordingState(serial), undefined);
  assert.equal(new HarmonyOperationTasks(join(directory, "harmony-operation-tasks.json")).list(serial)[0].status, "interrupted");
  ready.resolve(); const recording = await pending;
  assert.equal(manager.operationTasks.list(serial)[0].id, queued.id);
  assert.equal(manager.operationTasks.list(serial)[0].phase, "recording");
  const ending = manager.stopRecording({ serial, ownerId, recordingId: recording.recordingId });
  await stopping.promise;
  assert.equal(manager.operationTasks.list(serial)[0].phase, "saving");
  saved.resolve(); const artifact = await ending;
  const completed = manager.operationTasks.list(serial);
  assert.equal(completed.length, 1); assert.equal(completed[0].id, queued.id);
  assert.equal(completed[0].status, "completed"); assert.equal(completed[0].verification, "media-saved");
  assert.equal(completed[0].mediaFilename, artifact.filename);
  assert.equal(new HarmonyOperationTasks(join(directory, "harmony-operation-tasks.json")).list(serial)[0].mediaFilename, artifact.filename);
});

test("one media lane rejects duplicate starts and owner or stale-id stops without changing AI ownership", async t => {
  const { manager, backend, stops } = await fixture(t);
  const ready = deferred(), entered = deferred();
  t.after(() => ready.resolve());
  backend.startRecording = async () => { entered.resolve(); await ready.promise; };
  const first = manager.startRecording({ serial, ownerId });
  await entered.promise;
  const duplicate = assert.rejects(manager.startRecording({ serial, ownerId: "gui:other" }), error => error.code === "DEVICE_BUSY");
  const lease = await manager.acquireLease({ serial, owner: { kind: "agent", id: "ai:parallel" } });
  ready.resolve(); const recording = await first; await duplicate;
  await assert.rejects(manager.stopRecording({ serial, ownerId: "gui:other", recordingId: recording.recordingId }), error => error.code === "DEVICE_BUSY");
  await assert.rejects(manager.stopRecording({ serial, ownerId, recordingId: "0".repeat(24) }), error => error.code === "STALE_SNAPSHOT");
  assert.equal(manager.renewLease(lease.token).owner.id, "ai:parallel"); assert.equal(stops.length, 0);
  assert.deepEqual(manager.operationTasks.list(serial).map(task => task.status).sort(), ["failed", "running"]);
  await manager.stopRecording({ serial, ownerId, recordingId: recording.recordingId });
});

test("explicit device stop escalates a bounded input-only cleanup and still closes the GUI recording", async t => {
  const { manager, backend, stops } = await fixture(t, { cleanupTimeoutMs: 10 });
  const reset = deferred(), entered = deferred();
  t.after(() => reset.resolve());
  backend.resetAutomation = async () => { entered.resolve(); await reset.promise; };
  await manager.startRecording({ serial, ownerId });
  const lease = await manager.acquireLease({ serial, owner: { kind: "agent", id: "ai:cleanup" } });
  manager.releaseLease(lease.token);
  await entered.promise;
  const stop = manager.stopDevice(serial);
  const outcome = await stop;
  assert.equal(outcome.cleanup, "uncertain", "the pending input reset still needs review");
  await nextTurn();
  assert.equal(stops.length, 1, "escalation closes media even if the previous bounded cleanup is reused");
  await waitFor(() => manager.getRecordingState(serial) === undefined);
  assert.equal(manager.getRecordingState(serial), undefined);
  reset.resolve(); await waitFor(() => manager.getState().controls.length === 0);
  assert.deepEqual(manager.getState().controls, []);
  await manager.acquireLease({ serial, owner: { kind: "agent", id: "ai:after-cleanup" } });
});

test("runtime media failure and a racing user stop perform one close; old callbacks cannot touch the next recording", async t => {
  const { manager, backend, notifications, stops } = await fixture(t);
  const closing = deferred(), entered = deferred();
  t.after(() => closing.resolve());
  const stop = backend.stopRecording;
  backend.stopRecording = async (...args) => { stops.push(args[1]); entered.resolve(); await closing.promise;
    throw new HarmonyError("COMMAND_FAILED", "Encoder ended", { details: { recordingStopped: true } }); };
  const first = await manager.startRecording({ serial, ownerId });
  const failed = new HarmonyError("COMMAND_FAILED", "Encoder ended", { details: { recordingStopped: true } });
  notifications[0].onFailure(failed);
  const userStop = assert.rejects(manager.stopRecording({ serial, ownerId, recordingId: first.recordingId }));
  await entered.promise; closing.resolve(); await userStop; await nextTurn();
  assert.equal(stops.length, 1); assert.equal(manager.operationTasks.list(serial)[0].status, "failed");
  backend.stopRecording = stop;
  const next = await manager.startRecording({ serial, ownerId });
  notifications[0].onFailure(failed); await nextTurn();
  assert.equal(manager.getRecordingState(serial).recordingId, next.recordingId);
  assert.equal(manager.operationTasks.list(serial)[0].status, "running");
  await manager.stopRecording({ serial, ownerId, recordingId: next.recordingId });
});

test("failure reported before startup returns never becomes an apparently running task", async t => {
  const { manager, backend } = await fixture(t);
  backend.startRecording = async (_serial, _name, _signal, onFailure) => {
    onFailure(new HarmonyError("DEVICE_OFFLINE", "Stream ended", { details: { recordingStopped: true } }));
  };
  await assert.rejects(manager.startRecording({ serial, ownerId }), error => error.code === "DEVICE_OFFLINE");
  await nextTurn();
  assert.equal(manager.operationTasks.list(serial)[0].status, "interrupted");
  assert.equal(manager.getRecordingState(serial), undefined);
});

test("unknown media release remains reviewable until a subsequent stop confirms closure", async t => {
  const { manager, backend } = await fixture(t);
  const stop = backend.stopRecording;
  backend.stopRecording = async () => { throw new HarmonyError("COMMAND_TIMEOUT", "Close not confirmed", { details: { cleanup: "uncertain" } }); };
  const recording = await manager.startRecording({ serial, ownerId });
  await assert.rejects(manager.stopRecording({ serial, ownerId, recordingId: recording.recordingId }), error => error.code === "COMMAND_TIMEOUT");
  assert.equal(manager.getRecordingState(serial).recordingId, recording.recordingId);
  assert.equal(manager.operationTasks.list(serial)[0].status, "interrupted");
  await assert.rejects(manager.acquireLease({ serial, owner: { kind: "agent", id: "ai:blocked" } }), error => error.code === "DEVICE_BUSY");
  backend.stopRecording = stop;
  await manager.stopRecording({ serial, ownerId, recordingId: recording.recordingId });
  assert.equal(manager.operationTasks.list(serial)[0].status, "completed");
  await manager.acquireLease({ serial, owner: { kind: "agent", id: "ai:released" } });
});

test("offline discovery reclaims passive recording without an input lease and journals its incomplete outcome", async t => {
  const { manager, backend, state } = await fixture(t);
  const ended = deferred();
  backend.stopRecording = async () => { ended.resolve(); throw new HarmonyError("DEVICE_OFFLINE", "USB stream ended", { details: { recordingStopped: true } }); };
  await manager.startRecording({ serial, ownerId });
  state.devices[0].state = "offline";
  await manager.listDevices(); await ended.promise; await nextTurn();
  assert.equal(manager.getRecordingState(serial), undefined);
  assert.equal(manager.operationTasks.list(serial)[0].status, "interrupted");
  assert.equal(manager.operationTasks.list(serial)[0].errorCode, "DEVICE_OFFLINE");
});

test("screenshots journal both saved evidence and capture failure without revoking the AI lease", async t => {
  const { manager, state, backend, directory } = await fixture(t);
  state.observation.screenshot = { mimeType: "image/png", data: Buffer.from("png") };
  const lease = await manager.acquireLease({ serial, owner: { kind: "agent", id: "ai:shot" } });
  const artifact = await manager.captureScreenshotArtifact({ serial });
  assert.equal((await readFile(artifact.path)).toString(), "png");
  assert.equal(manager.operationTasks.list(serial)[0].mediaFilename, artifact.filename);
  backend.snapshot = async () => { throw new HarmonyError("COMMAND_FAILED", "Screenshot capture failed"); };
  await assert.rejects(manager.captureScreenshotArtifact({ serial }), error => error.code === "COMMAND_FAILED");
  assert.equal(manager.operationTasks.list(serial)[0].kind, "screenshot");
  assert.equal(manager.operationTasks.list(serial)[0].status, "failed");
  assert.equal(manager.renewLease(lease.token).owner.id, "ai:shot");
  const journal = await readFile(join(directory, "harmony-operation-tasks.json"), "utf8");
  assert.equal(journal.includes(lease.token), false);
});

test("desktop-authenticated media routes use passive ownership and task routes expose the full durable lifecycle", async t => {
  const { manager, state, backend } = await fixture(t);
  state.observation.screenshot = { mimeType: "image/png", data: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=", "base64"), width: 1, height: 1 };
  const saved = { manager: globalThis.__pioraHarmonyDeviceManager, transfers: globalThis.__pioraHarmonyTransferJobs,
    databases: globalThis.__pioraHarmonyDatabaseExportJobs, token: process.env.PI_DESKTOP_TOKEN };
  globalThis.__pioraHarmonyDeviceManager = manager;
  globalThis.__pioraHarmonyTransferJobs = { list() { return []; } };
  globalThis.__pioraHarmonyDatabaseExportJobs = { list() { return []; } };
  process.env.PI_DESKTOP_TOKEN = "a".repeat(64);
  const headers = { host: "localhost:30141", "content-type": "application/json", "x-pi-desktop-token": process.env.PI_DESKTOP_TOKEN };
  const media = await jiti.import("../app/api/harmony/media/route.ts");
  const tasks = await jiti.import("../app/api/harmony/tasks/route.ts");
  const request = body => new Request("http://localhost:30141/api/harmony/media", { method: "POST", headers, body: JSON.stringify({ serial, ...body }) });
  const get = target => new Request(`http://localhost:30141/api/harmony/${target}?serial=${serial}`, { headers });
  const ready = deferred(), entered = deferred();
  try {
    const lease = await manager.acquireLease({ serial, owner: { kind: "agent", id: "ai:route" } });
    backend.startRecording = async () => { entered.resolve(); await ready.promise; };
    const beginning = media.POST(request({ action: "start_recording", ownerId }));
    await entered.promise;
    assert.equal((await (await media.GET(get("media"))).json()).recording, null);
    const active = (await (await tasks.GET(get("tasks"))).json()).tasks[0];
    assert.equal(active.status, "queued"); assert.equal(active.operation.phase, "starting");
    ready.resolve(); const response = await beginning;
    assert.equal(response.status, 200); const recording = (await response.json()).recording;
    assert.equal((await media.POST(request({ action: "stop_recording", ownerId, recordingId: "stale" }))).status, 409);
    assert.equal((await media.POST(request({ action: "capture_screenshot" }))).status, 200);
    const stopped = await media.POST(request({ action: "stop_recording", ownerId, recordingId: recording.recordingId }));
    assert.equal(stopped.status, 200);
    const overview = await (await tasks.GET(get("tasks"))).json();
    assert.deepEqual(overview.counts, { all: 2, active: 0, completed: 2, attention: 0 });
    assert.equal(overview.tasks.filter(task => task.operation.kind === "recording")[0].id, active.id);
    assert.equal(overview.tasks.some(task => JSON.stringify(task).includes(lease.token)), false);
    assert.equal(manager.renewLease(lease.token).owner.id, "ai:route");
  } finally {
    ready.resolve();
    globalThis.__pioraHarmonyDeviceManager = saved.manager;
    globalThis.__pioraHarmonyTransferJobs = saved.transfers;
    globalThis.__pioraHarmonyDatabaseExportJobs = saved.databases;
    if (saved.token === undefined) delete process.env.PI_DESKTOP_TOKEN; else process.env.PI_DESKTOP_TOKEN = saved.token;
  }
});
