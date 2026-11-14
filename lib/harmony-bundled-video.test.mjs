import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createJiti } from "jiti";
import JSZip from "jszip";
import grpc from "@grpc/grpc-js";
const require = createRequire(import.meta.url);
const { ReplyMessage, ParamValue } = require("hypium-driver/build/lib/generated/scrcpy/scrcpy_pb.js");
const { ScrcpyServiceService } = require("hypium-driver/build/lib/generated/scrcpy/scrcpy_grpc_pb.js");
const jiti = createJiti(import.meta.url);
const { MirrorCaptureSession } = await jiti.import("./harmony/mirror/capture-session.ts");
const { selectVideoLibrary, selectBundledVideoLibrary, readBundledVideoLibrary, readBundledVideoLibrarySelection, readBundledVideoLibraryCandidates } = await jiti.import("./harmony/runtime/bundled-video-library.ts");
const { videoStartupDiagnostics } = await jiti.import("./harmony/runtime/video-startup-diagnostics.ts");
const videoManifest = JSON.parse(await readFile(new URL("../third_party/harmony-video/manifest.json", import.meta.url), "utf8"));
const bundledResources = join(dirname(require.resolve("hypium-driver/package.json")), "build/lib/resource");
const { avcSize } = await jiti.import("./harmony/media/avc-size.ts");

const ue = n => { const b = (n + 1).toString(2); return "0".repeat(b.length - 1) + b; };
function sps(width = 640, height = 480) {
  const bits = [ue(0), ue(0), ue(0), ue(0), ue(1), "0", ue(width / 16 - 1), ue(height / 16 - 1), "1101"].join("");
  return Buffer.concat([Buffer.from([0x67, 66, 0, 30]), Buffer.from((bits + "0".repeat((8 - bits.length % 8) % 8)).match(/.{8}/g).map(b => parseInt(b, 2)))]);
}
const annex = (...units) => Buffer.concat(units.flatMap(unit => [Buffer.from([0, 0, 0, 1]), Buffer.from(unit)]));
const config = annex(sps(), [0x68, 0xce, 6]);

test("Bundled library selection uses the newest compatible Unix library and rejects paths/unsupported versions", () => {
  const names = ["libscrcpy/libscrcpy_server_unix_6.4-20260113.z.so", "libscrcpy/libscrcpy_server_unix_6.6-20260418.z.so", "../libscrcpy/libscrcpy_server_unix_9.0-20260418.z.so"];
  assert.equal(selectVideoLibrary(names, "7.0.0.1"), names[1]);
  assert.equal(selectVideoLibrary(names, "6.4.0.0"), names[0]);
  assert.equal(selectVideoLibrary(names, "5.0.0"), undefined);
  assert.equal(selectVideoLibrary(names, "bad reply"), undefined);
});

test("bundled discovery works with no IDE and selects only compatible versioned socket libraries", async () => {
  const names = ["libscrcpy_server-6.3.1-20260113.so", "libscrcpy_server-6.4-20260113.so", "libscrcpy_server4.z.so", "../libscrcpy_server-7.0-20260113.so"];
  assert.equal(selectBundledVideoLibrary(names, "6.3.1.0"), names[0]);
  assert.equal(selectBundledVideoLibrary(names, "7.0.0.1"), undefined, "6.4 is outside the UiTest 7 ABI candidate family");
  assert.equal(selectBundledVideoLibrary(names, "6.4.0"), names[1]);
  assert.equal(selectBundledVideoLibrary(names, "5.0"), undefined);
  assert.equal(selectBundledVideoLibrary(names, "invalid version"), undefined);
  const bytes = await readBundledVideoLibrary("7.0.0.1");
  const modern = videoManifest.assets.find(asset => asset.name.includes("6.6-"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), modern.sha256, "UiTest 7 uses the pinned 6.6 library without an installed IDE");
  assert.deepEqual(await readBundledVideoLibrary("6.4"), await readFile(join(bundledResources, names[1])), "older devices keep their matching ABI family");
  await assert.rejects(readBundledVideoLibrary("5.0"), /no compatible/);
});

