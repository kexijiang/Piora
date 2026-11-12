import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { WorkflowRuntime, planToolAllowed } = await jiti.import("./workflow-runtime.ts");
const { WorkflowStore } = await jiti.import("./workflow-store.ts");
const { writeLaboratorySettings, getLaboratorySettingsPath } = await jiti.import("./laboratory-settings.ts");
async function fixture(t, mode = "goal", turnBudget = 10) {
  const directory = await mkdtemp(join(tmpdir(), "piora-workflow-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  writeLaboratorySettings({ planGoalEnabled: true });
  t.after(async () => {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    await rm(directory, { recursive: true, force: true });
  });
  const store = new WorkflowStore(directory);
  const runtime = new WorkflowRuntime("session-a", store);
  runtime.attach(); runtime.configure({ mode, turnBudget }); runtime.preparePrompt("Preserve the full original goal, including tests."); runtime.beginTurn();
  return { runtime, store };
}
function action(runtime, name, extra = {}) {
  const state = runtime.getSnapshot();
  return runtime.action({ action: name, runId: state.current.id, expectedRevision: state.revision, ...extra });
}
test("Plan enforces inspection tools and explicit HTTP URL reads", () => {
  for (const name of ["read", "grep", "find", "ls", "piora_request_user_input"]) assert.equal(planToolAllowed(name, {}), true);
  for (const name of ["bash", "powershell", "write", "edit", "mcp_read", "unknown"]) assert.equal(planToolAllowed(name, {}), false);
  for (const value of [{ action: "open", url: "https://example.com" }, { action: "snapshot" }]) assert.equal(planToolAllowed("browser", value), true);
  for (const value of [{ action: "open", url: "javascript:alert(1)" }, { action: "new_tab", url: "file:///secret" }, { action: "evaluate" }, { action: "click" }, { action: "type" }, { action: "press" }]) assert.equal(planToolAllowed("browser", value), false);
});
test("a missing extension cannot activate a mode", async t => {
  const { store } = await fixture(t);
  const runtime = new WorkflowRuntime("unattached", store);
  assert.throws(() => runtime.configure({ mode: "plan" }), /unavailable/);
});
test("plan snapshots survive reads, revisions preserve history, approval is one-shot", async t => {
  const { runtime, store } = await fixture(t, "plan");
  runtime.submitPlan("First", "# Objective\nFull objective\n# Steps\n1. Implement\n# Verify\nRun tests");
  const first = runtime.getSnapshot();
  assert.equal(store.read("session-a").snapshot.current.markdown, first.current.markdown);
  assert.throws(() => runtime.preparePrompt("sneak implementation"), /Review/);
  action(runtime, "revise"); runtime.preparePrompt("Revise validation"); runtime.beginTurn(); runtime.submitPlan("Second", "Revised complete plan");
  const revised = runtime.getSnapshot();
  assert.equal(revised.history[0].markdown, first.current.markdown);
  assert.equal(revised.current.version, 2);
  const input = { action: "approve", runId: revised.current.id, expectedRevision: revised.revision };
  assert.match(runtime.action(input).prompt, /Revised complete plan/);
  assert.equal(runtime.action(input).prompt, undefined);
  assert.equal(runtime.getSnapshot().mode, "agent");
  runtime.preparePrompt("synthetic approval instruction");
  assert.equal(runtime.getSnapshot().current.objective, first.current.objective);
  runtime.onPromptSettled(); assert.equal(runtime.getSnapshot().current.status, "completed");
});
test("stale actions cannot approve a different plan", async t => {
  const { runtime } = await fixture(t, "plan"); runtime.submitPlan("Plan", "Content");
  const state = runtime.getSnapshot(); action(runtime, "revise");
  assert.throws(() => runtime.action({ action: "approve", runId: state.current.id, expectedRevision: state.revision }), /stale/);
});

test("resuming interrupted approved execution preserves its exact plan as an earlier version", async t => {
  const { runtime } = await fixture(t, "plan");
  runtime.submitPlan("Approved artifact", "Exact approved content");
  action(runtime, "approve"); runtime.onAbort();
  const approved = runtime.getSnapshot().current;
  assert.match(action(runtime, "resume").prompt, /Submit a complete revised plan for review/);
  runtime.preparePrompt("Host resume instruction"); runtime.beginTurn();
  runtime.submitPlan("Revised artifact", "New plan after interruption");
  const revised = runtime.getSnapshot();
  assert.equal(revised.mode, "plan");
  assert.equal(revised.current.status, "awaiting_approval");
  assert.equal(revised.current.version, approved.version + 1);
  assert.equal(revised.history.at(-1).markdown, approved.markdown);
  assert.equal(revised.history.at(-1).title, approved.title);
  assert.equal(revised.history.at(-1).version, approved.version);
});
test("goal requires evidence for every locked criterion and retains objective", async t => {
  const { runtime } = await fixture(t);
  const pending = { id: "tests", text: "Tests pass", status: "pending", evidence: "" };
  runtime.updateGoal({ progress: "Started", criteria: [pending] });
  assert.throws(() => runtime.updateGoal({ progress: "Done", status: "completed" }), /Every acceptance/);
  assert.throws(() => runtime.updateGoal({ progress: "Narrow scope", criteria: [{ ...pending, text: "Only a tiny test" }] }), /redefined/);
  runtime.updateGoal({ progress: "Tested", criteria: [{ ...pending, status: "verified", evidence: "node --test selected.test.mjs: 3 passed" }], status: "completed" });
  assert.equal(runtime.endTurn(), undefined);
  assert.equal(runtime.getSnapshot().current.turnsUsed, 1);
  assert.match(runtime.getSnapshot().current.objective, /including tests/);
});
test("budget terminates continuation, raising it requires explicit resume", async t => {
  const { runtime } = await fixture(t, "goal", 2);
  runtime.updateGoal({ progress: "First progress" }); assert.match(runtime.endTurn(), /Continue/);
  runtime.beginTurn(); runtime.updateGoal({ progress: "Second progress" }); assert.equal(runtime.endTurn(), undefined);
  assert.equal(runtime.getSnapshot().current.status, "budget_exhausted");
  assert.throws(() => action(runtime, "resume"), /Increase/);
  action(runtime, "set_budget", { turnBudget: 4 }); assert.equal(runtime.getSnapshot().current.status, "budget_exhausted");
  assert.match(action(runtime, "resume").prompt, /Continue/);
});
test("three unchanged turns stop for no progress", async t => {
  const { runtime } = await fixture(t);
  assert.ok(runtime.endTurn()); runtime.beginTurn(); assert.ok(runtime.endTurn()); runtime.beginTurn();
  assert.equal(runtime.endTurn(), undefined);
  assert.equal(runtime.getSnapshot().current.reason, "no_progress");
});
test("user clarification resumes a waiting goal without rewriting its objective or criteria", async t => {
  const { runtime } = await fixture(t);
  runtime.updateGoal({ progress: "Need the target path", status: "waiting", reason: "Which folder?", criteria: [{ id: "target", text: "Complete the requested change", status: "pending", evidence: "" }] });
  const original = runtime.getSnapshot().current;
  runtime.endTurn(); runtime.preparePrompt("Use the project folder");
  const resumed = runtime.getSnapshot().current;
  assert.equal(resumed.status, "running");
  assert.equal(resumed.objective, original.objective);
  assert.deepEqual(resumed.criteria, original.criteria);
  action(runtime, "pause");
  assert.throws(() => runtime.preparePrompt("A new message"), /Resume/);
});
test("a missing required helper cannot activate or resume a workflow", async t => {
  const { runtime } = await fixture(t, "plan");
  action(runtime, "pause");
  runtime.attach(() => ["read"]);
  assert.throws(() => runtime.configure({ mode: "goal" }), /piora_update_goal/);
  assert.throws(() => action(runtime, "resume"), /piora_submit_plan/);
});

test("a clarification cannot exceed the budget after the final turn waits for user input", async t => {
  const { runtime } = await fixture(t, "goal", 1);
  runtime.updateGoal({ progress: "Need a path", status: "waiting", reason: "Which folder?" });
  runtime.endTurn();
  assert.equal(runtime.getSnapshot().current.turnsUsed, 1);
  assert.equal(runtime.getSnapshot().current.status, "waiting");
  assert.throws(() => runtime.preparePrompt("Use the project folder"), /Increase the turn budget/);
  assert.throws(() => action(runtime, "resume"), /Increase the turn budget/);
  action(runtime, "set_budget", { turnBudget: 2 });
  runtime.preparePrompt("Use the project folder");
  assert.equal(runtime.getSnapshot().current.status, "running");
  assert.match(runtime.getSnapshot().current.objective, /including tests/);
});
test("pause and cancellation fence late completion and queued continuation", async t => {
  const { runtime } = await fixture(t);
  action(runtime, "pause");
  assert.throws(() => runtime.updateGoal({ progress: "Late", status: "completed" }), /not active/);
  assert.equal(runtime.endTurn(), undefined);
  action(runtime, "resume"); runtime.beginTurn(); action(runtime, "cancel"); runtime.onAbort();
  assert.equal(runtime.endTurn(), undefined); assert.equal(runtime.getSnapshot().current.status, "cancelled");
});
test("restart pauses active work without altering review-ready plans or other sessions", async t => {
  const { runtime, store } = await fixture(t);
  const record = store.read("session-a"); record.epoch = "dead-process"; store.write(record);
  assert.equal(store.read("session-a").snapshot.current.reason, "host_restarted");
  assert.equal(store.read("session-b").snapshot.current, null);
  assert.equal(runtime.getSnapshot().current.status, "paused");
});
test("restart preserves an exact pending plan but fences pre-restart approval clicks", async t => {
  const { runtime, store } = await fixture(t, "plan"); runtime.submitPlan("Review", "Exact immutable plan");
  const before = runtime.getSnapshot();
  const record = store.read("session-a"); record.epoch = "dead-process"; store.write(record);
  const after = runtime.getSnapshot();
  assert.equal(after.current.status, "awaiting_approval");
  assert.equal(after.current.markdown, before.current.markdown);
  assert.ok(after.revision > before.revision);
  assert.throws(() => runtime.action({ action: "approve", runId: before.current.id, expectedRevision: before.revision }), /stale/);
});
test("error settlement records failure and does not overwrite finished or review-ready runs", async t => {
  const { runtime } = await fixture(t, "plan"); runtime.submitPlan("Review", "Plan"); runtime.onAbort(); runtime.onPromptError("transport");
  assert.equal(runtime.getSnapshot().current.status, "awaiting_approval");
  action(runtime, "approve"); runtime.onPromptError("provider failed"); assert.equal(runtime.getSnapshot().current.status, "failed");
});

test("laboratory disable gates activation and continuation while preserving a resumable goal", async t => {
  const { runtime } = await fixture(t);
  runtime.updateGoal({ progress: "Inspected requirements", criteria: [{ id: "tests", text: "Requested tests pass", status: "pending", evidence: "" }] });
  const before = runtime.getSnapshot();
  writeLaboratorySettings({ planGoalEnabled: false });
  assert.deepEqual(runtime.getSnapshot(), before, "saving the switch does not erase or rewrite workflow history");
  assert.throws(() => runtime.configure({ mode: "plan" }), /Settings > Laboratory/);
  assert.throws(() => runtime.preparePrompt("Bypass using an API prompt"), /Settings > Laboratory/);
  assert.throws(() => action(runtime, "set_budget", { turnBudget: 20 }), /Settings > Laboratory/);
  assert.equal(runtime.endTurn(), undefined);
  const paused = runtime.getSnapshot();
  assert.equal(paused.current.status, "paused");
  assert.equal(paused.current.reason, "laboratory_disabled");
  assert.equal(paused.current.turnsUsed, 1);
  assert.throws(() => action(runtime, "resume"), /Settings > Laboratory/);
  writeLaboratorySettings({ planGoalEnabled: true });
  assert.match(action(runtime, "resume").prompt, /Continue the existing goal/);
  assert.equal(runtime.getSnapshot().current.objective, before.current.objective);
  assert.deepEqual(runtime.getSnapshot().current.criteria, before.current.criteria);
});

test("disabling laboratory keeps current Plan read-only and review history while blocking approve and revise", async t => {
  const { runtime } = await fixture(t, "plan");
  writeLaboratorySettings({ planGoalEnabled: false });
  assert.equal(planToolAllowed("write", {}), false);
  runtime.submitPlan("Saved while disabled", "Exact review artifact");
  const review = runtime.getSnapshot();
  for (const name of ["approve", "revise"]) assert.throws(() => action(runtime, name), /Settings > Laboratory/);
  assert.deepEqual(runtime.getSnapshot(), review);
  action(runtime, "exit");
  assert.equal(runtime.getSnapshot().mode, "agent");
  assert.equal(runtime.getSnapshot().current.markdown, review.current.markdown);
});

test("laboratory disabled still permits pause, cancel and selecting ordinary Agent", async t => {
  const { runtime } = await fixture(t);
  writeLaboratorySettings({ planGoalEnabled: false });
  action(runtime, "pause"); action(runtime, "cancel");
  runtime.configure({ mode: "agent" }); runtime.preparePrompt("Normal Agent request");
  assert.equal(runtime.getSnapshot().mode, "agent");
  assert.equal(runtime.getSnapshot().current.status, "cancelled");
});

test("a corrupt laboratory file pauses goal settlement without throwing or queuing another turn", async t => {
  const { runtime } = await fixture(t);
  const objective = runtime.getSnapshot().current.objective;
  await writeFile(getLaboratorySettingsPath(), "{malformed-json");
  assert.equal(runtime.endTurn(), undefined);
  const paused = runtime.getSnapshot();
  assert.equal(paused.current.status, "paused");
  assert.equal(paused.current.reason, "laboratory_disabled");
  assert.equal(paused.current.turnsUsed, 1);
  assert.equal(paused.current.objective, objective);
  writeLaboratorySettings({ planGoalEnabled: true });
  assert.match(action(runtime, "resume").prompt, /Continue the existing goal/);
});
