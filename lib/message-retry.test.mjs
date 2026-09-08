import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { prepareMessageRetry } = await createJiti(import.meta.url).import("./message-retry.ts");

test("retry restores full deferred messages and retains both persisted and optimistic image bytes", async () => {
  const full = "原消息\n".repeat(2000);
  const message = { role: "user", deferredContent: true, content: [
    { type: "text", text: "截断预览" },
    { type: "image", data: "AA==", mimeType: "image/png" },
    { type: "image", source: { type: "base64", data: "BB==", media_type: "image/jpeg" } },
  ] };
  const result = await prepareMessageRetry(message, async () => full);
  assert.equal(result.message, full);
  assert.deepEqual(result.images.map(({ data, mimeType }) => ({ data, mimeType })), [{ data: "AA==", mimeType: "image/png" }, { data: "BB==", mimeType: "image/jpeg" }]);
  assert.equal(message.content[0].text, "截断预览");
});

test("failed hydration or unsupported image sources cannot silently resend partial content", async () => {
  await assert.rejects(prepareMessageRetry({ role: "user", deferredContent: true, content: "预览" }, async () => { throw new Error("offline"); }), /offline/);
  await assert.rejects(prepareMessageRetry({ role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.com/pic.png" } }] }, async () => ""), /图片附件/);
  assert.deepEqual(await prepareMessageRetry({ role: "user", content: " original \ntext " }, async () => { throw new Error("unnecessary fetch"); }), { message: " original \ntext " });
});
