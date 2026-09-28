import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createJiti } from "jiti";
import { controlledBackend, deferred } from "./harmony/fixtures/controlled-backend.mjs";

const jiti = createJiti(import.meta.url);
const { HarmonyDeviceManager } = await jiti.import("./harmony/device-manager.ts");
const { HarmonyRecoveryStore } = await jiti.import("./harmony/runtime/recovery-store.ts");
const { HarmonyError } = await jiti.import("./harmony/errors.ts");
const owner = { kind: "manual", id: "recording-test" };

async function removeFixture(directory) {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.match(directory, /piora-(recording|video)-/);
  await rm(directory, { recursive: true, force: true });
}

async function startRecording(manager, lease) {
  const start = () => manager.startRecording({ serial: lease.serial, leaseToken: lease.token, ownerId: owner.id });
  return start();
}

for (const resources of [{ recording: "active" }, { recording: "uncertain" }, { input: "uncertain", recording: "active" }]) {
  test(`restart automatically recovers recording-only ownership: ${JSON.stringify(resources)}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "piora-recording-recovery-"));
    const recoveryDirectory = join(directory, "harmony-recovery");
    let manager;
    try {
      const store = new HarmonyRecoveryStore(recoveryDirectory);
      for (const [kind, state] of Object.entries(resources)) store.record("phone-1", kind, state);
      const journal = join(recoveryDirectory, (await readdir(recoveryDirectory))[0]);
      const record = JSON.parse(await readFile(journal, "utf8"));
      record.processId = Number(execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }));
      await writeFile(journal, JSON.stringify(record));
      const { backend } = controlledBackend();
      let recordings = 0;
      backend.startRecording = async () => { recordings++; };
      backend.stopRecording = async () => 0;
      manager = new HarmonyDeviceManager({ backend, configPath: join(directory, "harmony.json") });
      if (resources.input) {
        await assert.rejects(manager.acquireLease({ serial: "phone-1", owner }), error => error.code === "DEVICE_BUSY");
        assert.deepEqual(JSON.parse(await readFile(journal, "utf8")).resources, { input: "uncertain" });
        assert.equal(recordings, 0);
      } else {
        const lease = await manager.acquireLease({ serial: "phone-1", owner });
        assert.deepEqual(await readdir(recoveryDirectory), []);
        await startRecording(manager, lease);
        assert.equal(recordings, 1, "a fresh recording starts without manual cleanup confirmation");
      }
    } finally { await manager?.dispose(); await removeFixture(directory); }
  });
}

for (const stopViewer of [false, true, "after-control"]) test(`a passive video close error does not fence input, including viewer shutdown: ${stopViewer}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-video-close-"));
  const { backend } = controlledBackend();
  backend.openVideoStream = async () => ({ stream: new ReadableStream(), async close() {
    throw new HarmonyError("DEVICE_BUSY", "Owned forward cleanup failed", { details: { cleanup: "uncertain", localPort: 50123 } });
  } });
  let recordings = 0;
  backend.startRecording = async () => { recordings++; };
  backend.stopRecording = async () => 0;
  const manager = new HarmonyDeviceManager({ backend, configPath: join(directory, "harmony.json") });
  try {
    if (stopViewer === "after-control") await manager.acquireLease({ serial: "phone-1", owner });
    const video = await manager.openVideoStream({ serial: "phone-1" });
    if (stopViewer) assert.equal((await manager.stopDevice("phone-1")).cleanup, "uncertain", "the forward cleanup warning remains accurate");
    else await assert.rejects(video.close(), error => error.details?.localPort === 50123);
    assert.deepEqual(manager.getState().controls, []);
    assert.deepEqual(await readdir(join(directory, "harmony-recovery")), []);
    const lease = await manager.acquireLease({ serial: "phone-1", owner });
    await startRecording(manager, lease);
    assert.equal(recordings, 1);
  } finally { await manager.dispose(); await removeFixture(directory); }
});

