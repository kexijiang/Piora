import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { deviceMediaMime, mediaByteRange } = await createJiti(import.meta.url).import("./harmony/device-media.ts");

test("device media preview accepts supported signatures only for their matching extensions", () => {
  const wav = Buffer.from("RIFF0000WAVEfmt ");
  const ogg = Buffer.from("OggS0000");
  const mp3 = Buffer.from("ID3\0\0\0\0");
  const mp4 = Buffer.from("\0\0\0\x18ftypmp42");
  const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42]);
  assert.equal(deviceMediaMime("recording.wav", wav), "audio/wav");
  assert.equal(deviceMediaMime("recording.ogg", ogg), "audio/ogg");
  assert.equal(deviceMediaMime("recording.mp3", mp3), "audio/mpeg");
  assert.equal(deviceMediaMime("recording.m4a", mp4), "audio/mp4");
  assert.equal(deviceMediaMime("clip.mp4", mp4), "video/mp4");
  assert.equal(deviceMediaMime("clip.webm", webm), "video/webm");
  assert.throws(() => deviceMediaMime("clip.mp4", Buffer.from("<script/>")), { code: "INVALID_RESPONSE" });
  assert.throws(() => deviceMediaMime("clip.html", mp4), { code: "INVALID_RESPONSE" });
});

test("media byte ranges cover browser seeking without serving invalid positions", () => {
  assert.equal(mediaByteRange(null, 100), null);
  assert.deepEqual(mediaByteRange("bytes=0-", 100), { start: 0, end: 99 });
  assert.deepEqual(mediaByteRange("bytes=5-500", 100), { start: 5, end: 99 });
  assert.deepEqual(mediaByteRange("bytes=-10", 100), { start: 90, end: 99 });
  for (const range of ["bytes=100-", "bytes=9-8", "bytes=0-1,5-8", "bytes=-0", "bytes=-999999999999999999999"]) {
    assert.throws(() => mediaByteRange(range, 100), { code: "INVALID_ARGUMENT" });
  }
});
