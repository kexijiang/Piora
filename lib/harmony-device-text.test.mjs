import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

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
