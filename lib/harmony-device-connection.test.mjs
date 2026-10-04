import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { normalizeHarmonyResponseSample, currentHarmonyResponseSample, isHdcChannelNotReadyResponse } = await createJiti(import.meta.url).import("./harmony/device-connection.ts");

test("channel readiness recognizes actual HDC protocol failures rather than ordinary shell text", () => {
  for (const output of ["[Fail][E000004]:The communication channel is being established.\r\r\nPlease wait for several seconds and try again.",
    "[F][2026-09-30 18:55:32] Send isDead channelId:707896543\r\n", "[F][2026-09-30 19:29:28] Send hChannel nullptr channelId:45868981\n"]) {
    assert.equal(isHdcChannelNotReadyResponse(output), true);
  }
  for (const output of ["The communication channel is being established.", "26\n", "[Fail] Permission denied", "param not found", "USB Connected unknown... hdc",
    "user-log: [F][today] Send isDead channelId:1", "{\"message\":\"The communication channel is being established.\"}"]) {
    assert.equal(isHdcChannelNotReadyResponse(output), false);
  }
});

test("only measured, bounded and recent parameter responses may appear as device latency", () => {
  const now = Date.parse("2026-09-30T01:00:00.000Z");
  const value = { durationMs: 17.4, sampledAt: new Date(now).toISOString() };
  assert.deepEqual(normalizeHarmonyResponseSample(value), { ...value, durationMs: 17 });
  assert.equal(currentHarmonyResponseSample(value, now + 45_000).durationMs, 17);
  assert.equal(currentHarmonyResponseSample(value, now + 45_001), undefined);
  assert.equal(currentHarmonyResponseSample(value, now - 1), undefined);
  for (const durationMs of [-1, NaN, Infinity, "17", 60_001]) assert.equal(normalizeHarmonyResponseSample({ ...value, durationMs }), undefined);
  for (const sampledAt of ["unknown", 10, undefined]) assert.equal(normalizeHarmonyResponseSample({ ...value, sampledAt }), undefined);
});
