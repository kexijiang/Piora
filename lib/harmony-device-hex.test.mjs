import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { deviceHexPreview } = await createJiti(import.meta.url).import("./harmony/device-hex.ts");

test("bounded binary preview displays offsets, hex and printable ASCII without raw control characters", () => {
  const bytes = Buffer.alloc(600);
  bytes.set([0, 65, 10, 127, 255], 0);
  const result = deviceHexPreview(bytes);
  assert.equal(result.size, 600);
  assert.equal(result.shown, 512);
  assert.equal(result.truncated, true);
  assert.match(result.text, /^00000000  00 41 0a 7f ff /);
  assert.match(result.text, /\|\.A\.\.\./);
  assert.match(result.text, /000001f0/);
  assert.doesNotMatch(result.text, /\x00|\x7f/);
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  assert.equal(deviceHexPreview(Buffer.alloc(0)).text, "");
});
