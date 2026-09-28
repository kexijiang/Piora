import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const { ScenarioExecutionStore, observationFingerprint } = await createJiti(import.meta.url).import("./harmony/scenario/execution-store.ts");
const snapshot = { serial: "phone", quality: { treeStatus: "valid", scopeComplete: true, scope: "active-windows" }, nodes: [{ ref: "a", text: "Ready", id: "ready" }] };
test("durable checkpoint recovery checks task, fresh UI and uncertain side effects", () => {
  const dir = mkdtempSync(join(tmpdir(), "piora-execution-"));
  try {
    const store = new ScenarioExecutionStore(dir);
    const options = { serial: "phone", steps: [{ action: "checkpoint", name: "ready" }, { action: "uninstall_app", bundleName: "com.test" }] };
    const execution = store.create(options, { id: "run-a", sessionId: "task-a" }, 1);
    execution.status = "failed";
    execution.checkpoint = { name: "ready", stepIndex: 0, observationHash: observationFingerprint(snapshot) };
    execution.steps[0].status = "passed";
    execution.steps[1].status = "failed";
    execution.steps[1].error = { code: "CAPABILITY_UNAVAILABLE", details: { dispatchState: "not-sent" } };
    store.write(execution);
    const restored = new ScenarioExecutionStore(dir);
    assert.equal(restored.resumeInputs(execution.id, snapshot, "task-a").steps.length, 1);
    assert.throws(() => restored.resumeInputs(execution.id, snapshot, "task-b"));
    assert.throws(() => restored.resumeInputs(execution.id, { ...snapshot, nodes: [{ text: "Other" }] }, "task-a"));
    execution.steps[1].error.details.dispatchState = "unknown"; store.write(execution);
    assert.throws(() => restored.resumeInputs(execution.id, snapshot, "task-a"), error => error.code === "SCENARIO_FAILED");
    assert.equal(JSON.stringify(restored.list()).includes("com.test"), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
