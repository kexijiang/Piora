import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { videoStartupDiagnostics } = await createJiti(import.meta.url).import("./harmony/runtime/video-startup-diagnostics.ts");

test("empty stdout still exposes the actual attempt's hilog loader symbol", () => {
  const name = "piora_video_123.so";
  const symbol = "_ZN6google8protobuf8internal14UntypedMapBase14ClearTableImplEb";
  const result = videoStartupDiagnostics(name, "", [
    "OtherApp: secret unrelated error",
    "Error relocating /data/local/tmp/piora_video_456.so: unrelated_symbol: symbol not found",
    `Error relocating /data/local/tmp/${name}: ${symbol}: symbol not found`,
  ].join("\n"));
  assert.equal(result.missingSymbol, symbol);
  assert.match(result.diagnostic, /Error relocating/);
  assert.doesNotMatch(result.diagnostic, /secret|unrelated/);
});

test("startup evidence is bounded and strips control characters", () => {
  const result = videoStartupDiagnostics("piora_video_123.so", Array.from({ length: 20 }, () => `dlopen failed \u001b${"x".repeat(700)}`).join("\n"), "ordinary unrelated log");
  assert.ok(result.diagnostic.length <= 2048);
  assert.doesNotMatch(result.diagnostic, /\u001b|ordinary/);
  assert.equal(result.missingSymbol, undefined);
  assert.deepEqual(videoStartupDiagnostics("piora_video_123.so", "", "unrelated error"), {});
});
