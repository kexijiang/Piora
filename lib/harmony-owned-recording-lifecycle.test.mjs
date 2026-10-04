import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { deferred } from "./harmony/fixtures/controlled-backend.mjs";

const jiti = createJiti(import.meta.url);
const { startOwnedRecording } = await jiti.import("./harmony/media/owned-recording.ts");
const { HarmonyError } = await jiti.import("./harmony/errors.ts");
const encoded = JSON.parse(await readFile(new URL("../tests/harmony-media/h264-64x64.json", import.meta.url), "utf8"));
function packet(type, payload) {
  const header = Buffer.alloc(8); header.writeUInt32BE(type); header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}
function packets(width = 64) {
  const avcc = Buffer.from(encoded.config), sl = avcc.readUInt16BE(6), pl = avcc.readUInt16BE(9 + sl);
  const config = Buffer.alloc(17 + sl + pl);
  config.writeUInt32BE(width, 1); config.writeUInt32BE(64, 5); config.writeUInt32BE(30, 9);
  config.writeUInt16BE(sl, 13); avcc.subarray(8, 8 + sl).copy(config, 15);
  config.writeUInt16BE(pl, 15 + sl); avcc.subarray(11 + sl, 11 + sl + pl).copy(config, 17 + sl);
  const chunk = encoded.chunks[0], raw = Buffer.from(chunk.data), units = [];
  for (let offset = 0; offset < raw.length;) {
    const size = raw.readUInt32BE(offset); units.push(Buffer.from([0, 0, 0, 1]), raw.subarray(offset + 4, offset + 4 + size)); offset += 4 + size;
  }
  const header = Buffer.alloc(9); header[0] = 1; header.writeBigUInt64BE(BigInt(chunk.timestamp), 1);
  return [packet(2, config), packet(3, Buffer.concat([header, ...units]))];
}

test("background failure is reported only after the owned reader and forward close settle", async () => {
  const closing = deferred(), closeStarted = deferred(), reported = deferred();
  let controller, closes = 0, failures = 0;
  const connection = { stream: new ReadableStream({ start(value) { controller = value; } }), async close() {
    closes++; closeStarted.resolve(); await closing.promise;
  } };
  const pending = startOwnedRecording(connection, undefined, error => { failures++; reported.resolve(error); });
  for (const value of packets()) controller.enqueue(value);
  const recording = await pending;
  controller.enqueue(packets(32)[0]);
  await closeStarted.promise;
  assert.equal(failures, 0, "the close acknowledgment is still pending");
  closing.resolve(); const error = await reported.promise;
  assert.equal(error.code, "STALE_SNAPSHOT"); assert.equal(error.details.recordingStopped, true);
  await assert.rejects(recording.stop(join(tmpdir(), "never-saved.mp4")), failure => failure.code === "STALE_SNAPSHOT");
  assert.equal(closes, 1); assert.equal(failures, 1);
});

test("a rejected forward close cannot race a pending reader cancellation or lose its uncertainty", async () => {
  const cancelled = deferred(), cancelStarted = deferred(), reported = deferred();
  let controller, failures = 0;
  const connection = { stream: new ReadableStream({ start(value) { controller = value; }, cancel() {
    cancelStarted.resolve(); return cancelled.promise;
  } }), async close() { throw new Error("Forward removal failed"); } };
  const pending = startOwnedRecording(connection, undefined, error => { failures++; reported.resolve(error); });
  for (const value of packets()) controller.enqueue(value);
  const recording = await pending;
  controller.enqueue(packets(32)[0]); await cancelStarted.promise;
  await new Promise(resolve => setImmediate(resolve)); assert.equal(failures, 0);
  cancelled.resolve(); const error = await reported.promise;
  assert.equal(error.code, "STALE_SNAPSHOT"); assert.equal(error.details.cleanup, "uncertain");
  assert.equal(error.details.recordingStopped, true);
  await assert.rejects(recording.stop(join(tmpdir(), "never-saved.mp4")), failure => failure.details.cleanup === "uncertain");
});

test("an explicit successful stop finalizes encoded media without a background failure callback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-owned-lifecycle-"));
  let controller, closes = 0, failures = 0;
  const connection = { stream: new ReadableStream({ start(value) { controller = value; } }), async close() { closes++; } };
  let recording;
  try {
    const pending = startOwnedRecording(connection, undefined, () => { failures++; });
    for (const value of packets()) controller.enqueue(value);
    recording = await pending;
    assert.ok(await recording.stop(join(directory, "result.mp4")) > 100);
    assert.equal(closes, 1); assert.equal(failures, 0);
  } finally { await recording?.discard(); await rm(directory, { recursive: true, force: true }); }
});

test("startup rejection never reports a recording as having run", async () => {
  let controller, closes = 0, failures = 0;
  const pending = startOwnedRecording({ stream: new ReadableStream({ start(value) { controller = value; } }),
    async close() { closes++; } }, undefined, () => { failures++; });
  controller.error(new HarmonyError("DEVICE_OFFLINE", "Disconnected before first keyframe"));
  await assert.rejects(pending, error => error.code === "DEVICE_OFFLINE");
  assert.equal(failures, 0); assert.equal(closes, 1);
});
