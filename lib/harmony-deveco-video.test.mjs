import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { createJiti } from "jiti";
import JSZip from "jszip";
import grpc from "@grpc/grpc-js";
const require = createRequire(import.meta.url);
const { ReplyMessage, ParamValue } = require("hypium-driver/build/lib/generated/scrcpy/scrcpy_pb.js");
const { ScrcpyServiceService } = require("hypium-driver/build/lib/generated/scrcpy/scrcpy_grpc_pb.js");
const jiti = createJiti(import.meta.url);
const { DevEcoVideoSession } = await jiti.import("./harmony/deveco-video.ts");
const { selectVideoLibrary, selectBundledVideoLibrary, findDebugVideoSource, readDebugVideoLibrary } = await jiti.import("./harmony/runtime/deveco-video-library.ts");
const bundledResources = join(dirname(require.resolve("hypium-driver/package.json")), "build/lib/resource");
const { avcSize } = await jiti.import("./harmony/media/avc-size.ts");

const ue = n => { const b = (n + 1).toString(2); return "0".repeat(b.length - 1) + b; };
function sps(width = 640, height = 480) {
  const bits = [ue(0), ue(0), ue(0), ue(0), ue(1), "0", ue(width / 16 - 1), ue(height / 16 - 1), "1101"].join("");
  return Buffer.concat([Buffer.from([0x67, 66, 0, 30]), Buffer.from((bits + "0".repeat((8 - bits.length % 8) % 8)).match(/.{8}/g).map(b => parseInt(b, 2)))]);
}
const annex = (...units) => Buffer.concat(units.flatMap(unit => [Buffer.from([0, 0, 0, 1]), Buffer.from(unit)]));
const config = annex(sps(), [0x68, 0xce, 6]);

test("SDK selection uses the newest compatible Unix library and rejects paths/unsupported versions", () => {
  const names = ["libscrcpy/libscrcpy_server_unix_6.4-20260113.z.so", "libscrcpy/libscrcpy_server_unix_6.6-20260418.z.so", "../libscrcpy/libscrcpy_server_unix_9.0-20260418.z.so"];
  assert.equal(selectVideoLibrary(names, "7.0.0.1"), names[1]);
  assert.equal(selectVideoLibrary(names, "6.4.0.0"), names[0]);
  assert.equal(selectVideoLibrary(names, "5.0.0"), undefined);
  assert.equal(selectVideoLibrary(names, "bad reply"), undefined);
});

test("bundled discovery works with no IDE and selects only compatible versioned socket libraries", async () => {
  const source = await findDebugVideoSource("missing-hdc", async () => undefined, bundledResources);
  assert.equal(source, bundledResources);
  const names = ["libscrcpy_server-6.3.1-20260113.so", "libscrcpy_server-6.4-20260113.so", "libscrcpy_server4.z.so", "../libscrcpy_server-7.0-20260113.so"];
  assert.equal(selectBundledVideoLibrary(names, "6.3.1.0"), names[0]);
  assert.equal(selectBundledVideoLibrary(names, "7.0.0.1"), names[1]);
  assert.equal(selectBundledVideoLibrary(names, "5.0"), undefined);
  assert.equal(selectBundledVideoLibrary(names, "invalid version"), undefined);
  const bytes = await readDebugVideoLibrary(source, "7.0.0.1");
  assert.deepEqual(bytes, await readFile(join(bundledResources, names[1])), "use the existing packaged dependency, not an IDE binary");
  await assert.rejects(readDebugVideoLibrary(source, "5.0"), /no compatible/);
  assert.equal(await findDebugVideoSource("missing-hdc", async () => { throw Error("stale installation"); }, bundledResources), source);
  assert.equal(await findDebugVideoSource("missing-hdc", async () => undefined, join(bundledResources, "absent")), undefined);
});

test("optional SDK discovery keeps its source while an unreadable SDK falls back to bundled capture", async () => {
  assert.equal(await findDebugVideoSource("hdc", async () => "installed.jar", bundledResources), "installed.jar");
  const bytes = await readDebugVideoLibrary(join(bundledResources, "missing.jar"), "7.0.0.1");
  assert.deepEqual(bytes, await readDebugVideoLibrary(bundledResources, "7.0.0.1"));
});

