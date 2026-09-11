import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { completeVisionRequest, VISION_REQUEST_TIMEOUT_MS } = await jiti.import("./vision-request.ts");
const { analyzeImagesWithVisionModel } = await jiti.import("./vision-agent.ts");
const success = { stopReason: "stop", content: [{ type: "text", text: "A visible screenshot" }] };

test("visual analysis survives the former 45-second limit and passes the longer budget to the active registry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal, finish;
  const result = analyzeImagesWithVisionModel({
    config: { enabled: true, provider: "test", modelId: "vision" },
    images: [{ type: "image", mimeType: "image/png", data: "YWJj" }], question: "Describe",
    modelRegistry: {
      getError: () => undefined, find: () => ({ input: ["image"] }), hasConfiguredAuth: () => true,
      complete: (_model, _context, options) => {
        signal = options.signal;
        assert.equal(options.timeoutMs, VISION_REQUEST_TIMEOUT_MS);
        return new Promise(resolve => { finish = resolve; });
      },
    },
  });
  t.mock.timers.tick(45_001);
  assert.equal(signal.aborted, false);
  finish(success);
  assert.equal(await result, "A visible screenshot");
  t.mock.timers.tick(VISION_REQUEST_TIMEOUT_MS);
  assert.equal(signal.aborted, false, "success cleans up its deadline");
});

test("deadline retains its cause when the SDK returns an aborted message or ignores cancellation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const returnsAbort of [true, false]) {
    let signal;
    const pending = completeVisionRequest(current => {
      signal = current;
      return new Promise(resolve => {
        if (returnsAbort) current.addEventListener("abort", () => resolve({ stopReason: "aborted", errorMessage: "Request was aborted" }));
      });
    });
    const checked = assert.rejects(pending, /视觉识别超时（3 分钟）/u);
    t.mock.timers.tick(VISION_REQUEST_TIMEOUT_MS);
    await checked;
    assert.equal(signal.aborted, true);
  }
});

test("already cancelled work never calls the model; in-flight cancellation releases it", async () => {
  const before = new AbortController(); before.abort();
  await assert.rejects(completeVisionRequest(() => { assert.fail("must not send"); }, before.signal), /已取消/u);
  const during = new AbortController(); let child;
  const pending = completeVisionRequest(signal => { child = signal; return new Promise(() => {}); }, during.signal);
  const checked = assert.rejects(pending, /已取消/u);
  during.abort(); await checked;
  assert.equal(child.aborted, true);
});

test("upstream aborts have a readable diagnosis and other provider errors remain intact", async () => {
  await assert.rejects(completeVisionRequest(async () => ({ stopReason: "aborted", errorMessage: "Request was aborted" })), /渠道连接/u);
  await assert.rejects(completeVisionRequest(async () => { throw new DOMException("operation aborted", "AbortError"); }), /渠道连接/u);
  await assert.rejects(completeVisionRequest(async () => ({ stopReason: "error", errorMessage: "401 invalid API key" })), /401 invalid API key/u);
});