test("external IDE JARs never override the shipped library or rescue a missing runtime", async t => {
  const directory = await mkdtemp(join(tmpdir(), "piora-video-external-"));
  const previousRoot = process.env.PIORA_WEB_RUNTIME_ROOT, previousIde = process.env.DEVECO_CLI_STUDIO_PATH;
  t.after(async () => {
    if (previousRoot === undefined) delete process.env.PIORA_WEB_RUNTIME_ROOT; else process.env.PIORA_WEB_RUNTIME_ROOT = previousRoot;
    if (previousIde === undefined) delete process.env.DEVECO_CLI_STUDIO_PATH; else process.env.DEVECO_CLI_STUDIO_PATH = previousIde;
    await rm(directory, { recursive: true, force: true });
  });
  const libs = join(directory, "ide/plugins/screen-mirroring/lib"); await mkdir(libs, { recursive: true });
  const zip = new JSZip(); zip.file("libscrcpy/libscrcpy_server_unix_6.6-20261231.z.so", await readBundledVideoLibrary("7.0"));
  await writeFile(join(libs, "hosScrcpy-99.0.jar"), await zip.generateAsync({ type: "nodebuffer" }));
  process.env.DEVECO_CLI_STUDIO_PATH = join(directory, "ide");
  assert.equal((await readBundledVideoLibrarySelection("7.0")).sha256, videoManifest.assets[1].sha256);
  process.env.PIORA_WEB_RUNTIME_ROOT = join(directory, "missing-runtime");
  await assert.rejects(readBundledVideoLibrary("7.0"), /ENOENT/);
  await assert.rejects(readBundledVideoLibrary("6.4"), /no compatible/);
});

