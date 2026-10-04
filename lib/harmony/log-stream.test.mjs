import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { streamHdcLines } = await jiti.import("./log-stream.ts");
const { createLogMatcher, createLogTimeRange } = await jiti.import("./log-filter.ts");
test("continuous log reads preserve split UTF-8 and stop without waiting for process exit", async () => {
  const controller = new AbortController();
  const rows = [];
  const code = 'const b=Buffer.from("中文日志\\n"); process.stdout.write(b.subarray(0,2)); setTimeout(()=>process.stdout.write(b.subarray(2)),30); setInterval(()=>{},1000);';
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    await streamHdcLines(process.execPath, ["-e", code], (lines) => { rows.push(...lines); controller.abort(); }, controller.signal);
    assert.deepEqual(rows, ["中文日志"]);
  } finally { clearTimeout(timeout); controller.abort(); }
});
test("regex handles alternatives and anchors, plain search treats metacharacters literally", () => {
  const regex = createLogMatcher("^(error|warning):.*socket$", true);
  assert.equal(regex.matches("ERROR: closed socket"), true);
  assert.equal(regex.matches("info: closed socket"), false);
  assert.equal(createLogMatcher("[", true).matches("anything"), false);
  assert.ok(createLogMatcher("[", true).error);
  assert.equal(createLogMatcher("[", false).matches("[tag] message"), true);
});

test("log time filters keep device timestamps and handle fractional seconds and midnight", () => {
  const range = createLogTimeRange("09-30 10:00:00", "09-30 10:01:00");
  assert.equal(range.matches("09-30 10:00:00.001"), true);
  assert.equal(range.matches("09-30 10:01:00.999"), true);
  assert.equal(range.matches("09-30 10:01:01"), false);
  assert.equal(range.matches("10-01 10:00:00"), false);
  assert.equal(range.matches(undefined), false);
  const midnight = createLogTimeRange("23:59", "00:01");
  assert.equal(midnight.matches("09-30 23:59:59.123"), true);
  assert.equal(midnight.matches("10-01 00:01:59"), true);
  assert.equal(midnight.matches("10-01 00:02:00"), false);
  assert.equal(createLogTimeRange("12-31 23:00", "01-01 01:00").matches("01-01 00:30:00"), true);
  assert.equal(createLogTimeRange("", "").matches(undefined), true);
  for (const [start, end] of [["24:00", ""], ["04-31 10:00", ""], ["00:99", ""], ["09-30 10:00", "11:00"]]) {
    assert.equal(createLogTimeRange(start, end).error, "format");
    assert.equal(createLogTimeRange(start, end).matches("09-30 10:00:00"), false);
  }
});
