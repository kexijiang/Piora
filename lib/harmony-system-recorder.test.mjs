import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { HdcBackend } = await jiti.import("./harmony/index.ts");
const recorder = await jiti.import("./harmony/media/system-recorder.ts");
const { startOwnedRecording } = await jiti.import("./harmony/media/owned-recording.ts");
const { HarmonyRequestError } = await jiti.import("./harmony/request-error.ts");
const encoded = JSON.parse(await readFile(new URL("../tests/harmony-media/h264-64x64.json", import.meta.url), "utf8"));

const HDC = "C:\\HarmonySDK\\toolchains\\hdc.exe";
const SERIAL = "phone-1";
const REMOTE = "piora-recording-0123456789abcdef01234567.mp4";
const BUNDLE = "com.huawei.hmos.screenrecorder";
const IDLE_DUMP = "User ID #100\n  current mission lists:{\n    bundle name [com.huawei.hmos.launcher]\n  }\n";
const RECORDING_DUMP = `${IDLE_DUMP}  ExtensionRecord\n    bundle name [${BUNDLE}]\n    ability name [${BUNDLE}.ServiceExtAbility]\n`;
const reply = (text) => ({ stdout: Buffer.from(text), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 });
const FAST = { pollIntervalMs: 5, retrieveTimeoutMs: 60, confirmTimeoutMs: 30, transferTimeoutMs: 1000 };

function packet(type, payload) {
  const header = Buffer.alloc(8); header.writeUInt32BE(type); header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}
function h264Packets() {
  const avcc = Buffer.from(encoded.config), sl = avcc.readUInt16BE(6), pl = avcc.readUInt16BE(9 + sl);
  const config = Buffer.alloc(17 + sl + pl);
  config.writeUInt32BE(64, 1); config.writeUInt32BE(64, 5); config.writeUInt32BE(30, 9);
  config.writeUInt16BE(sl, 13); avcc.subarray(8, 8 + sl).copy(config, 15);
  config.writeUInt16BE(pl, 15 + sl); avcc.subarray(11 + sl, 11 + sl + pl).copy(config, 17 + sl);
  const chunk = encoded.chunks[0], raw = Buffer.from(chunk.data), units = [];
  for (let offset = 0; offset < raw.length;) {
    const size = raw.readUInt32BE(offset); units.push(Buffer.from([0, 0, 0, 1]), raw.subarray(offset + 4, offset + 4 + size)); offset += 4 + size;
  }
  const header = Buffer.alloc(9); header[0] = 1; header.writeBigUInt64BE(BigInt(chunk.timestamp), 1);
  return [packet(2, config), packet(3, Buffer.concat([header, ...units]))];
}

/**
 * A scripted phone. `state` is the observable system recorder state; the aa start toggle flips it
 * unless `toggleWorks` is false. `galleryAfterQueries` controls when mediatool can see the file.
 */
function phone(options = {}) {
  const calls = [];
  const device = { huawei: true, state: "idle", toggleWorks: true, startReply: "start ability successfully.", galleryAfterQueries: 1,
    queries: 0, uri: true, dumpUnknown: false, ...options };
  const execute = async ({ args }) => {
    calls.push(args);
    if (args[2] === "file" && args[3] === "recv") { await writeFile(args[5], "system-video"); return reply("FileTransfer finish, Size:12"); }
    const command = args.slice(3).join(" ");
    if (command.startsWith("bm dump -n com.huawei.hmos.screenrecorder")) return reply(device.huawei ? `${BUNDLE}:\n{ "bundleName": "${BUNDLE}" }` : "error: failed to get information and the bundle is not exist.");
    if (command.startsWith("hidumper -s ScreenlockService")) return reply("screenLocked: false");
    if (command === "aa dump -a") return reply(device.dumpUnknown ? "" : device.state === "recording" ? RECORDING_DUMP : IDLE_DUMP);
    if (command.startsWith(`aa start -b ${BUNDLE}`)) {
      const starting = args.includes("--ps");
      if (starting) {
        device.started = args.at(-1);
        if (device.startReply !== "start ability successfully.") return reply(device.startReply);
      }
      if (device.toggleWorks) device.state = device.state === "recording" ? "idle" : "recording";
      return reply("start ability successfully.");
    }
    if (command.startsWith("mediatool query")) {
      device.queries++;
      const name = args[5];
      if (device.queries < device.galleryAfterQueries) return reply("");
      return reply(device.uri ? `find 1 result:\nuri, display_name, data\nfile://media/Photo/2/VID_1736853237_001/${name}, ${name}, /storage/cloud/files/Photo/2/VID_1736853237_001.mp4\n`
        : `find 1 result:\n/storage/media/100/local/files/Docs/${name}\n`);
    }
    if (command.startsWith("mediatool recv")) return reply(`recv success\n/data/local/tmp/${device.started}\n`);
    if (command.startsWith("rm -f")) return reply("");
    return reply("");
  };
  const backend = new HdcBackend({ hdcPath: HDC, resolve: { platform: "win32", exists: (path) => path === HDC, listDirectory: () => [] },
    execute, systemRecorder: FAST, prepareMirrorHap: async (_serial, path) => path });
  return { backend, calls, device, commands: () => calls.map(args => args.slice(2).join(" ")) };
}

