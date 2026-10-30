import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { validateEvaluationSuite, createEvaluationManifest, summarizeEvaluation, sha256 } from "./intelligent-ui/evaluation.mjs";

const suite = JSON.parse(readFileSync(new URL("../tests/fixtures/intelligent-ui/evaluation-cases.json", import.meta.url), "utf8"));
const manifest = (source = suite, options = {}) => createEvaluationManifest(source, { models: ["test/a"], policyVersions: ["phase1"], repetitions: 1, scope: "production-end-to-end", baselineSha256: "a".repeat(64), ...options });
const technical = { calculation: true, interaction: true, saved: true, reload: true, followup: true };
const reviews = [{ reviewer: "reviewer-a", semanticCorrect: true, choiceCorrect: true }, { reviewer: "reviewer-b", semanticCorrect: true, choiceCorrect: true }];
function run(id, options = {}) {
  const task = suite.tasks.find(task => task.id === id);
  return { taskId: id, model: "test/a", policyVersion: "phase1", repetition: 1, outcome: "completed", durationMs: 100,
    turns: task.turns.map(turn => ({ user: turn.user, assistant: "Observed answer", durationMs: 50, uiAttempts: [] })), ...options };
}
function uiRun(id = "d01", options = {}) {
  const value = run(id, options); value.turns.at(-1).uiAttempts = [{ toolCallId: "call-1", toolName: "piora_render_ui", committed: true }]; return value;
}
const summary = runs => summarizeEvaluation(suite, manifest(), runs).groups[0];

test("frozen natural-language suite has 60 tasks, exact category counts and disjoint families/domains", () => {
  validateEvaluationSuite(suite);
  assert.equal(suite.tasks.length, 60);
  assert.deepEqual(Object.fromEntries(["ui", "text", "clarify", "unsupported"].map(label => [label, suite.tasks.filter(t => t.label === label).length])), { ui: 30, text: 20, clarify: 5, unsupported: 5 });
  assert.equal(suite.tasks.filter(t => t.split === "development").length, 40);
  assert.equal(suite.tasks.filter(t => t.split === "heldout").length, 20);
  assert.equal(suite.version, "natural-language-2");
  assert.ok(suite.tasks.filter(task => task.turns.length > 1).every(task => task.turns.every(turn => turn.label)));
  assert.deepEqual(suite.tasks.find(task => task.id === "d11").turns.map(turn => turn.label), ["text", "ui"]);
  assert.ok(suite.tasks.every(task => task.turns.every(turn => !/piora_render_ui|barChart|UiSurface/.test(turn.user))));
  const contaminated = structuredClone(suite); contaminated.tasks.at(-1).family = contaminated.tasks[0].family;
  assert.throws(() => validateEvaluationSuite(contaminated), /leaks/);
});

test("no-call misses, provider failures and malformed attempts stay in end-to-end UI denominator", () => {
  const failed = uiRun("d02", { outcome: "provider-error" }); failed.turns[0].uiAttempts[0].committed = false;
  const report = summary([run("d01"), failed, uiRun("d03", { technical, reviews })]);
  assert.deepEqual(report.selectionMiss, { numerator: 1, denominator: 3, pending: 0, value: 1 / 3 });
  assert.deepEqual(report.finalUsable, { numerator: 1, denominator: 3, pending: 0, value: 1 / 3 });
  assert.deepEqual(report.selectedGenerationFailure, { numerator: 1, denominator: 2, pending: 0, value: .5 });
  assert.equal(report.tasks.length, 3); assert.equal(report.complete, false);
});

test("valid schema without browser/state checks or two independent judgments cannot claim usability", () => {
  const report = summary([uiRun()]);
  assert.deepEqual(report.finalUsable, { numerator: 0, denominator: 1, pending: 1, value: null });
  assert.equal(summary([uiRun("d01", { technical, reviews: [reviews[0]] })]).finalUsable.pending, 1);
  const disagreement = [reviews[0], { ...reviews[1], semanticCorrect: false }];
  assert.equal(summary([uiRun("d01", { technical, reviews: disagreement })]).finalUsable.pending, 1);
  assert.throws(() => summary([uiRun("d01", { technical, reviews: [reviews[0], reviews[0]] })]), /Distinct/);
});

