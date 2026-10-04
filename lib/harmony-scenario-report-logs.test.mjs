import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { collectScenarioLogs } = await jiti.import("./harmony/scenario/report-logs.ts");
const { HarmonyError } = await jiti.import("./harmony/errors.ts");

test("report logs retain the latest rows within both UTF-8 byte and line limits", async () => {
  const rows = Array.from({ length: 250 }, (_, index) => ({ level: "info", pid: index, message: "日志".repeat(3000), raw: `${index} ${"日志".repeat(3000)}`, tag: "fixture" }));
  const report = await collectScenarioLogs({ kind: "fixture", async readLogs(serial, options) { assert.equal(serial, "phone"); assert.equal(options.limit, 200); return rows; } }, "phone", new AbortController().signal);
  assert.equal(report.status, "collected"); assert.equal(report.source, "device-tail"); assert.equal(report.truncated, true);
  assert.ok(report.entries.length > 0 && report.entries.length <= 200); assert.equal(report.entries.at(-1).pid, 249);
  assert.ok(Buffer.byteLength(JSON.stringify(report.entries), "utf8") <= 128 * 1024 + 2);
  assert.ok(report.entries.every(entry => entry.message.length <= 2048 && entry.raw.length <= 2048));
});

test("unavailable and empty logs are different report states", async () => {
  const signal = new AbortController().signal;
  const unavailable = await collectScenarioLogs({ kind: "fixture" }, "phone", signal);
  assert.equal(unavailable.status, "failed"); assert.equal(unavailable.error.code, "CAPABILITY_UNAVAILABLE");
  const empty = await collectScenarioLogs({ kind: "fixture", async readLogs() { return []; } }, "phone", signal);
  assert.equal(empty.status, "collected"); assert.equal(empty.truncated, false); assert.deepEqual(empty.entries, []);
  const failed = await collectScenarioLogs({ kind: "fixture", async readLogs() { throw new HarmonyError("DEVICE_NOT_FOUND", "Disconnected"); } }, "phone", signal);
  assert.equal(failed.status, "failed"); assert.equal(failed.error.code, "DEVICE_NOT_FOUND");
});

test("cancelled report collection cannot settle as a successful report", async () => {
  const controller = new AbortController(); let reads = 0;
  controller.abort();
  await assert.rejects(() => collectScenarioLogs({ kind: "fixture", async readLogs() { reads++; return []; } }, "phone", controller.signal));
  assert.equal(reads, 0);
});
