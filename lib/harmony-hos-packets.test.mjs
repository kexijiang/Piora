import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { HosVideoPacketizer } = await createJiti(import.meta.url).import("./harmony/media/hos-packets.ts");
const annex = (...units) => Buffer.concat(units.flatMap(unit => [Buffer.from([0, 0, 0, 1]), Buffer.from(unit)]));

test("HOS callback data yields one geometry config and bounded key/delta packets", () => {
  const converter = new HosVideoPacketizer();
  converter.setSize(1080, 2400);
  const first = converter.push(annex([0x67, 0x42, 0xe0, 0x1f], [0x68, 0xce, 0x06], [0x65, 1, 2]));
  assert.deepEqual(first.map(bytes => bytes.readUInt32BE(0)), [2, 3]);
  assert.equal(first[0].readUInt32BE(9), 1080);
  assert.equal(first[0].readUInt32BE(13), 2400);
  assert.equal(first[1].readUInt8(8), 1);
  const delta = converter.push(annex([0x41, 3, 4]));
  assert.equal(delta.length, 1);
  assert.equal(delta[0].readUInt8(8), 0);
  converter.setSize(2400, 1080);
  assert.deepEqual(converter.push(annex([0x65, 9])).map(bytes => bytes.readUInt32BE(0)), [2, 3]);
  assert.deepEqual(converter.push(Buffer.alloc(8 * 1024 * 1024 + 1)), []);
});

test("wall-clock changes cannot stretch or compress the recorded timeline", t => {
  let tick = BigInt(1_000_000_000), wall = 1000;
  t.mock.method(process.hrtime, "bigint", () => tick);
  t.mock.method(Date, "now", () => wall);
  const converter = new HosVideoPacketizer(); converter.setSize(640, 480);
  const first = converter.push(annex([0x67, 0x42, 0xe0, 0x1f], [0x68, 0xce, 6], [0x65, 1])).at(-1).readBigUInt64BE(9);
  tick += BigInt(33_000_000); wall += 3_600_000;
  const second = converter.push(annex([0x41, 2]))[0].readBigUInt64BE(9);
  tick += BigInt(34_000_000); wall = 0;
  const third = converter.push(annex([0x41, 3]))[0].readBigUInt64BE(9);
  assert.equal(second - first, BigInt(33_000)); assert.equal(third - second, BigInt(34_000));
});
