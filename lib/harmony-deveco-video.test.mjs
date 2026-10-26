import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createJiti } from "jiti";
import JSZip from "jszip";
import grpc from "@grpc/grpc-js";
const require = createRequire(import.meta.url);
const { ReplyMessage, ParamValue } = require("hypium-driver/build/lib/generated/scrcpy/scrcpy_pb.js");
const { ScrcpyServiceService } = require("hypium-driver/build/lib/generated/scrcpy/scrcpy_grpc_pb.js");
const jiti = createJiti(import.meta.url);
const { DevEcoVideoSession } = await jiti.import("./harmony/deveco-video.ts");
const { selectVideoLibrary } = await jiti.import("./harmony/runtime/deveco-video-library.ts");
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

test("SPS dimensions follow encoded orientation and reject truncated/oversized data", () => {
  assert.deepEqual(avcSize(sps()), { width: 640, height: 480 });
  assert.deepEqual(avcSize(sps(480, 640)), { width: 480, height: 640 });
  assert.equal(avcSize(Buffer.from([0x67, 100])), undefined);
  assert.equal(avcSize(Buffer.alloc(5000, 0x67)), undefined);
});

async function fixture(t, busy = false) {
  const directory = await mkdtemp(join(tmpdir(), "piora-debug-video-test-"));
  const sessions = [];
  t.after(async () => { for (const session of sessions) await session.close(); await rm(directory, { recursive: true, force: true }); });
  const zip = new JSZip(), elf = Buffer.alloc(64);
  Buffer.from("7f454c46", "hex").copy(elf); elf[4] = 2; elf.writeUInt16LE(183, 18);
  zip.file("libscrcpy/libscrcpy_server_unix_6.6-20260418.z.so", elf);
  const jar = join(directory, "test.jar"); await writeFile(jar, await zip.generateAsync({ type: "nodebuffer" }));
  const server = new grpc.Server(), calls = []; let source, name, started = false, closes = 0, offline = false;
  server.addService(ScrcpyServiceService, { onStart(call) { source = call; }, onEnd(_call, done) { assert.fail("must not call global onEnd"); done(); } });
  t.after(() => server.forceShutdown());
  const run = async (args, operation) => {
    calls.push({ args, operation }); let text = "";
    if (offline) throw new Error("HDC device disconnected");
    if (operation === "debug_video_version") text = "7.0.0.1";
    if (operation === "debug_video_socket_check" && busy || operation === "debug_video_ready") text = "@scrcpy_grpc_socket";
    if (operation === "debug_video_start") { name = args[3].match(/--extension-name (\S+)/)[1]; started = true; text = "1234"; }
    if (operation === "debug_video_owner" && started) text = `shell 5678 1 0 12:00 ? 00:00:00 uitest start-daemon singleness --extension-name ${name}`;
    if (operation === "debug_video_forward") {
      const port = Number(args[3].slice(4));
      await new Promise((resolve, reject) => server.bindAsync(`127.0.0.1:${port}`, grpc.ServerCredentials.createInsecure(), error => error ? reject(error) : resolve()));
    }
    return { stdout: Buffer.from(text), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
  };
  const start = async () => { const session = await DevEcoVideoSession.start("phone", jar, run, () => { closes++; }, directory); sessions.push(session); return session; };
  const send = bytes => { const reply = new ReplyMessage(), value = new ParamValue(); value.setValBytes(bytes); reply.getPayloadMap().set("data", value); source.write(reply); };
  const waitSource = async () => { for (let i = 0; !source && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(source); };
  return { start, send, calls, waitSource, directory, setOffline() { offline = true; }, get closes() { return closes; } };
}

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
  assert.equal((await pending).done, true); assert.equal(f.closes, 1);
  assert.deepEqual(f.calls.filter(c => c.operation === "debug_video_stop").map(c => c.args[3]), ["kill -9 5678"]);
  assert.equal(f.calls.filter(c => c.operation === "debug_video_forward_cleanup").length, 1);
  assert.equal(f.calls.some(c => c.args.some(arg => /aa start|bm install|wake|unlock/.test(arg))), false);
});

test("another IDE's video service is not stopped or overwritten", async t => {
  const f = await fixture(t, true);
  await assert.rejects(f.start(), error => error.code === "DEVICE_BUSY");
  assert.equal(f.calls.some(c => ["debug_video_start", "debug_video_upload", "debug_video_stop", "debug_video_forward"].includes(c.operation)), false);
});

test("aborting the final subscriber settles a pending read and awaits cleanup", async t => {
  const f = await fixture(t), session = await f.start(), abort = new AbortController();
  const connection = session.subscribe(abort.signal), reader = connection.stream.getReader();
  const pending = reader.read(); abort.abort(); await connection.close();
  assert.equal((await pending).done, true); assert.equal(f.closes, 1);
});

test("disconnect closes local readers while retaining durable cleanup so recorded frames can finalize offline", async t => {
  const f = await fixture(t), session = await f.start();
  const connection = session.subscribe(undefined, true), reader = connection.stream.getReader();
  await reader.read(); // Isolation acknowledgement.
  f.setOffline();
  await connection.close();
  assert.equal((await reader.read()).done, true);
  assert.equal(f.closes, 1);
  assert.equal((await readdir(join(f.directory, "records"))).filter(name => name.endsWith(".json")).length, 1);
  assert.deepEqual(await readdir(join(f.directory, "locks")), [], "local viewing ownership is released despite an offline phone");
});
