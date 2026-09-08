import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { streamHdcLines } = await jiti.import("./log-stream.ts");
const { createLogMatcher } = await jiti.import("./log-filter.ts");
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
