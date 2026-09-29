import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import iconv from "iconv-lite";

const { decodeDeviceText, encodeDeviceText, MAX_DEVICE_TEXT_BYTES } = await createJiti(import.meta.url).import("./harmony/device-text.ts");

test("UTF-8 BOM and CRLF survive a textarea-style LF edit", () => {
  const original = Buffer.from("\ufeff第一行\r\n第二行\r\n", "utf8");
  const decoded = decodeDeviceText(original);
  assert.equal(decoded.encoding, "utf-8-bom");
  assert.equal(decoded.newline, "crlf");
  const saved = encodeDeviceText("第一行\n新第二行\n", decoded.encoding, decoded.newline);
  assert.deepEqual(saved, Buffer.from("\ufeff第一行\r\n新第二行\r\n", "utf8"));
});

test("mixed endings require explicit normalization and missing metadata defaults safely", () => {
  const decoded = decodeDeviceText(Buffer.from("a\r\nb\nc\r"));
  assert.equal(decoded.newline, "mixed");
  assert.throws(() => encodeDeviceText("a\nb", "utf-8", decoded.newline), /explicit newline/);
  assert.equal(encodeDeviceText("a\nb", "utf-8", decoded.newline, "cr").toString(), "a\rb");
});

test("2 MiB is accepted but larger edits and binary previews are rejected", () => {
  const exact = Buffer.alloc(MAX_DEVICE_TEXT_BYTES, 0x61);
  assert.equal(decodeDeviceText(exact).text.length, MAX_DEVICE_TEXT_BYTES);
  assert.equal(encodeDeviceText("a".repeat(MAX_DEVICE_TEXT_BYTES), "utf-8", "none").length, MAX_DEVICE_TEXT_BYTES);
  assert.throws(() => encodeDeviceText("a".repeat(MAX_DEVICE_TEXT_BYTES + 1), "utf-8", "none"), /2 MiB/);
  assert.throws(() => decodeDeviceText(Buffer.from([0x61, 0x00, 0x62])), /NUL/);
  assert.throws(() => decodeDeviceText(Buffer.from([0xff])), /UTF-8/);
});

test("UTF-16 BOM variants retain their byte order through an edit", () => {
  for (const [encoding, bom] of [["utf-16le", Buffer.from([0xff, 0xfe])], ["utf-16be", Buffer.from([0xfe, 0xff])]]) {
    const original = Buffer.concat([bom, iconv.encode("你好\r\n世界", encoding)]);
    const decoded = decodeDeviceText(original);
    assert.equal(decoded.encoding, `${encoding}-bom`);
    assert.equal(decoded.text, "你好\r\n世界");
    assert.deepEqual(encodeDeviceText("你好\n新世界", decoded.encoding, decoded.newline), Buffer.concat([bom, iconv.encode("你好\r\n新世界", encoding)]));
  }
});

test("GB18030 requires explicit selection and refuses lossy characters", () => {
  const original = iconv.encode("设备中文\n", "gb18030");
  assert.throws(() => decodeDeviceText(original), /UTF-8/);
  const decoded = decodeDeviceText(original, "gb18030");
  assert.equal(decoded.text, "设备中文\n");
  assert.deepEqual(encodeDeviceText("设备新中文\n", decoded.encoding, decoded.newline), iconv.encode("设备新中文\n", "gb18030"));
  assert.throws(() => encodeDeviceText("\ud800", "gb18030", "none"), /without loss/);
  assert.throws(() => decodeDeviceText(Buffer.from([0xff]), "gb18030"), /without loss/);
});

test("explicit encoding rejects invalid bytes and invalid codec input", () => {
  assert.throws(() => decodeDeviceText(Buffer.from([0xff]), "utf-8"), /UTF-8/);
  assert.throws(() => decodeDeviceText(Buffer.from([0xff]), "utf-16le"), /incomplete code unit/);
  assert.throws(() => decodeDeviceText(Buffer.from("x"), "latin1"), /Unsupported/);
  assert.throws(() => encodeDeviceText("x", "latin1", "none"), /Unsupported/);
});
