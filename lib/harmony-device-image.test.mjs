import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { deviceImageMime } = await createJiti(import.meta.url).import("./harmony/device-image.ts");

test("device image preview accepts matching image signatures and rejects disguised content", () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const jpeg = Buffer.from([255, 216, 255, 1]);
  const gif = Buffer.from("GIF89a0000");
  const webp = Buffer.from("RIFF0000WEBP0000");
  assert.equal(deviceImageMime("photo.png", png), "image/png");
  assert.equal(deviceImageMime("photo.JPEG", jpeg), "image/jpeg");
  assert.equal(deviceImageMime("motion.gif", gif), "image/gif");
  assert.equal(deviceImageMime("photo.webp", webp), "image/webp");
  assert.throws(() => deviceImageMime("photo.png", jpeg), { code: "INVALID_RESPONSE" });
  assert.throws(() => deviceImageMime("photo.svg", Buffer.from("<svg/>")), { code: "INVALID_RESPONSE" });
});
