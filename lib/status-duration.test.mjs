import assert from "node:assert/strict";
import test from "node:test";
import { formatStatusDuration } from "./status-duration.ts";

test("formatStatusDuration renders compact clocks", () => {
  assert.equal(formatStatusDuration(0), "0s");
  assert.equal(formatStatusDuration(45_000), "45s");
  assert.equal(formatStatusDuration(83_000), "1:23");
  assert.equal(formatStatusDuration(3_723_000), "1:02:03");
  assert.equal(formatStatusDuration(-5), "0s");
});
