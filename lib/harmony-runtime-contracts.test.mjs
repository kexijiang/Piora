import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, writeFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { observationPage } = await jiti.import("./harmony/observation/page.ts");
const { readBoundedRegularFile, enforceArtifactQuota } = await jiti.import("./harmony/runtime/bounded-file.ts");
const { HarmonyRecoveryStore } = await jiti.import("./harmony/runtime/recovery-store.ts");
const { runHarmonyScenario } = await jiti.import("./harmony/scenario-executor.ts");
const { HarmonyError } = await jiti.import("./harmony/errors.ts");
const { runVoiceInput } = await jiti.import("./harmony/audio/audio-session.ts");

test("observation pages bind filters, region and epoch while providing bounded ancestor context", () => {
  const snapshot = { serial: "phone", generation: 1, revision: 4, nodes: [
    { ref: "root", id: "list" }, { ref: "1", parentRef: "root", text: "row", bounds: { left: 0, top: 0, right: 100, bottom: 20 } },
    { ref: "2", parentRef: "root", text: "row", bounds: { left: 0, top: 20, right: 100, bottom: 40 } },
  ] };
  const options = { selector: { text: "row" }, limit: 1, ancestors: true };
  const first = observationPage(snapshot, options);
  assert.equal(first.nodes[0].ref, "1"); assert.equal(first.ancestors[0].ref, "root");
  assert.equal(observationPage(snapshot, { ...options, cursor: first.nextCursor }).nodes[0].ref, "2");
  assert.throws(() => observationPage(snapshot, { ...options, selector: { text: "different" }, cursor: first.nextCursor }), /cursor/);
  assert.throws(() => observationPage({ ...snapshot, generation: 2 }, { ...options, cursor: first.nextCursor }), /cursor/);
  assert.equal(observationPage(snapshot, { region: { left: 0, top: 25, right: 90, bottom: 35 } }).nodes[0].ref, "2");
});