test("bundled capture rejects wrong architectures, malformed and oversized libraries", async t => {
  const directory = await mkdtemp(join(tmpdir(), "piora-video-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previous = process.env.PIORA_WEB_RUNTIME_ROOT;
  process.env.PIORA_WEB_RUNTIME_ROOT = directory;
  t.after(() => { if (previous === undefined) delete process.env.PIORA_WEB_RUNTIME_ROOT; else process.env.PIORA_WEB_RUNTIME_ROOT = previous; });
  const resources = join(directory, "node_modules/hypium-driver/build/lib/resource"); await mkdir(resources, { recursive: true });
  const path = join(resources, "libscrcpy_server-6.4-20260113.so");
  for (const data of [Buffer.alloc(64), Buffer.alloc(4 * 1024 * 1024 + 1)]) {
    await writeFile(path, data);
    await assert.rejects(readBundledVideoLibrary("6.4"));
  }
  const elf = Buffer.alloc(64); Buffer.from("7f454c46", "hex").copy(elf); elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(62, 18);
  await writeFile(path, elf);
  await assert.rejects(readBundledVideoLibrary("6.4"), /ARM64/);
});

test("bundled modern video bytes have the pinned source hashes", async () => {
  const selected = await readBundledVideoLibrarySelection("7.0.0.1");
  assert.equal(selected.source, "bundled");
  assert.equal(selected.name, "libscrcpy_server_unix_6.6-20260629.z.so");
  assert.equal(selected.sha256, videoManifest.assets[1].sha256);
  for (const asset of videoManifest.assets) {
    const bytes = await readFile(new URL(`../third_party/harmony-video/${asset.name}`, import.meta.url));
    assert.equal(bytes.length, asset.size);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256);
    assert.equal(bytes.readUInt16LE(18), 183);
  }
});

test("a native startup failure reports hilog ABI evidence before cleaning only its own files", async t => {
  const directory = await mkdtemp(join(tmpdir(), "piora-video-abi-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = []; let name, attempt = 0;
  const symbol = "_ZN6google8protobuf8internal14UntypedMapBase14ClearTableImplEb";
  const run = async (args, operation) => {
    calls.push({ args, operation }); let text = "";
    if (operation === "debug_video_start") { name = args[3].match(/--extension-name (\S+)/)[1]; attempt++; text = "1234"; }
    if (operation === "debug_video_ready") text = "@scrcpy_grpc_socket";
    if (operation === "debug_video_startup_hilog") text = `OtherApp: private error\n11-11 01:00:0${attempt} Error relocating /data/local/tmp/${name}: ${symbol}: symbol not found`;
    return { stdout: Buffer.from(text), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
  };
  await assert.rejects(MirrorCaptureSession.start("abi-phone", run, () => {}, directory, "7.0.0.1"), error => {
    assert.equal(error.code, "CAPABILITY_UNAVAILABLE");
    assert.equal(error.retryable, false);
    assert.equal(error.details.reason, "debug-video-abi-incompatible");
    assert.equal(error.details.missingSymbol, symbol);
    assert.equal(error.details.librarySha256, videoManifest.assets[2].sha256);
    assert.deepEqual(error.details.libraryAttempts.map(row => row.librarySha256), [videoManifest.assets[1].sha256, videoManifest.assets[2].sha256]);
    assert.doesNotMatch(error.details.diagnostic, /OtherApp|private/);
    return true;
  });
  const read = calls.findIndex(call => call.operation === "debug_video_startup_hilog");
  assert.ok(calls.findIndex(call => call.operation === "debug_video_file_cleanup") > read);
  assert.equal(calls.some(call => call.operation === "debug_video_stop" || call.operation === "debug_video_forward"), false);
});

test("UiTest 7 retains both verified 6.6 ABI builds without falling through to 6.5", async () => {
  const candidates = await readBundledVideoLibraryCandidates("7.0.0.1");
  assert.deepEqual(candidates.map(value => value.name), [videoManifest.assets[1].name, videoManifest.assets[2].name]);
  for (const candidate of candidates) {
    const asset = videoManifest.assets.find(asset => asset.name === candidate.name);
    assert.equal(candidate.bytes.length, asset.size);
    assert.equal(createHash("sha256").update(candidate.bytes).digest("hex"), asset.sha256);
  }
  const older = await readBundledVideoLibraryCandidates("6.4");
  assert.equal(older.length, 1);
  assert.match(older[0].name, /6\.4-/);
});

test("MUSL loader diagnostics extract the actual symbol instead of the word failed", () => {
  const name = "piora_video_0123456789abcdef0123456789abcdef.so";
  const symbol = "_ZN6google8protobuf8internal14UntypedMapBase14ClearTableImplEb";
  const musl = `MUSL: relocating failed: symbol not found. dso=/data/local/tmp/${name} s=${symbol} use_vna_hash=0`;
  const uitest = `UiTest: Dlopen /data/local/tmp/${name} failed: Error relocating /data/local/tmp/${name}: ${symbol}: symbol not found`;
  assert.equal(videoStartupDiagnostics(name, "", musl + "\n" + uitest).missingSymbol, symbol);
  assert.equal(videoStartupDiagnostics(name, "", musl).missingSymbol, symbol);
  assert.equal(videoStartupDiagnostics(name, "", `MUSL: ${name} relocating failed: symbol not found`).missingSymbol, undefined);
  assert.equal(videoStartupDiagnostics(name, "Permission denied", `Error relocating foreign.so: ${symbol}: symbol not found`).missingSymbol, undefined);
});

async function abiFixture(t, { permission = false, own = false, foreign = false, secondPermission = false, missingSocket = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "piora-video-fallback-"));
  const server = new grpc.Server(), calls = [], uploads = [], history = [];
  const sessions = []; let name, loaded = false, attempt = 0, source, failure;
  server.addService(ScrcpyServiceService, { onStart(call) { source = call; } });
  t.after(async () => { for (const session of sessions) await session.close(); server.forceShutdown(); await rm(directory, { recursive: true, force: true }); });
  const run = async (args, operation) => {
    calls.push({ args, operation }); let text = "";
    if (operation === "debug_video_upload") uploads.push(createHash("sha256").update(await readFile(args[4])).digest("hex"));
    if (operation === "debug_video_start") {
      name = args[3].match(/--extension-name (\S+)/)[1]; attempt++;
      failure = permission || secondPermission && attempt > 1 ? "permission" : uploads.at(-1) === videoManifest.assets[1].sha256 ? "abi" : undefined;
      loaded = !failure; text = "1234";
      if (failure === "abi") history.push(`11-11 01:00:${String(attempt).padStart(2, "0")} Error relocating /data/local/tmp/${name}: protobuf_missing_${attempt}: symbol not found`);
    }
    if (operation === "debug_video_ready") text = (own || missingSocket) && failure ? "" : "@scrcpy_grpc_socket";
    if (operation === "debug_video_owner" && (loaded || own)) text = `shell 5678 1 0 12:00 ? 00:00:00 uitest start-daemon singleness --extension-name ${name}`;
    if (operation === "debug_video_startup_log" && failure === "permission") text = `Dlopen /data/local/tmp/${name} failed: Permission denied`;
    if (operation === "debug_video_startup_hilog") text = history.join("\n");
    if (operation === "debug_video_fallback_socket" && foreign) text = "@scrcpy_grpc_socket";
    if (operation === "debug_video_forward") await new Promise((resolve, reject) => server.bindAsync(`127.0.0.1:${Number(args[3].slice(4))}`, grpc.ServerCredentials.createInsecure(), error => error ? reject(error) : resolve()));
    if (operation === "debug_video_stop") loaded = false;
    return { stdout: Buffer.from(text), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
  };
  const start = async () => { const session = await MirrorCaptureSession.start(directory, run, () => {}, directory, "7.0.0.1"); sessions.push(session); return session; };
  const sendFrame = async session => {
    source = undefined; const connection = session.subscribe(), reader = connection.stream.getReader();
    for (let i = 0; !source && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(source);
    for (const bytes of [config, annex([0x65, 1])]) { const reply = new ReplyMessage(), value = new ParamValue(); value.setValBytes(bytes); reply.getPayloadMap().set("data", value); source.write(reply); }
    assert.equal(Buffer.from((await reader.read()).value).readUInt32BE(0), 2);
    assert.equal(Buffer.from((await reader.read()).value).readUInt32BE(0), 3);
    await connection.close();
  };
  return { start, sendFrame, calls, uploads, directory };
}

test("an explicit ABI loader failure advances to the verified candidate without twenty HDC readiness polls", async t => {
  const f = await abiFixture(t, { missingSocket: true });
  const session = await f.start();
  assert.deepEqual(f.uploads, [videoManifest.assets[1].sha256, videoManifest.assets[2].sha256]);
  assert.ok(f.calls.filter(call => call.operation === "debug_video_ready").length <= 3, "loader evidence must end the failed candidate's startup wait early");
  await session.close();
});

test("slow HDC readiness calls consume a wall-clock startup budget instead of twenty full command timeouts", async t => {
  const directory = await mkdtemp(join(tmpdir(), "piora-video-startup-budget-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = 0, polls = 0;
  const timeouts = [];
  t.mock.method(performance, "now", () => now);
  const run = async (_args, operation, _signal, timeout) => {
    if (operation === "debug_video_ready") { polls++; timeouts.push(timeout); now += 3000; }
    return { stdout: Buffer.from(operation === "debug_video_start" ? "1234" : ""), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
  };
  await assert.rejects(MirrorCaptureSession.start("slow-start-phone", run, () => {}, directory, "6.4"), error => error.details?.reason === "debug-video-start-failed");
  assert.equal(polls, 3, "an eight-second budget must not admit twenty slow HDC round trips");
  assert.deepEqual(timeouts, [8000, 5000, 2000], "each readiness command receives only the remaining budget");
});

test("confirmed ABI failure tries the compatible pinned build and remembers it only after a real video packet", async t => {
  const f = await abiFixture(t), first = await f.start();
  assert.deepEqual(f.uploads, [videoManifest.assets[1].sha256, videoManifest.assets[2].sha256]);
  await first.close();
  const second = await f.start();
  assert.deepEqual(f.uploads, [videoManifest.assets[1].sha256, videoManifest.assets[2].sha256, videoManifest.assets[1].sha256, videoManifest.assets[2].sha256], "a daemon without a complete video packet is not remembered");
  await f.sendFrame(second); await second.close();
  const third = await f.start();
  assert.equal(f.uploads.length, 5); assert.equal(f.uploads.at(-1), videoManifest.assets[2].sha256);
  await third.close();
  assert.equal(f.calls.filter(call => call.operation === "debug_video_fallback_cleanup").length, 2);
  assert.deepEqual(await readdir(join(f.directory, "records")), []);
  assert.equal(f.calls.some(call => call.args.some(arg => /killall|pkill|wake|unlock|aa start/.test(arg))), false);
});

test("unrelated loader errors never trigger ABI fallback", async t => {
  const f = await abiFixture(t, { permission: true });
  await assert.rejects(f.start(), error => error.details?.reason === "debug-video-start-failed");
  assert.equal(f.uploads.length, 1);
  assert.equal(f.calls.some(call => call.operation === "debug_video_fallback_cleanup"), false);
});

test("a foreign socket appearing during ABI recovery is preserved", async t => {
  const f = await abiFixture(t, { foreign: true });
  await assert.rejects(f.start(), error => error.details?.reason === "debug-video-busy");
  assert.equal(f.uploads.length, 1);
  assert.equal(f.calls.some(call => ["debug_video_stop", "debug_video_forward", "debug_video_fallback_cleanup"].includes(call.operation)), false);
});

test("a still-running owned daemon prevents ABI replacement", async t => {
  const f = await abiFixture(t, { own: true });
  await assert.rejects(f.start(), error => error.details?.reason === "debug-video-abi-incompatible");
  assert.equal(f.uploads.length, 1);
  assert.equal(f.calls.some(call => call.operation === "debug_video_fallback_cleanup"), false);
  assert.deepEqual(f.calls.filter(call => call.operation === "debug_video_stop").map(call => call.args[3]), ["kill -9 5678"]);
});

test("a fallback attempt does not reuse an earlier attempt's ABI diagnostic", async t => {
  const f = await abiFixture(t, { secondPermission: true });
  await assert.rejects(f.start(), error => {
    assert.equal(error.details?.reason, "debug-video-start-failed");
    assert.equal(error.details?.missingSymbol, undefined);
    assert.match(error.details?.diagnostic, /Permission denied/);
    assert.doesNotMatch(error.details?.diagnostic, /protobuf_missing_1/);
    return true;
  });
  assert.equal(f.uploads.length, 2);
});

test("SPS dimensions follow encoded orientation and reject truncated/oversized data", () => {
  assert.deepEqual(avcSize(sps()), { width: 640, height: 480 });
  assert.deepEqual(avcSize(sps(480, 640)), { width: 480, height: 640 });
  assert.equal(avcSize(Buffer.from([0x67, 100])), undefined);
  assert.equal(avcSize(Buffer.alloc(5000, 0x67)), undefined);
});

async function fixture(t, busy = false, forwardFailure = false) {
  const directory = await mkdtemp(join(tmpdir(), "piora-debug-video-test-"));
  const sessions = [];
  t.after(async () => { for (const session of sessions) await session.close(); await rm(directory, { recursive: true, force: true }); });
  const server = new grpc.Server(), calls = [], sources = []; let source, name, started = false, closes = 0, offline = false, uploaded;
  server.addService(ScrcpyServiceService, { onStart(call) { source = call; sources.push(call); }, onEnd(_call, done) { assert.fail("must not call global onEnd"); done(); } });
  t.after(() => server.forceShutdown());
  const run = async (args, operation) => {
    calls.push({ args, operation }); let text = "";
    if (offline) throw new Error("HDC device disconnected");
    if (operation === "debug_video_version") text = "7.0.0.1";
    if (operation === "debug_video_upload") uploaded = await readFile(args[4]);
    if (operation === "debug_video_socket_check" && busy || operation === "debug_video_ready") text = "@scrcpy_grpc_socket";
    if (operation === "debug_video_start") { name = args[3].match(/--extension-name (\S+)/)[1]; started = true; text = "1234"; }
    if (operation === "debug_video_owner" && started) text = `shell 5678 1 0 12:00 ? 00:00:00 uitest start-daemon singleness --extension-name ${name}`;
    if (operation === "debug_video_forward") {
      const port = Number(args[3].slice(4));
      await new Promise((resolve, reject) => server.bindAsync(`127.0.0.1:${port}`, grpc.ServerCredentials.createInsecure(), error => error ? reject(error) : resolve()));
      if (forwardFailure) throw new Error("HDC forward result is uncertain");
    }
    return { stdout: Buffer.from(text), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
  };
  const start = async (serial = "phone", knownVersion) => { const session = await MirrorCaptureSession.start(serial, run, () => { closes++; }, directory, knownVersion); sessions.push(session); return session; };
  const send = bytes => { const reply = new ReplyMessage(), value = new ParamValue(); value.setValBytes(bytes); reply.getPayloadMap().set("data", value); source.write(reply); };
  const waitSource = async () => { for (let i = 0; !source && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(source); };
  return { start, send, calls, sources, waitSource, directory, setOffline() { offline = true; }, get closes() { return closes; }, get uploaded() { return uploaded; } };
}

test("a fresh device version skips the redundant startup query", async t => {
  const f = await fixture(t);
  await f.start("phone", "7.0.0.1");
  assert.equal(f.calls.some(call => call.operation === "debug_video_version"), false);
  assert.ok(f.calls.some(call => call.operation === "debug_video_start"));
});

test("a clean PC starts H264 viewing and recording from the bundled runtime without an IDE or HAP", async t => {
  const f = await fixture(t);
  const session = await f.start();
  assert.deepEqual(f.uploaded, await readBundledVideoLibrary("7.0.0.1"));
  const viewer = session.subscribe(), reader = viewer.stream.getReader();
  const recording = session.subscribe(undefined, true), recorded = recording.stream.getReader();
  await recorded.read();
  await f.waitSource(); f.send(config); f.send(annex([0x65, 1]));
  assert.equal(Buffer.from((await reader.read()).value).readUInt32BE(0), 2);
  assert.equal(Buffer.from((await reader.read()).value).readUInt32BE(0), 3);
  await recorded.read(); await recorded.read();
  await viewer.close(); assert.equal(f.closes, 0);
  f.send(annex([0x41, 2]));
  assert.equal(Buffer.from((await recorded.read()).value).readUInt32BE(0), 3);
  await recording.close(); assert.equal(f.closes, 0, "an empty session stays warm briefly");
  await session.close(); assert.equal(f.closes, 1);
  assert.equal(f.calls.some(c => c.args.some(arg => /bm install|aa start|wake|unlock/.test(arg))), false);
});

test("viewing and recording share video; closing one retains the other and cleanup targets the daemon child", { timeout: 15000 }, async t => {
  const f = await fixture(t), session = await f.start();
  t.after(() => session.close());
  const first = session.subscribe(), reader = first.stream.getReader();
  await f.waitSource(); f.send(config); f.send(annex([0x65, 1]));
  assert.equal(Buffer.from((await reader.read()).value).readUInt32BE(0), 2);
  assert.equal(Buffer.from((await reader.read()).value)[8], 1);
  const second = session.subscribe(undefined, true), recording = second.stream.getReader();
  assert.deepEqual([...((await recording.read()).value)], [0, 0, 0, 0x21, 0, 0, 0, 1, 1]);
  assert.equal(Buffer.from((await recording.read()).value).readUInt32BE(0), 2);
  await first.close(); assert.equal(f.closes, 0);
  f.send(annex([0x41, 2])); f.send(annex([0x65, 3]));
  assert.equal(Buffer.from((await recording.read()).value)[8], 1, "a new viewer must wait for a keyframe");
  const pending = recording.read();
  await Promise.all([second.close(), second.close()]);
  assert.equal((await pending).done, true); assert.equal(f.closes, 0);
  await session.close(); assert.equal(f.closes, 1);
  assert.deepEqual(f.calls.filter(c => c.operation === "debug_video_stop").map(c => c.args[3]), ["kill -9 5678"]);
  assert.equal(f.calls.filter(c => c.operation === "debug_video_forward_cleanup").length, 1);
  assert.equal(f.calls.some(c => c.args.some(arg => /aa start|bm install|wake|unlock/.test(arg))), false);
});

test("an existing foreign service is rejected without subscribing or changing its daemon", async t => {
  const f = await fixture(t, true);
  await assert.rejects(f.start(), error => error.code === "DEVICE_BUSY" && error.details?.reason === "debug-video-busy");
  assert.equal(f.calls.some(c => ["debug_video_forward", "debug_video_start", "debug_video_upload", "debug_video_stop", "debug_video_file_cleanup"].includes(c.operation)), false);
  assert.deepEqual(await readdir(join(f.directory, "records")), []);
});

test("missing bundled libraries fail without starting a phone app or an external runtime", async t => {
  const f = await fixture(t), previous = process.env.PIORA_WEB_RUNTIME_ROOT;
  process.env.PIORA_WEB_RUNTIME_ROOT = join(f.directory, "missing-runtime");
  t.after(() => { if (previous === undefined) delete process.env.PIORA_WEB_RUNTIME_ROOT; else process.env.PIORA_WEB_RUNTIME_ROOT = previous; });
  await assert.rejects(f.start(), error => error.details?.reason === "debug-video-library-unavailable");
  assert.equal(f.calls.some(c => ["debug_video_start", "debug_video_upload", "debug_video_forward"].includes(c.operation)), false);
  assert.equal(f.calls.some(c => c.args.some(arg => /bm install|aa start|java|wake|unlock/.test(arg))), false);
});

test("corrupt bundled bytes are rejected before device upload", async t => {
  const f = await fixture(t), previous = process.env.PIORA_WEB_RUNTIME_ROOT;
  const root = join(f.directory, "runtime");
  await cp(new URL("../third_party/harmony-video/", import.meta.url), join(root, "third_party/harmony-video"), { recursive: true });
  const path = join(root, "third_party/harmony-video", videoManifest.assets[1].name), bytes = await readFile(path); bytes[bytes.length - 1] ^= 1; await writeFile(path, bytes);
  process.env.PIORA_WEB_RUNTIME_ROOT = root;
  t.after(() => { if (previous === undefined) delete process.env.PIORA_WEB_RUNTIME_ROOT; else process.env.PIORA_WEB_RUNTIME_ROOT = previous; });
  await assert.rejects(f.start(), error => error.details?.reason === "debug-video-library-unavailable");
  assert.equal(f.calls.some(c => ["debug_video_upload", "debug_video_start"].includes(c.operation)), false);
});

test("a stalled viewer resynchronizes on the same stream while recording keeps every frame", { timeout: 5000 }, async t => {
  const f = await fixture(t), session = await f.start();
  const viewer = session.subscribe(), reader = viewer.stream.getReader();
  const recording = session.subscribe(undefined, true), recorded = recording.stream.getReader();
  await recorded.read(); // Recording isolation acknowledgement.
  await f.waitSource(); f.send(config); f.send(annex([0x65, 1]));
  await reader.read(); await reader.read();
  await recorded.read(); await recorded.read();
  for (let i = 0; i < 9; i++) {
    f.send(annex([0x41, i]));
    assert.equal(Buffer.from((await recorded.read()).value).readUInt32BE(0), 3);
  }
  // A short gRPC burst is healthy; this viewer is stalled only after its
  // retained frames have actually exceeded the latency budget.
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(Buffer.from((await reader.read()).value).readUInt32BE(0), 2, "drop the obsolete GOP and send its configuration again");
  let resumed = false;
  const waiting = reader.read().then(value => { resumed = true; return value; });
  f.send(annex([0x41, 40]));
  await recorded.read();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(resumed, false, "never resume on a delta with missing references");
  f.send(annex([0x65, 41]));
  assert.equal(Buffer.from((await waiting).value)[8], 1);
  assert.equal(Buffer.from((await recorded.read()).value)[8], 1);
  assert.equal(f.sources.length, 1, "recovery must not restart the capture RPC");
  assert.equal(f.closes, 0, "a slow viewer cannot stop the shared recording encoder");
  f.send(annex([0x41, 10]));
  assert.equal(Buffer.from((await recorded.read()).value).readUInt32BE(0), 3);
  await recording.close();
  await session.close();
  assert.equal(f.closes, 1);
});

test("owned subscriber disconnect preserves its recoverable forward while the phone is offline", async t => {
  const f = await fixture(t), session = await f.start();
  const connection = session.subscribe(), reader = connection.stream.getReader();
  await f.waitSource();
  f.setOffline();
  await connection.close();
  await session.close();
  assert.equal((await reader.read()).done, true);
  const records = (await readdir(join(f.directory, "records"))).filter(name => name.endsWith(".json"));
  assert.equal(records.length, 1);
  assert.equal(f.calls.some(c => ["debug_video_stop", "debug_video_file_cleanup"].includes(c.operation)), false);
});

test("an ambiguous owned forward failure retains recovery intent and cleans only its own daemon", async t => {
  const f = await fixture(t, false, true);
  await assert.rejects(f.start(), /forward result is uncertain/);
  const records = (await readdir(join(f.directory, "records"))).filter(name => name.endsWith(".json"));
  assert.equal(records.length, 1);
  assert.equal(f.calls.filter(c => c.operation === "debug_video_stop").length, 1);
  assert.equal(f.calls.some(c => c.args.some(arg => /killall|pkill/.test(arg))), false);
});

test("aborting the final subscriber settles its read immediately; explicit shutdown awaits cleanup", async t => {
  const f = await fixture(t), session = await f.start(), abort = new AbortController();
  const connection = session.subscribe(abort.signal), reader = connection.stream.getReader();
  const pending = reader.read(); abort.abort(); await connection.close();
  assert.equal((await pending).done, true); assert.equal(f.closes, 0);
  await session.close(); assert.equal(f.closes, 1);
});

test("disconnect closes local readers while retaining durable cleanup so recorded frames can finalize offline", async t => {
  const f = await fixture(t), session = await f.start();
  const connection = session.subscribe(undefined, true), reader = connection.stream.getReader();
  await reader.read(); // Isolation acknowledgement.
  f.setOffline();
  await connection.close();
  await session.close();
  assert.equal((await reader.read()).done, true);
  assert.equal(f.closes, 1);
  assert.equal((await readdir(join(f.directory, "records"))).filter(name => name.endsWith(".json")).length, 1);
  assert.deepEqual(await readdir(join(f.directory, "locks")), [], "local viewing ownership is released despite an offline phone");
});

test("renderer handoff reuses one encoder and idle grace eventually cleans up its exact resources", { timeout: 12000 }, async t => {
  const f = await fixture(t), session = await f.start();
  const first = session.subscribe(), reader = first.stream.getReader();
  await f.waitSource(); f.send(config); f.send(annex([0x65, 1]));
  await reader.read(); await reader.read();
  await first.close();
  const second = session.subscribe(), replacement = second.stream.getReader();
  assert.equal(Buffer.from((await replacement.read()).value).readUInt32BE(0), 2);
  f.send(annex([0x41, 2])); f.send(annex([0x65, 3]));
  assert.equal(Buffer.from((await replacement.read()).value)[8], 1, "handoff starts at a complete keyframe");
  assert.equal(f.sources.length, 1, "the native stream is not restarted");
  assert.equal(f.calls.filter(call => call.operation === "debug_video_start").length, 1);
  assert.equal(f.closes, 0);
  await second.close();
  for (let i = 0; f.closes === 0 && i < 120; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.closes, 1, "an abandoned viewer cannot leak an encoder after the grace period");
  assert.equal(f.calls.filter(call => call.operation === "debug_video_stop").length, 1);
  assert.equal(f.calls.filter(call => call.operation === "debug_video_forward_cleanup").length, 1);
  await assert.rejects(async () => session.subscribe(), /closing/);
});

test("phone and tablet use separate native streams and closing one cannot affect the other", { timeout: 10000 }, async t => {
  const phone=await fixture(t), tablet=await fixture(t);
  const first=await phone.start("phone"), second=await tablet.start("tablet");
  const phoneView=first.subscribe(), tabletView=second.subscribe();
  const phoneReader=phoneView.stream.getReader(), tabletReader=tabletView.stream.getReader();
  await Promise.all([phone.waitSource(),tablet.waitSource()]);
  phone.send(config);phone.send(annex([0x65,1]));
  tablet.send(annex(sps(2880,1920),[0x68,0xce,6]));tablet.send(annex([0x65,2]));
  const phoneConfig=Buffer.from((await phoneReader.read()).value);
  const tabletConfig=Buffer.from((await tabletReader.read()).value);
  assert.equal(phoneConfig.readUInt32BE(9),640);
  assert.equal(tabletConfig.readUInt32BE(9),2880);assert.equal(tabletConfig.readUInt32BE(13),1920);
  await phoneReader.read();await tabletReader.read();
  await phoneView.close();await first.close();
  tablet.send(annex([0x41,3]));assert.equal(Buffer.from((await tabletReader.read()).value)[8],0);
  assert.equal(phone.closes,1);assert.equal(tablet.closes,0);
  assert.ok(phone.calls.every(call=>call.args[1]==="phone"));
  assert.ok(tablet.calls.every(call=>call.args[1]==="tablet"));
  assert.notEqual(phone.calls.find(call=>call.operation==="debug_video_forward").args[3],tablet.calls.find(call=>call.operation==="debug_video_forward").args[3]);
  await tabletView.close();await second.close();assert.equal(tablet.closes,1);
});
