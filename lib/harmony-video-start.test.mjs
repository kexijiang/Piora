import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { prepareVideoStream } = await createJiti(import.meta.url).import("./harmony/media/stream-start.ts");

test("video warmup preserves first and subsequent binary chunks without buffering the movie", async () => {
  let closed = 0; const signal = new AbortController().signal;
  const connection = { stream: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([2, 3])); controller.enqueue(new Uint8Array([4, 5])); controller.close(); } }), close: async () => { closed++; } };
  const stream = await prepareVideoStream(connection, signal);
  assert.deepEqual([...new Uint8Array(await new Response(stream).arrayBuffer())], [2, 3, 4, 5]);
  assert.equal(closed, 1);
});

test("early video EOF and silent startup fail before committing binary response headers", async () => {
  for (const silent of [false, true]) {
    let closed = 0;
    const connection = { stream: new ReadableStream({ start(controller) { if (!silent) controller.close(); } }), close: async () => { closed++; } };
    await assert.rejects(prepareVideoStream(connection, new AbortController().signal, 20), error => error.code === "CAPABILITY_UNAVAILABLE" && error.details.reason === (silent ? "mirror-awaiting-video" : "mirror-stream-closed"));
    assert.equal(closed, 1);
  }
});

test("cancelling video warmup closes the device watcher immediately", async () => {
  const controller = new AbortController(); let closed = 0;
  const pending = prepareVideoStream({ stream: new ReadableStream(), close: async () => { closed++; } }, controller.signal);
  controller.abort(); await assert.rejects(pending, error => error.code === "COMMAND_ABORTED");
  assert.equal(closed, 1);
});
