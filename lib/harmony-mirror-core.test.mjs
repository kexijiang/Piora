import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { VideoPacketReader, parseVideoConfiguration } = await jiti.import("./harmony/mirror/protocol.ts");
const { MirrorSubscriber } = await jiti.import("./harmony/mirror/subscriber.ts");
const { mirrorPoint } = await jiti.import("./harmony/mirror/coordinates.ts");
const { captureArguments } = await jiti.import("./harmony/mirror/profile.ts");
const packet = (type, payload) => { const p = Buffer.alloc(8 + payload.length); p.writeUInt32BE(type); p.writeUInt32BE(payload.length, 4); p.set(payload, 8); return p; };
const frame = (id, key = false) => packet(3, Buffer.from([key ? 1 : 0, 0, 0, 0, 0, 0, 0, 0, id, 0x65, id]));
const config = packet(2, Buffer.from([0, 0, 0, 2, 128, 0, 0, 1, 224, 0, 0, 0, 120, 0, 4, 0x67, 66, 0, 30, 0, 2, 0x68, 1]));

test("video parsing preserves every byte across all network splits and coalesced packets", () => {
  const wire = Buffer.concat([config, frame(1, true), frame(2)]);
  for (let chunk = 1; chunk <= wire.length; chunk++) {
    const parser = new VideoPacketReader(), result = [];
    for (let at = 0; at < wire.length; at += chunk) result.push(...parser.push(wire.subarray(at, at + chunk)));
    parser.finish(); assert.deepEqual(result.map(item => item.type), [2, 3, 3]);
    assert.deepEqual(Buffer.from(result[2].payload), frame(2).subarray(8));
    assert.equal(parseVideoConfiguration(result[0].payload).fps, 120);
  }
});

test("truncated and oversized packets and invalid SPS/PPS are rejected before decode", () => {
  const parser = new VideoPacketReader(); [...parser.push(config.subarray(0, 12))]; assert.throws(() => parser.finish(), /inside/);
  const header = Buffer.alloc(8); header.writeUInt32BE(0xffffffff, 4);
  assert.throws(() => [...new VideoPacketReader().push(header)], /limit/);
  for (let length = 0; length < config.length - 8; length++) assert.throws(() => parseVideoConfiguration(config.subarray(8, 8 + length)));
});

test("an aged viewer discards old references and waits for an IDR without closing", async () => {
  let now = 0, requests = 0, closes = 0;
  const viewer = new MirrorSubscriber({ recording: false, now: () => now, requestKeyframe() { requests++; }, onClose() { closes++; } });
  const reader = viewer.stream.getReader(); viewer.push(config); viewer.push(frame(1, true));
  await reader.read(); await reader.read(); viewer.push(frame(2)); now = 100;
  assert.equal(Buffer.from((await reader.read()).value).readUInt32BE(0), 2);
  viewer.push(frame(3));
  let finished = false; const next = reader.read().then(value => { finished = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false);
  viewer.push(frame(4, true)); assert.equal(Buffer.from((await next).value).at(-1), 4);
  assert.equal(requests, 1); assert.equal(closes, 0); viewer.close(); assert.equal(closes, 1);
});

test("recording keeps an aged GOP and explicit close releases every subscriber exactly once", async () => {
  let now = 0, closes = 0;
  const viewer = new MirrorSubscriber({ recording: true, now: () => now, requestKeyframe() { assert.fail("recording cannot discard a GOP"); }, onClose() { closes++; } });
  const reader = viewer.stream.getReader(); viewer.push(config); viewer.push(frame(1, true));
  for (let id = 2; id <= 20; id++) viewer.push(frame(id)); now = 10000;
  assert.equal(Buffer.from((await reader.read()).value).readUInt32BE(0), 0x21); await reader.read();
  for (let id = 1; id <= 20; id++) assert.equal(Buffer.from((await reader.read()).value).at(-1), id);
  viewer.close(); viewer.close(); assert.equal(closes, 1);
});

test("contain coordinates reject letterboxing and preserve portrait/landscape pixel mapping", () => {
  const bounds = { left: 10, top: 20, width: 400, height: 400 };
  assert.equal(mirrorPoint(20, 220, bounds, { width: 100, height: 200 }), undefined);
  assert.deepEqual(mirrorPoint(210, 220, bounds, { width: 100, height: 200 }), { x: 50, y: 100 });
  assert.equal(mirrorPoint(210, 30, bounds, { width: 200, height: 100 }), undefined);
  assert.deepEqual(mirrorPoint(210, 220, bounds, { width: 200, height: 100 }), { x: 100, y: 50 });
  assert.match(captureArguments(), /-frameRate 120 /);
});
