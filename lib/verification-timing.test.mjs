import assert from "node:assert/strict";
import test from "node:test";
import { createVerificationTimings } from "../scripts/verification-timing.mjs";

test("verification timing preserves results, failures and cleanup failures", async () => {
  const events = [];
  const timer = createVerificationTimings("fixture", event => events.push(event));
  assert.equal(await timer.measure("success", () => 42), 42);
  const failure = new Error("acceptance failed");
  await assert.rejects(timer.measure("failure", () => { throw failure; }), error => error === failure);
  await assert.rejects(timer.measure("cleanup", async () => { throw new Error("cleanup failed"); }), /cleanup failed/);
  assert.deepEqual(events.map(({ phase, status }) => [phase, status]), [["success", "success"], ["failure", "failure"], ["cleanup", "failure"]]);
  assert.ok(events.every(event => event.durationMs >= 0 && event.startedAt && event.finishedAt));
});