test("artifact bounds and retention affect only generated private copies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harmony-quota-"));
  try {
    const owned = join(directory, `${"a".repeat(64)}.wav`), user = join(directory, "keep.wav");
    await writeFile(owned, "old"); await writeFile(user, "user");
    const old = new Date(Date.now() - 31 * 86400000); await utimes(owned, old, old); await utimes(user, old, old);
    await assert.rejects(readBoundedRegularFile(user, 2), /bounded/);
    assert.equal((await readBoundedRegularFile(user, 4)).toString(), "user");
    await enforceArtifactQuota(directory, "wav", 10);
    assert.deepEqual(await readdir(directory), ["keep.wav"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("recovery journal distinguishes live ownership from a positively exited process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harmony-recovery-"));
  try {
    const store = new HarmonyRecoveryStore(directory); store.record("phone", "input", "active"); assert.deepEqual(store.interrupted(), []);
    const file = join(directory, (await readdir(directory))[0]);
    const record = JSON.parse(await readFile(file, "utf8"));
    record.processId = Number(execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8", windowsHide: true }));
    await writeFile(file, JSON.stringify(record));
    assert.equal(store.interrupted()[0].serial, "phone"); store.clear("phone"); assert.deepEqual(store.interrupted(), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("cancellation journals a possibly dispatched step before unwinding the scenario", async () => {
  const controller = new AbortController(), updates = []; let taps = 0;
  const context = { serial: "phone", generation: 4, leaseEpoch: 2, signal: controller.signal,
    backend: { kind: "test", async tap() { taps++; controller.abort(); throw new Error("transport cancelled after dispatch"); } },
    capture: async () => ({ nodes: [{ ref: "a", id: "tap", bounds: { left: 0, top: 0, right: 100, bottom: 100 } }] }),
    invalidateSnapshot() {}, onStep: step => updates.push(step),
  };
  await assert.rejects(runHarmonyScenario({ serial: "phone", leaseToken: "x", steps: [{ action: "tap", selector: { id: "tap" } }, { action: "tap", selector: { id: "tap" } }] }, context));
  assert.equal(taps, 1); assert.equal(updates[0].status, "running"); assert.equal(updates.at(-1).receipt.dispatchState, "unknown"); assert.equal(updates.at(-1).receipt.leaseEpoch, 2);
});

test("delayed listening readiness rejects playback when the calibrated hold cannot cover audio plus tail", async () => {
  const started = Date.now(); let plays = 0, releases = 0;
  const profile = { targetAppId: "com.test", entry: { id: "mic" }, ready: { id: "ready" }, result: { text: "expected" }, mode: "push-to-talk", holdDurationMs: 1100 };
  const context = { serial: "phone", signal: new AbortController().signal, backend: {}, beforeDispatch() {},
    capture: async () => ({ quality: { treeStatus: "valid", scopeComplete: true, scope: "window", appId: "com.test", windowId: "1" }, nodes: [{ ref: "mic", id: "mic", bounds: { left: 0, top: 0, right: 100, bottom: 100 } }, ...(Date.now() - started > 600 ? [{ ref: "ready", id: "ready" }] : [])] }),
    play: async () => { plays++; },
    hold: async (_point, duration, signal) => new Promise(resolve => { const timer = setTimeout(resolve, duration); signal.addEventListener("abort", () => { clearTimeout(timer); releases++; resolve(); }, { once: true }); }),
  };
  await assert.rejects(runVoiceInput(profile, { hash: "audio", durationMs: 100 }, context, 2000), /budget/);
  assert.equal(plays, 0); assert.equal(releases, 1);
});


test("idle provider failure is retained as a dispatched scenario failure", async () => {
  const context = { serial: "phone", generation: 1, signal: new AbortController().signal,
    backend: { kind: "test", async tap() {}, async waitForIdle() { throw new HarmonyError("COMMAND_FAILED", "idle provider disconnected"); } },
    capture: async () => ({ nodes: [{ ref: "target", id: "target", bounds: { left: 0, top: 0, right: 10, bottom: 10 } }] }), invalidateSnapshot() {},
  };
  const result = await runHarmonyScenario({ serial: "phone", leaseToken: "x", steps: [{ action: "tap", selector: { id: "target" } }, { action: "checkpoint", name: "must-not-pass" }] }, context);
  assert.equal(result.status, "failed"); assert.match(result.steps[0].message, /idle provider disconnected/); assert.equal(result.steps[0].receipt.dispatchState, "unknown"); assert.equal(result.steps[1].status, "not-run");
});

test("voice recovery cleanup does not erase a concurrent owned recording journal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harmony-mixed-resources-"));
  try {
    const store = new HarmonyRecoveryStore(directory); store.record("phone", "recording", "active"); store.record("phone", "input", "active"); store.clear("phone", "input");
    const record = JSON.parse(await readFile(join(directory, (await readdir(directory))[0]), "utf8"));
    assert.deepEqual(record.resources, { recording: "active" }); store.clear("phone", "recording"); assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("scroll search shares a 60-swipe budget across steps", async () => {
  let swipes = 0;
  const context = { serial: "phone", generation: 1, signal: new AbortController().signal,
    backend: { kind: "test", async swipe() { swipes++; }, async waitForIdle() {} }, invalidateSnapshot() {},
    capture: async () => ({ nodes: [{ ref: "list", id: "list", bounds: { left: 0, top: 0, right: 100, bottom: 200 } }, ...(swipes === 30 ? [{ ref: "a", id: "first" }] : []), ...(swipes === 60 ? [{ ref: "b", id: "second" }] : [])] }),
  };
  const result = await runHarmonyScenario({ serial: "phone", leaseToken: "x", steps: ["first", "second", "third"].map(id => ({ action: "scroll_find", selector: { id }, maxSwipes: 30 })) }, context);
  assert.equal(swipes, 60); assert.equal(result.steps[0].status, "passed"); assert.equal(result.steps[1].status, "passed"); assert.match(result.steps[2].message, /cumulative/);
});

test("doctor caches probes by epoch and downgrades a real failure until explicit reprobe", async () => {
  const { controlledBackend } = await import("./harmony/fixtures/controlled-backend.mjs");
  const { HarmonyDeviceManager } = await jiti.import("./harmony/device-manager.ts");
  const { HarmonyError } = await jiti.import("./harmony/errors.ts");
  const { backend } = controlledBackend(); let probes = 0;
  backend.probeCapabilities = async () => { probes++; return [{ action: "press_key", status: "supported", provider: "fixture", evidence: "probed", reason: "help" }]; };
  backend.pressKey = async () => { throw new HarmonyError("COMMAND_FAILED", "actual provider failure"); };
  const manager = new HarmonyDeviceManager({ backend });
  try {
    const lease = await manager.acquireLease({ serial: "phone-1", owner: { kind: "manual", id: "test" } });
    await manager.doctor("phone-1"); await manager.doctor("phone-1"); assert.equal(probes, 1);
    await assert.rejects(manager.pressKey({ serial: "phone-1", leaseToken: lease.token, key: "back" }));
    assert.equal((await manager.doctor("phone-1")).capabilities[0].status, "unavailable");
    assert.equal((await manager.doctor("phone-1", undefined, true)).capabilities[0].status, "supported"); assert.equal(probes, 2);
  } finally { await manager.dispose(); }
});


test("scenario voice release uncertainty blocks subsequent control", async () => {
  const { controlledBackend } = await import("./harmony/fixtures/controlled-backend.mjs");
  const { HarmonyDeviceManager } = await jiti.import("./harmony/device-manager.ts");
  const { backend } = controlledBackend(); const manager = new HarmonyDeviceManager({ backend });
  manager.executeVoice = async () => { throw new HarmonyError("COMMAND_FAILED", "release failed", { details: { cleanup: "uncertain", dispatchState: "unknown" } }); };
  try {
    const lease = await manager.acquireLease({ serial: "phone-1", owner: { kind: "manual", id: "voice" } });
    const result = await manager.runScenario({ serial: "phone-1", leaseToken: lease.token, steps: [{ action: "voice_input", audioAssetId: "a".repeat(64), profileId: "b".repeat(64) }] }).catch(error => error);
    assert.notEqual(result.status, "passed");
    await assert.rejects(manager.acquireLease({ serial: "phone-1", owner: { kind: "manual", id: "later" } }), error => error.code === "DEVICE_BUSY");
    assert.equal((await manager.confirmCleanup("phone-1")).cleanup, "manual-confirmed");
  } finally { await manager.dispose(); }
});

test("ambiguous semantic capability failures cannot trigger a coordinate retry", async () => {
  let taps = 0;
  const context = { serial: "phone", generation: 1, signal: new AbortController().signal,
    backend: { kind: "test", async semanticAction() { throw new HarmonyError("CAPABILITY_UNAVAILABLE", "provider state unknown", { details: { dispatchState: "unknown" } }); }, async tap() { taps++; } },
    capture: async () => ({ nodes: [{ ref: "a", id: "target", bounds: { left: 0, top: 0, right: 10, bottom: 10 } }] }), invalidateSnapshot() {},
  };
  const result = await runHarmonyScenario({ serial: "phone", leaseToken: "x", steps: [{ action: "tap", selector: { id: "target" } }] }, context);
  assert.equal(result.status, "failed"); assert.equal(taps, 0);
});

test("video cleanup failure remains visible and preserves the exact owned forward journal", async () => {
  const { createServer } = await import("node:net");
  const { HdcBackend } = await jiti.import("./harmony/hdc-backend.ts");
  const directory = await mkdtemp(join(tmpdir(), "harmony-forward-"));
  const sockets = new Set(); const server = createServer(socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  const calls = [];
  const backend = new HdcBackend({ hdcPath: process.execPath, forwardJournalDirectory: directory,
    findDebugVideoJar: async () => undefined, // This contract exercises the bundled HAP forward, regardless of the host's SDK installation.
    execute: async ({ args }) => {
      calls.push(args);
      if (args.includes("fport")) {
        if (args.includes("rm")) throw new HarmonyError("COMMAND_FAILED", "disconnect during forward removal");
        const port = Number(args[3].slice(4));
        await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
      }
      return { stdout: Buffer.from(args.includes("bm") ? "com.ohos.scrcpy.server" : "screenLocked: false"), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
    },
  });
  try {
    const video = await backend.openVideoStream("phone");
    await assert.rejects(video.close(), error => error.details?.cleanup === "uncertain");
    await assert.rejects(video.close(), error => error.details?.cleanup === "uncertain");
    const record = JSON.parse(await readFile(join(directory, (await readdir(directory))[0]), "utf8"));
    assert.equal(record.state, "established"); assert.equal(record.remotePort, 53535); assert.ok(record.localPort > 0);
    assert.equal(calls.filter(args => args.includes("rm")).length, 1); assert.ok(calls.every(args => !args.includes("uinput") && !args.includes("aa")));
  } finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); await backend.dispose(); await rm(directory, { recursive: true, force: true }); }
});