function streamConnection(feed) {
  let controller, closes = 0;
  const connection = { stream: new ReadableStream({ start(value) { controller = value; } }), async close() { closes++; } };
  queueMicrotask(() => feed(controller));
  return { connection, closes: () => closes };
}

test("generated system recording names are program-only and strictly alphanumeric with hyphens", () => {
  const name = recorder.generateSystemRecordingName(1_760_000_000_000, Buffer.from("a1b2c3d4e5f6", "hex"));
  assert.equal(name, "piora-1760000000000-a1b2c3d4e5f6.mp4");
  for (let i = 0; i < 50; i++) {
    const generated = recorder.generateSystemRecordingName();
    assert.match(generated, /^piora-\d{13}-[A-Za-z0-9]+\.mp4$/);
    assert.match(generated.replace(/\.mp4$/, ""), /^[A-Za-z0-9-]+$/);
    assert.equal(recorder.isSystemRecordingName(generated), true);
  }
});

test("the name validator rejects shell injection and anything outside the generated format", () => {
  for (const value of [
    "piora-1760000000000-abc;rm -rf.mp4", "piora-1760000000000-abcdef12.mp4; reboot", "piora-1760000000000-$(id)abcd.mp4",
    "piora-1760000000000-abcd`id`.mp4", "piora-1760000000000-abcdef12.mp4\nrm", "../piora-1760000000000-abcdef12.mp4",
    "piora-1760000000000-abc def12.mp4", "piora-1760000000000-abcdef12.MP4", "piora-1760000000000-abcdef12.mp4 ", "piora-176-abcdef12.mp4",
    "user-video.mp4", "piora-1760000000000-abc'def12.mp4", "piora-1760000000000-abc\"def12.mp4", "piora-1760000000000-abc|def12.mp4",
    "piora-1760000000000-ab&cdef12.mp4", "piora-1760000000000-abc_def12.mp4", "", undefined, 42,
  ]) {
    assert.equal(recorder.isSystemRecordingName(value), false, String(value));
    assert.throws(() => recorder.assertSystemRecordingName(value), error => error.code === "INVALID_ARGUMENT");
  }
  assert.throws(() => recorder.systemRecorderToggleArgs("x;reboot.mp4"), error => error.code === "INVALID_ARGUMENT");
  assert.deepEqual(recorder.systemRecorderToggleArgs(), ["aa", "start", "-b", BUNDLE, "-a", `${BUNDLE}.ServiceExtAbility`]);
});

test("recorder state parsing is conservative: only a recognisable dump without the recorder is idle", () => {
  assert.equal(recorder.parseSystemRecorderState(IDLE_DUMP), "idle");
  assert.equal(recorder.parseSystemRecorderState(RECORDING_DUMP), "recording");
  assert.equal(recorder.parseSystemRecorderState(""), "unknown");
  assert.equal(recorder.parseSystemRecorderState("something unexpected"), "unknown");
  assert.equal(recorder.parseSystemRecorderState("[Fail]ExecuteCommand need connect-key?"), "unknown");
  const name = "piora-1760000000000-a1b2c3d4e5f6.mp4";
  assert.deepEqual(recorder.parseMediatoolQuery(`uri\nfile://media/Photo/2/VID_1/${name}\n`, name), { kind: "uri", uri: `file://media/Photo/2/VID_1/${name}` });
  assert.deepEqual(recorder.parseMediatoolQuery(`find 1 result:\n/storage/media/100/${name}\n`, name), { kind: "path", path: `/storage/media/100/${name}` });
  assert.equal(recorder.parseMediatoolQuery(`uri\nfile://media/Photo/2/VID_1/other.mp4\n`, name), undefined);
  assert.equal(recorder.parseMediatoolQuery(`/storage/../etc/${name}`, name), undefined);
  assert.equal(recorder.parseMediatoolQuery("find 0 result", name), undefined);
});