test("successful cleanup after its deadline automatically permits a new recording", async () => {
  const { backend } = controlledBackend();
  const finish = deferred();
  backend.resetAutomation = () => finish.promise;
  let recordings = 0;
  backend.startRecording = async () => { recordings++; };
  backend.stopRecording = async () => 0;
  const manager = new HarmonyDeviceManager({ backend, cleanupTimeoutMs: 10 });
  try {
    await manager.acquireLease({ serial: "phone-1", owner });
    const receipt = await manager.stopDevice("phone-1");
    assert.equal(receipt.cleanup, "uncertain");
    await assert.rejects(manager.acquireLease({ serial: "phone-1", owner }), error => error.code === "DEVICE_BUSY");
    finish.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(manager.getState().controls, []);
    await startRecording(manager, await manager.acquireLease({ serial: "phone-1", owner }));
    assert.equal(recordings, 1);
  } finally { finish.resolve(); await manager.dispose(); }
});

for (const cleanup of ["complete", "uncertain", "device-stop"]) test(`a stopped recording reports save/forward failure without fencing input: ${cleanup}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-recording-save-"));
  const { backend } = controlledBackend();
  let recordings = 0;
  backend.startRecording = async () => { recordings++; };
  backend.stopRecording = async () => { throw new HarmonyError("COMMAND_FAILED", "MP4 finalization failed", { details: { recordingStopped: true, cleanup } }); };
  const manager = new HarmonyDeviceManager({ backend, configPath: join(directory, "harmony.json") });
  try {
    let lease = await manager.acquireLease({ serial: "phone-1", owner });
    await startRecording(manager, lease);
    if (cleanup === "device-stop") assert.equal((await manager.stopDevice("phone-1")).cleanup, "uncertain");
    else await assert.rejects(manager.stopRecording({ serial: "phone-1", ownerId: owner.id }), /MP4 finalization failed/);
    assert.equal(manager.getRecordingState("phone-1"), undefined);
    assert.deepEqual(manager.getState().controls, []);
    assert.deepEqual(await readdir(join(directory, "harmony-recovery")), []);
    if (cleanup === "device-stop") lease = await manager.acquireLease({ serial: "phone-1", owner });
    await startRecording(manager, lease);
    assert.equal(recordings, 2);
  } finally { await manager.dispose(); await removeFixture(directory); }
});

test("cancelled recording startup with a closed reader does not become uncertain phone input", async () => {
  const { backend } = controlledBackend();
  backend.startRecording = async () => { throw new HarmonyError("DEVICE_BUSY", "Forward removal failed", { details: { recordingStopped: true, cleanup: "uncertain" } }); };
  const manager = new HarmonyDeviceManager({ backend });
  try {
    const lease = await manager.acquireLease({ serial: "phone-1", owner });
    await assert.rejects(startRecording(manager, lease), /Forward removal failed/);
    assert.equal(manager.getRecordingState("phone-1"), undefined);
    assert.deepEqual(manager.getState().controls, []);
    backend.startRecording = async () => {};
    backend.stopRecording = async () => 0;
    assert.ok(await startRecording(manager, lease));
  } finally { await manager.dispose(); }
});

test("automatic cleanup completion never overrides unknown physical input release", async () => {
  const { backend } = controlledBackend();
  backend.resetAutomation = async () => {};
  const manager = new HarmonyDeviceManager({ backend });
  manager.executeVoice = async () => { throw new HarmonyError("COMMAND_FAILED", "release failed", { details: { cleanup: "uncertain", dispatchState: "unknown" } }); };
  try {
    const lease = await manager.acquireLease({ serial: "phone-1", owner });
    await manager.runScenario({ serial: "phone-1", leaseToken: lease.token, steps: [{ action: "voice_input", audioAssetId: "a".repeat(64), profileId: "b".repeat(64) }] }).catch(() => undefined);
    assert.equal((await manager.stopDevice("phone-1")).cleanup, "uncertain");
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(manager.acquireLease({ serial: "phone-1", owner }), error => error.code === "DEVICE_BUSY");
  } finally { await manager.dispose(); }
});