test("isolated generation is reported separately from unmeasured production usability", () => {
  const observed = uiRun(); observed.turns[0].uiAttempts[0] = { ...observed.turns[0].uiAttempts[0], committed: false, evidence: { generationValid: true } };
  observed.transport = { scope: "isolated-model-generation" };
  const report = summarizeEvaluation(suite, manifest(suite, { scope: "isolated-model-generation" }), [observed]).groups[0];
  assert.equal(report.structurallyValidGeneration.value, 1);
  assert.equal(report.finalUsable.value, null); assert.equal(report.selectedGenerationFailure.value, null);
  assert.throws(() => summary([observed]), /scope/);
});

test("explicit user cancellations and unsupported tasks are separate; model cancellations stay failures", () => {
  const report = summary([run("d01", { outcome: "cancelled", cancellationSource: "user" }), run("d02", { outcome: "cancelled" }), run("d38")]);
  assert.equal(report.exclusions.userCancelled, 1); assert.equal(report.exclusions.unsupported, 1);
  assert.equal(report.finalUsable.denominator, 1); assert.equal(report.finalUsable.value, 0);
  assert.equal(report.unsupportedHandling.pending, 1);
});

test("admission termination remains a failed task in the UI denominator", () => {
  const stopped = uiRun("d01", { outcome: "admission-stopped" });
  stopped.turns[0].uiAttempts[0].committed = false;
  const report = summary([stopped]);
  assert.equal(report.outcomes["admission-stopped"], 1);
  assert.equal(report.finalUsable.denominator, 1);
  assert.equal(report.finalUsable.value, 0);
  assert.equal(report.exclusions.userCancelled, 0);
});

test("false triggers are counted in text tasks even when generated structure is valid", () => {
  const report = summary([run("d21"), uiRun("d22", { technical, reviews })]);
  assert.equal(report.falseTrigger.value, .5); assert.equal(report.finalUsable.denominator, 0);
});

test("repetitions remain distinct from independent task families and duplicate runs are rejected", () => {
  const runs = [run("d01"), run("d01", { repetition: 2 }), run("d01", { repetition: 3 })];
  const report = summarizeEvaluation(suite, manifest(suite, { repetitions: 3 }), runs).groups[0];
  assert.equal(report.runCount, 3); assert.equal(report.taskCount, 1); assert.equal(report.familyCount, 1); assert.equal(report.intervals, null);
  assert.throws(() => summary([run("d01"), run("d01")]), /Duplicate task run/);
  assert.throws(() => summary([run("h01")]), /frozen manifest/);
  const changed = structuredClone(suite); changed.tasks[0].label = "text";
  assert.throws(() => summarizeEvaluation(changed, manifest(), []), /differs/);
});

test("later successful repair does not hide failed first attempt", () => {
  const value = uiRun("d01", { technical, reviews });
  value.turns[0].uiAttempts.unshift({ toolCallId: "bad", toolName: "piora_render_ui", committed: false, errorCode: "invalid-reference" });
  const report = summary([value]);
  assert.equal(report.finalUsable.value, 1); assert.equal(report.firstUsable.value, 0);
  assert.equal(report.tasks[0].attemptCount, 2);
});

