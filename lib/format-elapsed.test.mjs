import assert from "node:assert/strict";
import test from "node:test";
import { formatElapsed } from "./format-elapsed.ts";

test("formatElapsed renders seconds, minutes, and hours", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(999), "0s");
  assert.equal(formatElapsed(1_000), "1s");
  assert.equal(formatElapsed(12_000), "12s");
  assert.equal(formatElapsed(59_999), "59s");
  assert.equal(formatElapsed(60_000), "1m 00s");
  assert.equal(formatElapsed(65_000), "1m 05s");
  assert.equal(formatElapsed(83_000), "1m 23s");
  assert.equal(formatElapsed(3_599_999), "59m 59s");
  assert.equal(formatElapsed(3_600_000), "1h 00m 00s");
  assert.equal(formatElapsed(3_723_000), "1h 02m 03s");
  assert.equal(formatElapsed(36_000_000 + 125_000), "10h 02m 05s");
});

test("formatElapsed clamps negative and non-finite values", () => {
  assert.equal(formatElapsed(-5), "0s");
  assert.equal(formatElapsed(Number.NaN), "0s");
  assert.equal(formatElapsed(Number.POSITIVE_INFINITY), "0s");
  assert.equal(formatElapsed(Number.NEGATIVE_INFINITY), "0s");
});
