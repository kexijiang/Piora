import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getMessageImageSource, messageImageUrl, getVisionRetryPayload } = await jiti.import("./message-images.ts");
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { buildSessionContext } = await jiti.import("./session-reader.ts");
const { persistLazySessionManager } = await jiti.import("./session-persistence.ts");

const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=";
const flat = { type: "image", data, mimeType: "image/png" };
const nested = { type: "image", source: { type: "base64", data, media_type: "image/png" } };

test("optimistic, persisted, and SSE user images produce the same preview and retry bytes", () => {
  for (const block of [flat, nested, { ...flat, source: null }]) {
    assert.equal(messageImageUrl(block), `data:image/png;base64,${data}`);
    assert.deepEqual(getVisionRetryPayload([{ role: "user", content: [{ type: "text", text: " Inspect this " }, block] }]), {
      message: "Inspect this", images: [{ data, mimeType: "image/png", previewUrl: `data:image/png;base64,${data}` }],
    });
  }
});

test("image-only prompts, mixed images, and repeated history loads preserve attachments", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "piora-image-history-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manager = SessionManager.create(directory, join(directory, "sessions"));
  const entryId = manager.appendMessage({ role: "user", content: [flat, { ...flat, mimeType: "image/jpeg" }], timestamp: Date.now() });
  const file = persistLazySessionManager(manager);
  const originalFile = readFileSync(file, "utf8");
  assert.equal(JSON.parse(originalFile.trim().split("\n").at(-1)).message.content[0].source, undefined,
    "exercise the actual SDK format that crashed the main conversation");

  for (let reload = 0; reload < 3; reload += 1) {
    const restored = SessionManager.open(file);
    for (const options of [{}, { deferThinking: true, deferToolResultImages: true }]) {
      // JSON round-trip models the session endpoint and browser response parsing.
      const context = JSON.parse(JSON.stringify(buildSessionContext(restored.getEntries(), restored.getLeafId(), options)));
      assert.deepEqual(context.entryIds, [entryId]);
      const retry = getVisionRetryPayload(context.messages);
      assert.equal(retry.message, "");
      assert.deepEqual(retry.images.map(({ data, mimeType }) => ({ data, mimeType })), [
        { data, mimeType: "image/png" }, { data, mimeType: "image/jpeg" },
      ]);
      assert.ok(context.messages[0].content.every((block) => messageImageUrl(block).startsWith("data:image/")));
    }
  }
  assert.equal(readFileSync(file, "utf8"), originalFile, "recovery never removes or rewrites image history");
});

test("URL images remain viewable and malformed blocks cannot crash retry extraction", () => {
  const url = { type: "image", source: { type: "url", url: "https://example.test/photo.png" } };
  assert.equal(messageImageUrl(url), url.source.url);
  assert.equal(getMessageImageSource({ type: "image" }), null);
  assert.equal(messageImageUrl({ type: "image", source: "invalid", data: 42 }), "");
  assert.deepEqual(getVisionRetryPayload([{ role: "user", content: [null, url, { type: "image", source: {} }, { type: "text", text: "hello" }] }]), { message: "hello" });
  assert.equal(getVisionRetryPayload([{ role: "user", content: [null, { type: "image" }] }]), null);
});

test("retries select the latest user prompt and never substitute assistant or tool images", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "old" }, flat] },
    { role: "user", content: [{ type: "text", text: "latest" }, nested] },
    { role: "assistant", content: [{ ...flat, data: "YWJj" }] },
    { role: "toolResult", content: [{ ...flat, data: "YWJj" }] },
  ];
  assert.equal(getVisionRetryPayload(messages).message, "latest");
  assert.equal(getVisionRetryPayload(messages).images[0].data, data);
});
