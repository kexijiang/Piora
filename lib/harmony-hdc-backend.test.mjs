import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import JSZip from "jszip";

const jiti = createJiti(import.meta.url);
const { HdcBackend } = await jiti.import("./harmony/hdc-backend.ts");
const { HarmonyError } = await jiti.import("./harmony/errors.ts");

const HDC = "C:\\HarmonySDK\\toolchains\\hdc.exe";

function png(width = 1080, height = 2400) {
  const data = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

function backendWith(execute, overrides = {}) {
  return new HdcBackend({
    hdcPath: HDC,
    resolve: { platform: "win32", exists: (path) => path === HDC, listDirectory: () => [], config: { video: { provider: "bundled" } } },
    execute,
    ...overrides,
  });
}

async function mirrorHap(directory, bundleName = "com.ohos.scrcpy.server") {
  const path = join(directory, "capture-component.hap");
  const zip = new JSZip();
  zip.file("module.json", JSON.stringify({ app: { bundleName, versionCode: 1000100, versionName: "1.1.0" }, module: { name: "entry", abilities: [{ name: "EntryAbility" }], requestPermissions: [{ name: "ohos.permission.INTERNET" }] } }));
  writeFileSync(path, await zip.generateAsync({ type: "nodebuffer" }));
  return path;
}

test("unplug and partial reconnect retain per-device model names while refreshing live capabilities", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  let listing = "phone USB Connected unknown... hdc\n", ready = true, probes = 0;
  const backend = backendWith(async ({ args }) => {
    if (args[0] === "list") return { stdout: Buffer.from(listing), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
    probes++;
    const values = ready ? { "const.product.model": "ALN-AL00", "const.product.marketname": "HUAWEI Mate 60 Pro", "const.product.name": "ALN", "--version": "6.1.0.0" } : {};
    return { stdout: Buffer.from(values[args.at(-1)] ?? ""), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
  });
  assert.equal((await backend.listDevices())[0].product, "HUAWEI Mate 60 Pro");
  listing = "phone USB Offline unknown... hdc\n";
  const [offline] = await backend.listDevices();
  assert.equal(offline.model, "ALN-AL00");
  assert.equal(offline.state, "offline");
  assert.equal(offline.capabilities.screenshot, false);
  listing = ""; assert.deepEqual(await backend.listDevices(), []);
  ready = false;
  listing = "phone USB Connected unknown... hdc\ntablet USB Connected unknown... hdc\n";
  const [phone, tablet] = await backend.listDevices();
  assert.equal(phone.product, "HUAWEI Mate 60 Pro");
  assert.equal(tablet.model, undefined, "a new tablet must not inherit the unplugged phone's identity");
  const before = probes;
  ready = true;
  await backend.listDevices();
  assert.equal(probes, before, "concurrent viewers reuse a short metadata cache");
  t.mock.timers.tick(2_001);
  assert.equal((await backend.listDevices())[0].capabilities.screenshot, true);
  assert.ok(probes > before, "partial metadata is retried without waiting 30 seconds");
});

test("a Connected target with explicit HDC channel failures is unconfirmed and reprobed on recovery", async () => {
  let pending = true;
  let probes = 0;
  const backend = backendWith(async ({ args }) => {
    if (args[0] === "list") return { stdout: Buffer.from("phone USB Connected unknown... hdc\n"), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
    probes++;
    if (pending) return { stdout: Buffer.from("[Fail][E000004]:The communication channel is being established.\r\n"),
      stderr: Buffer.from("[F][2026-09-30 19:29:28] Send hChannel nullptr channelId:45868981\r\n"), exitCode: 0, durationMs: 1 };
    const command = args.slice(3).join(" ");
    const values = { "param get const.product.model": "ALN-AL00", "param get const.ohos.apiversion": "26", "uitest --version": "6.1.0.0" };
    return { stdout: Buffer.from(values[command] ?? ""), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
  });
  const [unconfirmed] = await backend.listDevices();
  assert.equal(unconfirmed.state, "unknown", "a host transport listing does not prove a usable device channel");
  assert.equal(unconfirmed.connectionIssue, "hdc-channel-not-ready");
  assert.equal(unconfirmed.responseSample, undefined);
  pending = false;
  const beforeRecovery = probes;
  const [recovered] = await backend.listDevices();
  assert.ok(probes > beforeRecovery, "failed channel metadata must not stay in the online cache");
  assert.equal(recovered.state, "online");
  assert.equal(recovered.connectionIssue, undefined);
  assert.equal(recovered.apiVersion, "26");
  assert.equal(recovered.responseSample.durationMs, 1);
  pending = true;
  await assert.rejects(backend.applications("phone"), error => error.code === "COMMAND_FAILED" && error.details?.reason === "hdc-channel-not-ready");
  const beforeInterruptedRefresh = probes;
  const [interrupted] = await backend.listDevices();
  assert.ok(probes > beforeInterruptedRefresh, "a later channel failure invalidates an otherwise fresh online cache");
  assert.equal(interrupted.state, "unknown");
});

for (const apiFailure of ["[Fail]Permission denied", "param: invalid parameter", "[Fail][E000004]:The communication channel is being established."]) {
  test(`valid metadata keeps a phone online despite an optional parameter failure: ${apiFailure}`, async () => {
    const backend = backendWith(async ({ args }) => {
      const value = args[0] === "list" ? "phone USB Connected unknown... hdc\n"
        : args.includes("const.ohos.apiversion") ? apiFailure : args.includes("const.product.model") ? "ALN-AL00" : "";
      return { stdout: Buffer.from(value), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
    });
    const [device] = await backend.listDevices();
    assert.equal(device.state, "online");
    assert.equal(device.model, "ALN-AL00");
    assert.equal(device.connectionIssue, undefined);
    assert.equal(device.responseSample, undefined);
  });
}

test("viewing and recording always use the same bundled encoder", async () => {
  const backend = backendWith(async () => { throw new Error("Unexpected device command"); });
  backend.openBundledVideoStream = () => { throw new Error("Legacy HAP capture must never run"); };
  backend.startSystemRecording = () => { throw new Error("The phone system recorder must never run"); };
  let subscriptions = 0, recordings = 0;
  backend.debugVideos.set("phone", Promise.resolve({ subscribe() {
    subscriptions++; return { stream: new ReadableStream(), async close() {} };
  } }));
  backend.startStreamRecording = async (...args) => { recordings++; assert.equal(args[0], "phone"); };
  await (await backend.openVideoStream("phone")).close();
  assert.deepEqual(await backend.startRecording("phone", "piora-recording-12345678.mp4"), { method: "stream" });
  assert.equal(subscriptions, 1); assert.equal(recordings, 1);
});

test("a failed native recording never switches to another provider or retries the operation", async () => {
  const backend = backendWith(async () => { throw new Error("Unexpected device command"); });
  let starts = 0;
  backend.startStreamRecording = async () => { starts++; throw new HarmonyError("CAPABILITY_UNAVAILABLE", "bundled library unavailable"); };
  backend.startSystemRecording = () => { throw new Error("Must not start a system recorder"); };
  await assert.rejects(backend.startRecording("phone", "piora-recording-12345678.mp4"), error => error.code === "CAPABILITY_UNAVAILABLE");
  assert.equal(starts, 1); assert.equal(backend.recordingStarts.size, 0);
});

test("native reconnect waits for the previous subscription's cleanup before starting a new encoder", async () => {
  const backend = backendWith(async () => { throw new Error("Unexpected device command"); });
  backend.requireUnlockedScreen = async () => {};
  let release, subscribed = 0;
  const closing = new Promise(resolve => { release = resolve; });
  const old = { whenClosing: closing, subscribe() { throw new Error("Must not subscribe to a closing encoder"); } };
  backend.debugVideos.set("phone", Promise.resolve(old));
  const pending = backend.openVideoStream("phone");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(subscribed, 0);
  const connection = { stream: new ReadableStream(), async close() {} };
  backend.debugVideos.set("phone", Promise.resolve({ subscribe() { subscribed++; return connection; } }));
  release();
  const next = await pending; assert.equal(subscribed, 1); assert.equal(next.stream, connection.stream);
  await next.close();
});

for (const lockState of ["screenLocked: true", "screenLocked: false", "unrecognized dump"]) {
  test(`Bundled native viewers share live video without a screen-lock preflight: ${lockState}`, async () => {
    const calls = [];
    const backend = backendWith(async ({ args }) => {
      calls.push(args);
      return { stdout: Buffer.from(lockState), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
    });
    let subscribed = 0;
    backend.debugVideos.set("phone", Promise.resolve({ subscribe() {
      subscribed++;
      return { stream: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); } }), async close() {} };
    } }));
    const viewers = await Promise.all([backend.openVideoStream("phone"), backend.openVideoStream("phone")]);
    for (const viewer of viewers) {
      assert.deepEqual([...(await viewer.stream.getReader().read()).value], [1]);
      await viewer.close();
    }
    assert.equal(subscribed, 2);
    assert.deepEqual(calls, [], "neither presentation probes, wakes, unlocks, or starts a phone app");
  });
}

test("a missing bundled runtime reports failure without installing or launching a phone app", async t => {
  const directory = await mkdtemp(join(tmpdir(), "piora-missing-native-")), previous = process.env.PIORA_WEB_RUNTIME_ROOT;
  process.env.PIORA_WEB_RUNTIME_ROOT = directory;
  t.after(async () => { if (previous === undefined) delete process.env.PIORA_WEB_RUNTIME_ROOT; else process.env.PIORA_WEB_RUNTIME_ROOT = previous; await rm(directory, { recursive: true, force: true }); });
  const calls = [];
  const backend = backendWith(async ({ args, operation }) => {
    calls.push({ args, operation });
    return { stdout: Buffer.from(operation === "debug_video_version" ? "7.0.0.1" : ""), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
  });
  await assert.rejects(backend.openVideoStream("phone"), error => error.code === "CAPABILITY_UNAVAILABLE" && error.details?.reason === "debug-video-library-unavailable");
  assert.equal(backend.debugVideos.size, 0);
  assert.equal(calls.some(call => ["install_package", "launch_app", "mirror_forward", "debug_video_upload", "debug_video_start", "system_recorder_start"].includes(call.operation)), false);
  assert.equal(calls.some(call => call.args.includes("java") || call.args.includes("aa") || call.args.includes("bm")), false);
});

test("pre-aborted video never uploads or starts a device service", async () => {
  const calls = [], abort = new AbortController(); abort.abort();
  const backend = backendWith(async (...args) => { calls.push(args); throw new Error("Unexpected command"); });
  await assert.rejects(backend.openVideoStream("phone", abort.signal), error => error.name === "AbortError");
  assert.equal(calls.length, 0); assert.equal(backend.debugVideos.size, 0);
});

test("native initialization is shared by concurrent viewers and a failed start is retryable", async t => {
  const { MirrorCaptureSession } = await jiti.import("./harmony/mirror/capture-session.ts");
  const backend = backendWith(async () => { throw new Error("Unexpected device command"); });
  let starts = 0, subscribers = 0, release;
  const ready = new Promise(resolve => { release = resolve; });
  t.mock.method(MirrorCaptureSession, "start", async () => { starts++; await ready; return { subscribe() { subscribers++; return { stream: new ReadableStream(), async close() {} }; } }; });
  const viewers = [backend.openVideoStream("phone"), backend.openVideoStream("phone")];
  await new Promise(resolve => setImmediate(resolve)); assert.equal(starts, 1); release();
  for (const viewer of await Promise.all(viewers)) await viewer.close();
  assert.equal(subscribers, 2);
  backend.debugVideos.clear();
  t.mock.method(MirrorCaptureSession, "start", async () => { throw new HarmonyError("CAPABILITY_UNAVAILABLE", "missing bundle"); });
  await assert.rejects(backend.openVideoStream("phone"), error => error.code === "CAPABILITY_UNAVAILABLE");
  assert.equal(backend.debugVideos.size, 0);
});

test("discovers verbose HDC targets and probes UiTest capabilities", async () => {
  const calls = [];
  const backend = backendWith(async ({ executable, args }) => {
    calls.push({ executable, args });
    if (args.join(" ") === "list targets -v") {
      return {
        stdout: Buffer.from("alpha USB Connected Mate60 hdc\nbeta TCP Unauthorized Mate70 hdc\ngamma TCP Offline localhost hdc\n"),
        stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1,
      };
    }
    const command = args.slice(3).join(" ");
    const values = {
      "param get const.product.model": "ALN-AL00\n",
      "param get const.product.name": "HUAWEI Mate 60 Pro\n",
      "settings get secure unified_device_name": "Living room phone\n",
      "param get const.product.devicename": "My phone\n",
      "param get const.product.software.version": "HarmonyOS 6.0\n",
      "param get const.ohos.apiversion": "20\n",
      "uitest --version": "6.1.0.0\n",
    };
    return { stdout: Buffer.from(values[command] ?? ""), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
  });

  const devices = await backend.listDevices();
  assert.deepEqual(devices.map(({ serial, state }) => ({ serial, state })), [
    { serial: "alpha", state: "online" },
    { serial: "beta", state: "unauthorized" },
    { serial: "gamma", state: "offline" },
  ]);
  assert.equal(devices[0].model, "ALN-AL00");
  assert.equal(devices[0].product, "HUAWEI Mate 60 Pro");
  assert.equal(devices[0].name, "Living room phone");
  assert.deepEqual(devices.map(device => device.transport), ["usb", "tcp", "tcp"]);
  assert.ok(devices.every(device => device.transportEvidence === "hdc"));
  assert.equal(devices[0].capabilities.inputText, true);
  assert.equal(devices[1].capabilities.tap, false);
  assert.ok(calls.every((call) => call.executable === HDC));
  const probeCount = calls.filter((call) => call.args.includes("param") || call.args.includes("--version")).length;
  await backend.listDevices();
  assert.equal(calls.filter((call) => call.args.includes("param") || call.args.includes("--version")).length, probeCount);
});

test("does not turn HDC's verbose empty marker into a phantom online device", async () => {
  const backend = backendWith(async ({ args }) => {
    assert.equal(args.join(" "), "list targets -v");
    return { stdout: Buffer.from("[Empty]\t hdc\r\n"), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
  });
  assert.deepEqual(await backend.listDevices(), []);
});

test("device response samples reuse confirmed parameter reads and expire with identity metadata", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-30T01:00:00Z") });
  let state = "Connected", transport = "USB", durationMs = 17.4, output = "26", apiReads = 0;
  const backend = backendWith(async ({ args }) => {
    if (args.join(" ") === "list targets -v") return { stdout: Buffer.from(`alpha ${transport} ${state}\n`), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
    if (args.join(" ").endsWith("param get const.ohos.apiversion")) apiReads++;
    return { stdout: Buffer.from(args.join(" ").endsWith("param get const.ohos.apiversion") ? output : ""), stderr: Buffer.alloc(0), exitCode: 0, durationMs };
  });
  const first = (await backend.listDevices())[0].responseSample;
  assert.deepEqual(first, { durationMs: 17, sampledAt: new Date().toISOString() });
  assert.deepEqual((await backend.listDevices())[0].responseSample, first);
  assert.equal(apiReads, 1, "cached reads do not send extra heartbeat commands");
  t.mock.timers.tick(30_001);
  durationMs = 42;
  const fresh = (await backend.listDevices())[0].responseSample;
  assert.equal(fresh.durationMs, 42);
  assert.notEqual(fresh.sampledAt, first.sampledAt);
  transport = "TCP";
  durationMs = 73;
  assert.equal((await backend.listDevices())[0].responseSample.durationMs, 73, "a new transport cannot reuse the old transport sample");
  state = "Offline";
  assert.equal((await backend.listDevices())[0].responseSample, undefined);
  state = "Connected";
  output = "Get parameter const.ohos.apiversion failed";
  assert.equal((await backend.listDevices())[0].responseSample, undefined, "diagnostics are not confirmed device responses");
});

test("rejects shell diagnostics as device identity and refreshes cached names", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  let nickname = "My phone";
  const backend = backendWith(async ({ args }) => {
    const values = {
      "list targets -v": "alpha USB Connected hdc",
      "-t alpha shell param get const.product.model": "ALN-AL00",
      "-t alpha shell param get const.product.name": "HUAWEI Mate 60 Pro",
      "-t alpha shell settings get secure unified_device_name": "/system/bin/sh: settings: inaccessible or not found",
      "-t alpha shell param get persist.sys.device_name": "Get parameter persist.sys.device_name failed",
      "-t alpha shell param get const.product.devicename": nickname,
      "-t alpha shell uitest --version": "6.1.0.0",
    };
    return { stdout: Buffer.from(values[args.join(" ")] ?? ""), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
  });
  assert.equal((await backend.listDevices())[0].name, "My phone");
  nickname = "Renamed phone";
  assert.equal((await backend.listDevices())[0].name, "My phone");
  t.mock.timers.tick(30_001);
  assert.equal((await backend.listDevices())[0].name, "Renamed phone");
});

test("active native video defers metadata bursts but still detects disconnects and refreshes afterward", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  let online = true, name = "Phone", probes = 0, enumerations = 0;
  const backend = backendWith(async ({ args }) => {
    const command = args.join(" ");
    if (command === "list targets -v") { enumerations++; return { stdout: Buffer.from(online ? "alpha USB Connected hdc" : ""), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 }; }
    probes++;
    const value = command.endsWith("const.product.model") ? "ALN-AL00" : command.endsWith("const.product.name") ? "HUAWEI Mate 60 Pro" : command.endsWith("const.product.devicename") ? name : "";
    return { stdout: Buffer.from(value), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
  });
  assert.equal((await backend.listDevices())[0].name, "Phone");
  const initialProbes = probes;
  backend.debugVideos.set("alpha", Promise.resolve({ close: async () => {} }));
  name = "Renamed"; t.mock.timers.tick(30_001);
  assert.equal((await backend.listDevices())[0].name, "Phone");
  assert.equal(probes, initialProbes); assert.equal(enumerations, 2, "online discovery remains active");
  backend.debugVideos.clear();
  assert.equal((await backend.listDevices())[0].name, "Renamed");
  assert.ok(probes > initialProbes, "expired metadata refreshes after capture ends");
  backend.debugVideos.set("alpha", Promise.resolve({ close: async () => {} }));
  online = false; assert.deepEqual(await backend.listDevices(), []);
  name = "Reconnected"; online = true;
  assert.equal((await backend.listDevices())[0].name, "Reconnected", "disconnect invalidates identity even during capture");
  backend.debugVideos.clear();
});

test("lists device processes and returns bounded filtered hilog entries", async () => {
  const calls = [];
  const backend = backendWith(async ({ args }) => {
    calls.push(args);
    const command = args.slice(3).join(" ");
    if (command === "ps -A -o PID,NAME") {
      return { stdout: Buffer.from("PID NAME\n42 com.example.demo\n77 render_service\n"), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
    }
    if (command.startsWith("hilog ")) {
      return {
        stdout: Buffer.from("08-20 12:34:56.789 42 43 I A00000/App: started\n08-20 12:34:57.001 42 43 E A00000/App: fatal startup failure\n"),
        stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1,
      };
    }
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
  });

  assert.deepEqual(await backend.listProcesses("alpha"), [
    { pid: 42, name: "com.example.demo" },
    { pid: 77, name: "render_service" },
  ]);
  const logs = await backend.readLogs("alpha", { pid: 42, level: "error", query: "startup", limit: 50 });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, "error");
  assert.equal(logs[0].pid, 42);
  assert.match(logs[0].message, /fatal startup failure/);
  const hilog = calls.find((args) => args.includes("hilog"));
  assert.deepEqual(hilog.slice(3), ["hilog", "-z", "50", "-v", "time", "-P", "42", "-L", "E"]);
  assert.equal(hilog.includes("-n"), false);
  assert.equal(hilog.includes("-p"), false);
});

test("treats HDC failure markers as command failures even with exit code zero", async () => {
  const backend = backendWith(async () => ({
    stdout: Buffer.from("[Fail]ExecuteCommand need connect-key?"),
    stderr: Buffer.alloc(0),
    exitCode: 0,
    durationMs: 1,
  }));
  await assert.rejects(() => backend.tap("alpha", 10, 20),
    (error) => error instanceof HarmonyError && error.code === "COMMAND_FAILED");
});

test("falls back to legacy target listing when verbose discovery is unsupported", async () => {
  const calls = [];
  const backend = backendWith(async ({ args }) => {
    calls.push(args);
    if (args.slice(3).join(" ") === "uitest --version") {
      return { stdout: Buffer.from("6.1.0.0\n"), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
    }
    if (args.join(" ") === "list targets -v") {
      throw new HarmonyError("COMMAND_FAILED", "unsupported");
    }
    if (args.join(" ") === "list targets") {
      return { stdout: Buffer.from("legacy-phone\n"), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
    }
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
  });
  const devices = await backend.listDevices();
  assert.equal(devices[0].serial, "legacy-phone");
  assert.deepEqual(calls.slice(0, 2), [["list", "targets", "-v"], ["list", "targets"]]);
});

test("reports safe text input unavailable on UiTest versions without coordinate-free text", async () => {
  const backend = backendWith(async ({ args }) => ({
    stdout: Buffer.from(args.slice(3).join(" ") === "uitest --version" ? "5.0.1.2\n" : ""),
    stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1,
  }));
  await assert.rejects(() => backend.inputText("alpha", "hello"),
    (error) => error instanceof HarmonyError && error.code === "CAPABILITY_UNAVAILABLE");
});

test("captures layout and PNG through generated remote files", async () => {
  const calls = [];
  const tree = { attributes: { type: "Window" }, children: [
    { attributes: { type: "Button", text: "Continue", clickable: true, bounds: "[10,20][110,70]" } },
  ] };
  const backend = backendWith(async ({ args }) => {
    calls.push(args);
    const recvIndex = args.indexOf("recv");
    if (recvIndex >= 0) {
      const remote = args[recvIndex + 1];
      const local = args[recvIndex + 2];
      writeFileSync(local, remote.endsWith(".png") ? png() : JSON.stringify(tree));
    }
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
  });

  const snapshot = await backend.snapshot("alpha", { includeTree: true, includeScreenshot: true });
  assert.equal(snapshot.nodes.length, 2);
  assert.deepEqual(snapshot.nodes[1].bounds, { left: 10, top: 20, right: 110, bottom: 70 });
  assert.equal(snapshot.screenshot.width, 1080);
  assert.equal(snapshot.screenshot.height, 2400);
  assert.ok(calls.some((args) => args.includes("dumpLayout")));
  assert.ok(calls.some((args) => args.includes("screenCap")));
  assert.ok(calls.filter((args) => args.includes("recv")).every((args) => args[0] === "-t" && args[1] === "alpha"));
});

test("each passive screenshot clears its owned remote and local staging files before returning", async () => {
  const calls = [], localPaths = [];
  const backend = backendWith(async ({ args, signal, timeoutMs }) => {
    calls.push({ args, signal, timeoutMs });
    if (args.includes("recv")) {
      const local = args[args.indexOf("recv") + 2]; localPaths.push(local); writeFileSync(local, png());
    }
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
  });
  try {
    for (let index = 0; index < 2; index++) {
      const captured = await backend.snapshot("alpha", { includeTree: false, includeScreenshot: true });
      assert.equal(captured.screenshot.width, 1080);
      const cleanup = calls.filter(call => call.args.includes("rm") && call.args.some(value => /^\/data\/local\/tmp\/piora-screen-/.test(value)));
      assert.equal(cleanup.length, index + 1, "screen staging must not remain until process disposal");
      assert.equal(cleanup.at(-1).signal, undefined);
      assert.equal(cleanup.at(-1).timeoutMs, 3000);
      assert.equal(existsSync(localPaths.at(-1)), false, "decoded bytes no longer need an on-disk screen file");
    }
    assert.equal(localPaths[0], localPaths[1], "serializing captures can still reuse the private directory");
  } finally { await backend.dispose(); }
});

test("cancelled screenshot pulls still clean staging with an independent bounded command", async () => {
  const controller = new AbortController();
  let failPull = true, localPath, cleanup;
  const backend = backendWith(async ({ args, signal, timeoutMs }) => {
    if (args.includes("recv")) {
      localPath = args[args.indexOf("recv") + 2]; writeFileSync(localPath, png());
      if (failPull) { failPull = false; controller.abort(); throw new HarmonyError("COMMAND_ABORTED", "Cancelled pull"); }
    }
    if (args.includes("rm")) cleanup = { signal, timeoutMs };
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
  });
  try {
    await assert.rejects(backend.snapshot("alpha", { includeTree: false, includeScreenshot: true, signal: controller.signal }),
      error => error.code === "COMMAND_ABORTED");
    assert.deepEqual(cleanup, { signal: undefined, timeoutMs: 3000 });
    assert.equal(existsSync(localPath), false);
    assert.equal((await backend.snapshot("alpha", { includeTree: false, includeScreenshot: true })).screenshot.height, 2400,
      "a cancelled capture must release the queue for the next screenshot");
  } finally { await backend.dispose(); }
});

test("overlapping screen observations keep complete frame bytes and clean before the next capture", async () => {
  let releasePull, startedPull, captures = 0;
  const pullReady = new Promise(resolve => { startedPull = resolve; });
  const heldPull = new Promise(resolve => { releasePull = resolve; });
  const operations = [];
  const backend = backendWith(async ({ args, operation }) => {
    operations.push(operation);
    if (operation === "screen_capture") captures++;
    if (operation === "screenshot_pull") {
      writeFileSync(args[args.indexOf("recv") + 2], png(1080 + captures));
      if (captures === 1) { startedPull(); await heldPull; }
    }
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
  });
  try {
    const first = backend.snapshot("alpha", { includeTree: false, includeScreenshot: true });
    const second = backend.snapshot("alpha", { includeTree: false, includeScreenshot: true });
    await pullReady;
    assert.equal(captures, 1, "a queued frame cannot overwrite the frame still being copied");
    releasePull();
    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map(result => result.screenshot.width), [1081, 1082]);
    assert.deepEqual(operations, ["screen_capture", "screenshot_pull", "screenshot_cleanup", "screen_capture", "screenshot_pull", "screenshot_cleanup"]);
  } finally { releasePull(); await backend.dispose(); }
});

test("never places user text in an HDC or remote-shell argument", async () => {
  const hostile = `hello; touch /data/local/tmp/pwned\n$() \`id\` "quote" 中文`;
  const calls = [];
  let uploaded;
  const backend = backendWith(async ({ args }) => {
    calls.push(args);
    if (args.slice(3).join(" ") === "uitest --version") {
      return { stdout: Buffer.from("6.1.0.0\n"), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
    }
    const sendIndex = args.indexOf("send");
    if (sendIndex >= 0) uploaded = readFileSync(args[sendIndex + 1], "utf8");
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
  });

  await backend.inputText("alpha", hostile);
  assert.equal(uploaded, hostile);
  assert.ok(calls.every((args) => args.every((arg) => !arg.includes(hostile))));
  const remote = calls.find((args) => args.some((arg) => arg.startsWith("v=")));
  assert.equal(remote.length, 4);
  assert.doesNotMatch(remote[3], /\s/);
  assert.match(remote[3], /^v="\$\(cat\$\{IFS\}\/data\/local\/tmp\/piora-input-[0-9a-f-]+\.txt;printf\$\{IFS\}x\)";v="\$\{v%x\}";uitest\$\{IFS\}uiInput\$\{IFS\}text\$\{IFS\}"\$v"$/);
  assert.doesNotMatch(remote[3], /touch|pwned|中文|`id`/);
});

test("uses fixed argument arrays for actions and validates identifiers", async () => {
  const calls = [];
  const backend = backendWith(async ({ args }) => {
    calls.push(args);
    const output = args.includes("install") ? "[Info]App install path:preview.hap msg:install bundle successfully.\nAppMod finish"
      : args.includes("uninstall") ? "[Info]App uninstall path: msg:uninstall bundle successfully.\nAppMod finish"
      : args.includes("aa") ? "start ability successfully." : "";
    return { stdout: Buffer.from(output), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
  });
  await backend.tap("alpha", 10, 20);
  await backend.doubleTap("alpha", 10, 20);
  await backend.longPress("alpha", 10, 20);
  await backend.swipe("alpha", 10, 20, 30, 40, 500);
  await backend.fling("alpha", 10, 20, 30, 40, 250);
  await backend.drag("alpha", 10, 20, 30, 40, 800);
  await backend.pressKey("alpha", "recents");
  await backend.launchApp("alpha", "com.example.demo", "EntryAbility");
  const packageRoot = await mkdtemp(join(tmpdir(), "piora-hdc-install-"));
  const hapPath = join(packageRoot, "preview.hap");
  writeFileSync(hapPath, Buffer.from("hap"));
  await backend.installPackage("alpha", hapPath, true);
  await backend.uninstallPackage("alpha", "com.example.demo");

  assert.deepEqual(calls[0], ["-t", "alpha", "shell", "uitest", "uiInput", "click", "10", "20"]);
  assert.deepEqual(calls[1], ["-t", "alpha", "shell", "uitest", "uiInput", "doubleClick", "10", "20"]);
  assert.deepEqual(calls[2], ["-t", "alpha", "shell", "uitest", "uiInput", "longClick", "10", "20"]);
  assert.deepEqual(calls[6], ["-t", "alpha", "shell", "uitest", "uiInput", "keyEvent", "2720"]);
  assert.deepEqual(calls[7], ["-t", "alpha", "shell", "aa", "start", "-b", "com.example.demo", "-a", "EntryAbility"]);
  assert.deepEqual(calls[8], ["-t", "alpha", "install", "-r", hapPath]);
  assert.deepEqual(calls[9], ["-t", "alpha", "uninstall", "com.example.demo"]);
  await rm(packageRoot, { recursive: true, force: true });
  await assert.rejects(() => backend.launchApp("alpha", "com.demo;reboot"),
    (error) => error instanceof HarmonyError && error.code === "INVALID_ARGUMENT");
  await assert.rejects(() => backend.installPackage("alpha", "relative-preview.hap", true),
    (error) => error instanceof HarmonyError && error.code === "INVALID_ARGUMENT");
});

test("zero-exit HDC signature rejection fails installation and never starts mirroring", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-install-reply-"));
  const hap = await mirrorHap(directory);
  const calls = [];
  const backend = backendWith(async ({ args }) => {
    calls.push(args);
    const output = args.includes("hidumper") ? "screenLocked false"
      : args.includes("bm") && args.includes("-n") ? "error: failed to get information and the parameters may be wrong."
      : args.includes("bm") && args.includes("-a") ? "com.example.keep"
      : `[Info]App install path:${hap} msg:error: failed to install bundle. code:9568257 error: fail to verify pkcs7 file.\nAppMod finish`;
    return { stdout: Buffer.from(output),
      stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
  });
  try {
    await assert.rejects(backend.installPackage("alpha", hap, false), error => {
      assert.equal(error.code, "COMMAND_FAILED");
      assert.equal(error.details.reason, "signature-rejected");
      assert.equal(error.details.deviceErrorCode, "9568257");
      assert.equal(error.details.dispatchState, "sent");
      assert.equal(JSON.stringify(error.toJSON()).includes(hap), false, "local paths stay out of public errors");
      return true;
    });
    assert.equal(calls.some(args => args.includes("aa")), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the removed phone capture installer has no backend method or action contract", async () => {
  const backend = backendWith(async () => { throw new Error("No device command may be sent"); });
  const { actionCatalog, validateAction } = await jiti.import("./harmony/contracts/actions.ts");
  assert.equal(backend.initializeMirror, undefined); assert.equal(backend.mirrorPackagePath, undefined);
  assert.equal(backend.openBundledVideoStream, undefined);
  assert.equal(actionCatalog.initialize_mirror, undefined);
  assert.throws(() => validateAction({ action: "initialize_mirror" }, "direct"), error => error.code === "INVALID_ARGUMENT");
});

test("HDC app operations require affirmative device replies, including stderr failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-install-evidence-"));
  const hap = join(directory, "failed-to-install.hap"); writeFileSync(hap, "fixture");
  let output = "AppMod finish", stderr = "";
  const backend = backendWith(async () => ({ stdout: Buffer.from(output), stderr: Buffer.from(stderr), exitCode: 0, durationMs: 1 }));
  try {
    await assert.rejects(backend.installPackage("alpha", hap), error => error.code === "INVALID_RESPONSE");
    output = `[Info]App install path:${hap} msg:install bundle successfully.\nAppMod finish`;
    await backend.installPackage("alpha", hap);
    output = `[Info]App install path:${hap}, queuesize:0, msg:install bundle successfully.\nAppMod finish`;
    await backend.installPackage("alpha", hap);
    output = "expected msg:install bundle successfully.";
    await assert.rejects(backend.installPackage("alpha", hap), error => error.code === "INVALID_RESPONSE");
    output = "permission denied msg:install bundle successfully.";
    await assert.rejects(backend.installPackage("alpha", hap), error => error.code === "COMMAND_FAILED");
    output = `[Info]App install path:${hap} msg:install bundle successfully.\nAppMod finish`;
    stderr = "error: failed to install bundle. code:1234";
    await assert.rejects(backend.installPackage("alpha", hap), error => error.code === "COMMAND_FAILED" && error.details.deviceErrorCode === "1234");
    stderr = ""; output = "error: failed to start ability.\nError Code:10104001";
    await assert.rejects(backend.launchApp("alpha", "com.example.demo", "EntryAbility"), error => error.code === "COMMAND_FAILED");
    output = "AppMod finish";
    await assert.rejects(backend.uninstallPackage("alpha", "com.example.demo"), error => error.code === "INVALID_RESPONSE");
    output = "error: failed to uninstall bundle. code:10";
    await assert.rejects(backend.uninstallPackage("alpha", "com.example.demo"), error => error.code === "COMMAND_FAILED");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const [method, flag, kind, operation] of [["clearAppCache", "-c", "cache", "clear_app_cache"], ["clearAppData", "-d", "data", "clear_app_data"]]) {
  test(`HDC ${kind} cleaning requires its own affirmative reply and rejects zero-exit failures`, async () => {
    let output = `clean bundle ${kind} files successfully.\r\n`, stderr = "";
    const calls = [];
    const backend = backendWith(async request => {
      calls.push({ args: request.args, operation: request.operation });
      return { stdout: Buffer.from(output), stderr: Buffer.from(stderr), exitCode: 0, durationMs: 1 };
    });
    await backend[method]("alpha", "com.example.demo");
    assert.deepEqual(calls, [{ args: ["-t", "alpha", "shell", "bm", "clean", flag, "-n", "com.example.demo"], operation }]);
    for (const unconfirmed of ["", "AppMod finish", `clean bundle ${kind === "cache" ? "data" : "cache"} files successfully.`,
      `expected message: clean bundle ${kind} files successfully.`, `expected msg: clean bundle ${kind} files successfully.`]) {
      output = unconfirmed;
      await assert.rejects(backend[method]("alpha", "com.example.demo"), error => error.code === "INVALID_RESPONSE" && error.details.dispatchState === "sent");
    }
    output = `clean bundle ${kind} files successfully.`; stderr = "permission denied";
    await assert.rejects(backend[method]("alpha", "com.example.demo"), error => error.code === "COMMAND_FAILED");
    stderr = ""; output = `permission denied msg: clean bundle ${kind} files successfully.`;
    await assert.rejects(backend[method]("alpha", "com.example.demo"), error => error.code === "COMMAND_FAILED");
    stderr = ""; output = `error: failed to clean bundle ${kind} files.`;
    await assert.rejects(backend[method]("alpha", "com.example.demo"), error => error.code === "COMMAND_FAILED");
  });
}

test("recording refuses to stop an unowned session and never toggles a global recorder", async () => {
  const calls = [];
  const backend = backendWith(async ({ args }) => { calls.push(args); return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 }; });
  await assert.rejects(() => backend.stopRecording("alpha", "piora-recording-12345678.mp4", "unused.mp4"), error => error.code === "INVALID_ARGUMENT");
  assert.equal(calls.length, 0);
  await backend.dispose();
});

test("an affirmative aa lock error preserves dispatch evidence and never injects an unlock or retries", async () => {
  const calls=[];
  const backend=backendWith(async ({args})=>{
    calls.push(args);
    return {stdout:Buffer.from('error: failed to start ability.\nError Code:10106102\nError Message:The device screen is locked during the application launch.'),stderr:Buffer.alloc(0),exitCode:0,durationMs:1};
  });
  await assert.rejects(backend.launchApp('alpha','com.example.demo','EntryAbility'),error=>{
    assert.equal(error.code,'SCREEN_LOCKED');
    assert.deepEqual(error.details,{operation:'launch_app',dispatchState:'sent',reason:'app-launch-locked',deviceErrorCode:'10106102'});
    assert.equal(error.retryable,false); return true;
  });
  assert.equal(calls.length,1);
  assert.ok(calls[0].includes('start'));
  assert.equal(calls.some(args=>args.includes('uitest')),false);
});

test("ordinary hardware keys dispatch keyEvent without a calibrated hold", async () => {
  const calls=[];
  const backend=backendWith(async ({args}) => { calls.push(args);return {stdout:Buffer.alloc(0),stderr:Buffer.alloc(0),exitCode:0,durationMs:1}; });
  for (const key of ["volume_up","volume_down","power"]) await backend.pressKey("alpha",key);
  assert.deepEqual(calls.map(args=>args.slice(-2)),[["keyEvent","16"],["keyEvent","17"],["keyEvent","18"]]);
});
