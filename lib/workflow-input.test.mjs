import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { parseWorkflowPromptOptions, parseWorkflowAction } = await jiti.import("./workflow-input.ts");

test("workflow input rejects malformed modes and unbounded or fractional budgets", () => {
  for (const value of [null, [], "goal", {}, { mode: "other" }, { mode: "goal", turnBudget: 0 }, { mode: "goal", turnBudget: 101 }, { mode: "goal", turnBudget: 1.5 }, { mode: "goal", turnBudget: "2" }]) {
    assert.throws(() => parseWorkflowPromptOptions(value));
  }
  assert.equal(parseWorkflowPromptOptions(undefined), undefined);
  assert.deepEqual(parseWorkflowPromptOptions({ mode: "goal", turnBudget: 2, current: { status: "completed" } }), { mode: "goal", turnBudget: 2 });
});

test("workflow decisions require exact run and revision identity", () => {
  for (const value of [{ action: "approve" }, { action: "approve", runId: "run", expectedRevision: -1 }, { action: "approve", runId: "run", expectedRevision: "2" }, { action: "complete", runId: "run", expectedRevision: 2 }]) {
    assert.throws(() => parseWorkflowAction(value));
  }
  assert.deepEqual(parseWorkflowAction({ action: "resume", runId: "run", expectedRevision: 2, prompt: "untrusted override" }), { action: "resume", runId: "run", expectedRevision: 2 });
});