test("Huawei phones record with the system recorder, then copy the gallery file and remove only the staging copy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-system-recorder-"));
  try {
    const { backend, device, commands } = phone({ galleryAfterQueries: 2 });
    let streamOpened = false;
    backend.openVideoStream = async () => { streamOpened = true; throw new Error("stream path must not be used"); };
    assert.deepEqual(await backend.startRecording(SERIAL, REMOTE), { method: "system-recorder" });
    assert.equal(device.state, "recording");
    assert.match(device.started, /^piora-\d{13}-[a-f0-9]{12}\.mp4$/);
    const destination = join(directory, "saved.mp4");
    assert.equal(await backend.stopRecording(SERIAL, REMOTE, destination), "system-video".length);
    assert.equal(await readFile(destination, "utf8"), "system-video");
    assert.equal(device.state, "idle");
    assert.equal(streamOpened, false);
    const log = commands();
    const toggles = log.filter(command => command.startsWith(`shell aa start -b ${BUNDLE}`));
    assert.deepEqual(toggles, [
      `shell aa start -b ${BUNDLE} -a ${BUNDLE}.ServiceExtAbility --ps CustomizedFileName ${device.started}`,
      `shell aa start -b ${BUNDLE} -a ${BUNDLE}.ServiceExtAbility`,
    ]);
    assert.ok(log.includes(`shell mediatool recv file://media/Photo/2/VID_1736853237_001/${device.started} /data/local/tmp`));
    assert.ok(log.includes(`file recv /data/local/tmp/${device.started} ${destination}`));
    const removals = log.filter(command => /\brm\b/.test(command));
    assert.deepEqual(removals, [`shell rm -f /data/local/tmp/${device.started}`], "the gallery copy is never deleted");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a gallery path without a uri is pulled directly and nothing on the phone is removed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-system-recorder-"));
  try {
    const { backend, device, commands } = phone({ uri: false });
    await backend.startRecording(SERIAL, REMOTE);
    await backend.stopRecording(SERIAL, REMOTE, join(directory, "saved.mp4"));
    assert.ok(commands().includes(`file recv /storage/media/100/local/files/Docs/${device.started} ${join(directory, "saved.mp4")}`));
    assert.equal(commands().some(command => /\brm\b|mediatool recv/.test(command)), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a recording mediatool never finds reports that it stayed in the phone gallery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-system-recorder-"));
  try {
    const { backend, device, commands } = phone({ galleryAfterQueries: Infinity });
    await backend.startRecording(SERIAL, REMOTE);
    const destination = join(directory, "saved.mp4");
    const failure = await backend.stopRecording(SERIAL, REMOTE, destination).then(() => undefined, error => error);
    assert.equal(failure.code, "COMMAND_TIMEOUT");
    assert.equal(failure.details.reason, "system-recording-not-transferred");
    assert.equal(failure.details.recordingStopped, true);
    assert.ok(device.queries >= 2, "mediatool query is retried until the cap");
    assert.equal(commands().some(command => /\brm\b|file recv/.test(command)), false);
    const shown = new HarmonyRequestError({ code: failure.code, message: failure.message, details: failure.details }, 504);
    assert.match(shown.messageFor(true), /^录屏已保存在手机图库，但没能传到电脑/);
    assert.match(shown.messageFor(false), /saved in the phone gallery/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a rejected system recorder start falls back to the stream recording", async () => {
  const { backend, device } = phone({ startReply: "error: start ability failed, resolve ability err." , toggleWorks: false });
  const { connection } = streamConnection(controller => { for (const value of h264Packets()) controller.enqueue(value); });
  let opened = 0;
  backend.openVideoStream = async () => { opened++; return connection; };
  assert.deepEqual(await backend.startRecording(SERIAL, REMOTE), { method: "stream" });
  assert.equal(opened, 1); assert.equal(device.state, "idle");
  await backend.dispose();
});

test("an already running or unreadable system recorder is never toggled; recording falls back to the stream", async () => {
  for (const setup of [{ state: "recording" }, { dumpUnknown: true }]) {
    const { backend, device, commands } = phone(setup);
    const { connection } = streamConnection(controller => { for (const value of h264Packets()) controller.enqueue(value); });
    backend.openVideoStream = async () => connection;
    assert.deepEqual(await backend.startRecording(SERIAL, REMOTE), { method: "stream" });
    assert.equal(commands().some(command => command.includes("aa start")), false, JSON.stringify(setup));
    assert.equal(device.state, setup.state ?? "idle", "the user's own recording keeps running");
    await backend.dispose();
  }
});

test("an accepted start that cannot be confirmed stops instead of silently recording twice", async () => {
  const { backend, device } = phone({ toggleWorks: false });
  backend.openVideoStream = async () => { throw new Error("must not open the stream while the recorder state is unclear"); };
  device.dumpAfterStart = true;
  const execute = backend.execute;
  let started = false;
  backend.execute = async (request) => {
    const result = await execute(request);
    if (request.args.includes("--ps")) started = true;
    if (started && request.args.slice(3).join(" ") === "aa dump -a") return reply("");
    return result;
  };
  await assert.rejects(backend.startRecording(SERIAL, REMOTE), error => error.details?.reason === "system-recording-start-unconfirmed");
});

test("devices without the Huawei recorder keep the existing stream recording unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-system-recorder-"));
  try {
    const { backend, commands } = phone({ huawei: false });
    const { connection, closes } = streamConnection(controller => { for (const value of h264Packets()) controller.enqueue(value); });
    backend.openVideoStream = async () => connection;
    assert.deepEqual(await backend.startRecording(SERIAL, REMOTE), { method: "stream" });
    assert.ok(await backend.stopRecording(SERIAL, REMOTE, join(directory, "stream.mp4")) > 100);
    assert.equal(closes(), 1);
    assert.deepEqual(commands(), [`shell bm dump -n ${BUNDLE}`], "only the detection probe touches the phone");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const [label, feed] of [
  ["ECONNRESET", controller => controller.error(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", syscall: "read" }))],
  ["EPIPE", controller => controller.error(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))],
  ["early EOF", controller => controller.close()],
]) {
  test(`a stream ${label} before the first packet becomes a friendly Chinese message`, async () => {
    const { connection } = streamConnection(feed);
    const failure = await startOwnedRecording(connection).then(() => undefined, error => error);
    assert.equal(failure.code, "CAPABILITY_UNAVAILABLE");
    assert.equal(failure.details.reason, "recording-stream-unavailable");
    assert.doesNotMatch(failure.message, /ECONNRESET|EPIPE/);
    const shown = new HarmonyRequestError({ code: failure.code, message: failure.message, details: failure.details }, 503);
    assert.match(shown.messageFor(true), /手机端视频服务未运行，请在手机上打开 Piora 投屏并点开始共享/);
    assert.match(shown.messageFor(false), /phone video service is not running/);
  });
}

test("the stream path through HdcBackend surfaces the friendly reset message too", async () => {
  const { backend } = phone({ huawei: false });
  const { connection } = streamConnection(controller => controller.error(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })));
  backend.openVideoStream = async () => connection;
  await assert.rejects(backend.startRecording(SERIAL, REMOTE), error => error.details?.reason === "recording-stream-unavailable" && error.details.recordingStopped === true);
});

test("a reset after media already arrived keeps its original cause", async () => {
  let controller;
  const connection = { stream: new ReadableStream({ start(value) { controller = value; } }), async close() {} };
  const pending = startOwnedRecording(connection);
  controller.enqueue(h264Packets()[0]);
  await new Promise(resolve => setTimeout(resolve, 10));
  controller.error(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
  await assert.rejects(pending, error => !error.details?.reason && /ECONNRESET/.test(error.message));
});
