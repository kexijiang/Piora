import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { createJiti } from "jiti";

const { prepareModelImageContext, MODEL_IMAGE_MAX_EDGE, MODEL_IMAGE_MAX_BYTES, MODEL_IMAGE_TOTAL_BYTES } = await createJiti(import.meta.url).import("./model-image-context.ts");
const block = data => ({ type: "image", data: data.toString("base64"), mimeType: "image/png" });
const message = image => ({ role: "user", content: [{ type: "text", text: "Inspect" }, image] });
const images = messages => messages.flatMap(message => message.content.filter(block => block.type === "image"));
const small = () => sharp({ create: { width: 8, height: 6, channels: 4, background: "#12345680" } });

test("outgoing images are decoded, MIME-corrected and cached without changing history", async () => {
  const original = [{ ...message({ ...block(await small().webp().toBuffer()), mimeType: "image/jpeg" }), id: "original" }];
  const snapshot = structuredClone(original), cache = new WeakMap();
  const first = await prepareModelImageContext(original, undefined, cache);
  const second = await prepareModelImageContext(original, undefined, cache);
  const image = images(first)[0];
  assert.equal(image.mimeType, "image/png");
  assert.equal((await sharp(Buffer.from(image.data, "base64")).metadata()).format, "png");
  assert.equal(images(second)[0], image, "tool-loop repeats reuse the prepared copy");
  assert.deepEqual(original, snapshot);
  assert.equal(first[0].id, "original");
});

test("more than twenty user attachments retain every image and the original history", async () => {
  const data = await small().png().toBuffer();
  const history = [{ role: "user", content: Array.from({ length: 25 }, (_, index) => ({ ...block(data), id: index })) }];
  const snapshot = structuredClone(history);
  const prepared = images(await prepareModelImageContext(history));
  assert.equal(prepared.length, 25);
  assert.deepEqual(prepared.map(image => image.id), Array.from({ length: 25 }, (_, index) => index));
  assert.deepEqual(history, snapshot);
});

test("more than twenty user and tool screenshots respect dimensions, per-image and aggregate budgets", async () => {
  const bytes = await sharp(randomBytes(2400 * 1800 * 3), { raw: { width: 2400, height: 1800, channels: 3 } }).png().toBuffer();
  const image = block(bytes);
  const history = [message(image), { role: "toolResult", toolCallId: "read", content: Array.from({ length: 20 }, () => image) }];
  const result = await prepareModelImageContext(history);
  const prepared = images(result);
  assert.equal(prepared.length, 21);
  let total = 0;
  for (const item of prepared) {
    const data = Buffer.from(item.data, "base64"); total += data.length;
    const metadata = await sharp(data).metadata();
    assert.ok(metadata.width <= MODEL_IMAGE_MAX_EDGE && metadata.height <= MODEL_IMAGE_MAX_EDGE);
    assert.ok(data.length <= MODEL_IMAGE_MAX_BYTES);
    assert.equal(item.mimeType, `image/${metadata.format}`);
  }
  assert.ok(total <= MODEL_IMAGE_TOTAL_BYTES);
  assert.match(result[0].content.find(part => part.type === "text" && part.text.includes("Image resized")).text, /Map coordinates back/);
  assert.equal(result[1].toolCallId, "read");
  assert.equal(history[0].content[1].data, bytes.toString("base64"));
});

test("TIFF converts to a provider-compatible image and EXIF orientation is applied", async () => {
  const tiff = block(await small().tiff().toBuffer());
  assert.equal(images(await prepareModelImageContext([message(tiff)]))[0].mimeType, "image/png");
  const rotated = block(await small().jpeg().withMetadata({ orientation: 6 }).toBuffer());
  const data = Buffer.from(images(await prepareModelImageContext([message(rotated)]))[0].data, "base64");
  const metadata = await sharp(data).metadata();
  assert.equal(metadata.width, 6); assert.equal(metadata.height, 8); assert.equal(metadata.orientation, undefined);
});

test("invalid image bytes fail clearly and cancellation never turns into an image error", async () => {
  await assert.rejects(prepareModelImageContext([message(block(Buffer.from("not an image")))]), /第 1 张图片发送失败.*无法解码/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(prepareModelImageContext([message(block(await small().png().toBuffer()))], controller.signal), { name: "AbortError" });
});