test("a UI in the wrong turn cannot hide the missing UI requested in the next turn", () => {
  const value = uiRun("d11", { technical, reviews: reviews.map(review => ({ ...review, choiceCorrect: false })) });
  value.turns[0].uiAttempts = value.turns[1].uiAttempts;
  value.turns[0].uiAttempts[0].evidence = { generationValid: true };
  value.turns[1].uiAttempts = [];
  const report = summary([value]);
  assert.equal(report.firstUsable.value, 0); assert.equal(report.finalUsable.value, 0);
  assert.equal(report.selectionMiss.value, 1); assert.equal(report.falseTrigger.value, 1);
  assert.equal(report.structurallyValidGeneration.value, 0);
  assert.equal(report.selectedGenerationFailure.denominator, 0);
  assert.deepEqual(report.turnSelection.selectionMiss, { numerator: 1, denominator: 1, pending: 0, value: 1 });
  assert.deepEqual(report.turnSelection.falseTrigger, { numerator: 1, denominator: 1, pending: 0, value: 1 });
  assert.deepEqual(report.tasks[0].turns.map(turn => [turn.expectedLabel, turn.attemptCount, turn.selectionMiss, turn.falseTrigger]), [
    ["text", 1, null, true], ["ui", 0, true, null],
  ]);
  // Even optimistic aggregate reviews cannot contradict the recorded turn-level calls.
  value.reviews = reviews;
  assert.equal(summary([value]).finalUsable.value, 0);
});

test("task usability requires a correct response choice as well as semantic and technical checks", () => {
  const value = uiRun("d01", { technical, reviews: reviews.map(review => ({ ...review, choiceCorrect: false })) });
  assert.equal(summary([value]).firstUsable.value, 0); assert.equal(summary([value]).finalUsable.value, 0);
  value.reviews = [reviews[0], { ...reviews[1], choiceCorrect: false }];
  assert.equal(summary([value]).finalUsable.pending, 1);
  const correct = summary([uiRun("d11", { technical, reviews })]);
  assert.equal(correct.finalUsable.value, 1); assert.equal(correct.firstUsable.value, 1);
  assert.equal(correct.turnSelection.selectionMiss.value, 0); assert.equal(correct.turnSelection.falseTrigger.value, 0);
});

test("legacy multi-turn labels stay pending; task label cannot be guessed as every turn's intent", () => {
  const historical = structuredClone(suite);
  historical.version = "legacy-without-turn-labels";
  const task = historical.tasks.find(task => task.id === "d11");
  for (const turn of task.turns) delete turn.label;
  const value = uiRun("d11", { technical, reviews });
  const report = summarizeEvaluation(historical, manifest(historical), [value]).groups[0];
  assert.equal(report.finalUsable.pending, 1); assert.equal(report.firstUsable.pending, 1);
  assert.equal(report.selectionMiss.pending, 1); assert.equal(report.structurallyValidGeneration.pending, 1);
  assert.equal(report.turnSelection.labelCoverageComplete, false); assert.equal(report.turnSelection.unlabeledTurns, 2);
  assert.deepEqual(report.tasks[0].turns.map(turn => turn.expectedLabel), [null, null]);
  // Single-turn historical suites retain the unambiguous task-level fallback.
  const single = summarizeEvaluation(historical, manifest(historical), [uiRun("d01", { technical, reviews })]).groups[0];
  assert.equal(single.finalUsable.value, 1);
});

test("unreached turns fail the full task without inventing a model choice", () => {
  const value = run("d11", { outcome: "provider-error" }); value.turns.pop();
  const report = summary([value]);
  assert.equal(report.finalUsable.value, 0);
  assert.equal(report.turnSelection.selectionMiss.pending, 1);
  assert.equal(report.turnSelection.unobservedTurns, 1);
  assert.equal(report.tasks[0].turns[1].observed, false);
});

test("each requested UI turn must succeed; a later call cannot replace an earlier missing result", () => {
  const twoUi = structuredClone(suite), task = twoUi.tasks.find(task => task.id === "d11");
  task.turns = [{ label: "ui", user: "做个可调人数的分账工具，总额100元，先两人。" }, { label: "ui", user: "给它再加个固定服务费输入，计入总额后分摊。" }];
  const value = run("d11", { technical, reviews });
  value.turns = task.turns.map(turn => ({ user: turn.user, assistant: "完成", durationMs: 1, uiAttempts: [] }));
  value.turns[1].uiAttempts = [{ toolCallId: "late", toolName: "piora_render_ui", committed: true }];
  const evaluate = () => summarizeEvaluation(twoUi, manifest(twoUi), [value]).groups[0];
  assert.equal(evaluate().finalUsable.value, 0);
  assert.equal(evaluate().turnSelection.selectionMiss.value, .5);
  value.turns[0].uiAttempts = [{ toolCallId: "early", toolName: "piora_render_ui", committed: true }];
  assert.equal(evaluate().finalUsable.value, 1); assert.equal(evaluate().firstUsable.value, 1);
});