test("bundled capture rejects wrong architectures, malformed and oversized libraries", async t => {
  const directory = await mkdtemp(join(tmpdir(), "piora-video-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "libscrcpy_server-6.4-20260113.so");
  for (const data of [Buffer.alloc(64), Buffer.alloc(4 * 1024 * 1024 + 1)]) {
    await writeFile(path, data);
    await assert.rejects(readDebugVideoLibrary(directory, "7.0"));
  }
  const elf = Buffer.alloc(64); Buffer.from("7f454c46", "hex").copy(elf); elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(62, 18);
  await writeFile(path, elf);
  await assert.rejects(readDebugVideoLibrary(directory, "7.0"), /ARM64/);
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
  const zip = new JSZip(), elf = Buffer.alloc(64);
  Buffer.from("7f454c46", "hex").copy(elf); elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(183, 18);
  zip.file("libscrcpy/libscrcpy_server_unix_6.6-20260418.z.so", elf);
  const jar = join(directory, "test.jar"); await writeFile(jar, await zip.generateAsync({ type: "nodebuffer" }));
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
  const start = async (sdk = jar, serial = "phone") => { const session = await DevEcoVideoSession.start(serial, sdk || undefined, run, () => { closes++; }, directory); sessions.push(session); return session; };
  const send = bytes => { const reply = new ReplyMessage(), value = new ParamValue(); value.setValBytes(bytes); reply.getPayloadMap().set("data", value); source.write(reply); };
  const waitSource = async () => { for (let i = 0; !source && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(source); };
  return { start, send, calls, sources, waitSource, directory, setOffline() { offline = true; }, get closes() { return closes; }, get uploaded() { return uploaded; } };
}

test("a clean PC starts H264 viewing and recording from the bundled runtime without an IDE or HAP", async t => {
  const f = await fixture(t);
  const source = await findDebugVideoSource("bundled-hdc", async () => undefined, bundledResources);
  const session = await f.start(source);
  assert.deepEqual(f.uploaded, await readDebugVideoLibrary(bundledResources, "7.0.0.1"));
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

test("an existing video service is shared without stopping the other subscriber", async t => {
  const f = await fixture(t, true), session = await f.start(null);
  const forward = f.calls.find(c => c.operation === "debug_video_forward");
  const port = Number(forward.args[3].slice(4));
  const peer = new grpc.Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
  const peerStream = peer.makeServerStreamRequest("/ScrcpyService/onStart", () => Buffer.alloc(0), ScrcpyServiceService.onStart.responseDeserialize, Buffer.alloc(0));
  peerStream.on("error", () => {}); // Expected cancellation during fixture cleanup.
  t.after(() => { peerStream.cancel(); peer.close(); });
  await f.waitSource();
  const connection = session.subscribe(), reader = connection.stream.getReader();
  for (let i = 0; f.sources.length < 2 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.sources.length, 2);
  f.send(config); f.send(annex([0x65, 1]));
  assert.equal(Buffer.from((await reader.read()).value).readUInt32BE(0), 2);
  assert.equal(Buffer.from((await reader.read()).value)[8], 1);
  await connection.close();
  await session.close();
  assert.equal(f.sources[0].cancelled, false, "the other subscriber remains connected");
  const continued = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("peer did not receive a frame after Piora closed")), 1000);
    peerStream.once("data", value => { clearTimeout(timer); resolve(value); });
  });
  const reply = new ReplyMessage(), value = new ParamValue();
  value.setValBytes(annex([0x65, 7])); reply.getPayloadMap().set("data", value);
  f.sources[0].write(reply);
  assert.ok(await continued, "the other subscriber continues receiving video");
  assert.equal(f.calls.some(c => ["debug_video_start", "debug_video_upload", "debug_video_stop", "debug_video_file_cleanup"].includes(c.operation)), false);
  assert.equal(f.calls.filter(c => c.operation === "debug_video_forward_cleanup").length, 1);
});

test("missing SDK and device service reports the dependency instead of opening a phone app", async t => {
  const f = await fixture(t);
  await assert.rejects(f.start(null), error => error.details?.reason === "debug-video-sdk-missing");
  assert.equal(f.calls.some(c => ["debug_video_start", "debug_video_upload", "debug_video_version"].includes(c.operation)), false);
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

test("shared subscriber disconnect preserves a recoverable forward without touching the external service", async t => {
  const f = await fixture(t, true), session = await f.start();
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

test("an ambiguous shared forward failure retains its recovery record without stopping the external service", async t => {
  const f = await fixture(t, true, true);
  await assert.rejects(f.start(), /forward result is uncertain/);
  const records = (await readdir(join(f.directory, "records"))).filter(name => name.endsWith(".json"));
  assert.equal(records.length, 1);
  assert.equal(f.calls.some(c => ["debug_video_stop", "debug_video_file_cleanup"].includes(c.operation)), false);
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
  const first=await phone.start(undefined,"phone"), second=await tablet.start(undefined,"tablet");
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