test("CLI prepare freezes a no-network manifest and refuses overwrite", t => {
  const root = mkdtempSync(join(tmpdir(), "ui-eval-test-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const args = ["scripts/evaluate-intelligent-ui.mjs", "prepare", "--models", "test/a,test/b", "--output", root];
  const first = spawnSync(process.execPath, args, { cwd: new URL("../", import.meta.url), encoding: "utf8", windowsHide: true });
  assert.equal(first.status, 0, first.stderr);
  const frozen = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  assert.equal(frozen.expectedRunCount, 480); assert.equal(frozen.suiteSha256, sha256(suite));
  assert.equal(frozen.scope, "isolated-model-generation");
  assert.notEqual(spawnSync(process.execPath, args, { cwd: new URL("../", import.meta.url), windowsHide: true }).status, 0);
});

test("CLI run records no-tool answers, resumes without duplicate tasks, and rejects a changed adapter", t => {
  const root = mkdtempSync(join(tmpdir(), "ui-eval-run-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, "results"), adapter = join(root, "adapter.mjs");
  const source = `import {readFileSync} from 'node:fs'; export async function describeEvaluation() { return {dependency:readFileSync(new URL('./dependency.txt',import.meta.url),'utf8')}; } export async function runTask({task}) { return { outcome:'completed', turns:task.turns.map(t=>({user:t.user,assistant:'fixture answer',durationMs:1,uiAttempts:[]})) }; }`;
  writeFileSync(join(root, "dependency.txt"), "original-schema-and-policy");
  writeFileSync(adapter, source);
  const cli = (...args) => spawnSync(process.execPath, ["scripts/evaluate-intelligent-ui.mjs", ...args], { cwd: new URL("../", import.meta.url), encoding: "utf8", windowsHide: true });
  assert.equal(cli("prepare", "--models", "test/a", "--policies", "phase1", "--repetitions", "1", "--output", output).status, 0);
  for (let i = 0; i < 2; i++) {
    const result = cli("run", "--output", output, "--adapter", adapter, "--max-runs", "1");
    assert.equal(result.status, 0, result.stderr);
  }
  const runs = readFileSync(join(output, "runs.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(runs.map(run => run.taskId), ["d01", "d02"]);
  assert.deepEqual(runs[0].turns[0].uiAttempts, []);
  const report = JSON.parse(readFileSync(join(output, "summary.json"), "utf8"));
  assert.equal(report.complete, false); assert.equal(report.groups[0].selectionMiss.numerator, 2);
  writeFileSync(adapter, source + "\n// changed");
  const changed = cli("run", "--output", output, "--adapter", adapter, "--max-runs", "1");
  assert.notEqual(changed.status, 0); assert.match(changed.stderr, /Adapter or dependencies changed/);
  assert.equal(readFileSync(join(output, "runs.jsonl"), "utf8").trim().split("\n").length, 2);
  writeFileSync(adapter, source);
  writeFileSync(join(root, "dependency.txt"), "changed-transitive-policy");
  const dependencyChanged = cli("run", "--output", output, "--adapter", adapter, "--max-runs", "1");
  assert.notEqual(dependencyChanged.status, 0); assert.match(dependencyChanged.stderr, /dependencies changed/);
  writeFileSync(join(root, "dependency.txt"), "original-schema-and-policy");
  const manifestPath = join(output, "manifest.json"), modified = JSON.parse(readFileSync(manifestPath, "utf8"));
  modified.modelSettings = { maxTokens: 1 }; writeFileSync(manifestPath, JSON.stringify(modified, null, 2) + "\n");
  const settingsChanged = cli("run", "--output", output, "--adapter", adapter, "--max-runs", "1");
  assert.notEqual(settingsChanged.status, 0); assert.match(settingsChanged.stderr, /Frozen manifest changed/);
});
