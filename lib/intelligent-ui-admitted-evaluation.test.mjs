import test from "node:test";
import assert from "node:assert/strict";
import { createAdmittedUiTurn, evaluationVariant } from "../scripts/intelligent-ui-live-evaluation.mjs";
import { createUiModelAdapter } from "../scripts/intelligent-ui-model-adapter.mjs";

const plan = () => ({ planVersion: 2, id: "bill", title: "Calculator",
  inputs: [{ id: "amount", label: "Amount", valueType: "number", value: 3 }], derived: [],
  views: [{ id: "answer", kind: "metric", label: "Result", value: { input: "amount" } }],
  layout: [{ id: "group", type: "group", title: "Adjust", columns: 2, nodeIds: ["amount", "answer"] }] });
const badPlan = () => { const value = plan(); value.views[0].value = { input: "missing" }; return value; };
const call = (id, args = plan(), name = "piora_render_ui_plan") => ({ type: "toolCall", id, name, arguments: args });
async function turn(t, version = "plan-2", signal = new AbortController().signal) {
  const configuration = await evaluationVariant(version);
  const executor = await createAdmittedUiTurn({ configuration, signal });
  t.after(executor.close);
  const state = new Map();
  return { ...executor, state, invoke: c => executor.execute({ call: c, state }) };
}

test("real binding and SDK settle one correction; a third repaired plan cannot become a success", async t => {
  const f = await turn(t);
  const bad = plan(); bad.views[0].value = { derived: "undeclared" };
  const first = await f.invoke(call("one", bad));
  assert.equal(first.errorCode, "PLAN_REFERENCE");
  assert.equal(first.evidence.diagnostic.repairable, true);
  assert.deepEqual(JSON.parse(first.evidence.arguments), bad, "synthetic pre-validation errors remain reproducible");
  assert.doesNotMatch(first.content, /undeclared/, "raw values stay out of model feedback");
  const second = await f.invoke(call("two", bad));
  assert.equal(second.errorCode, "PLAN_REFERENCE");
  const denied = await f.invoke(call("three"));
  assert.equal(denied.errorCode, "UI_CORRECTIONS_EXHAUSTED");
  assert.equal(denied.evidence.generationValid, false);
  assert.equal(f.state.size, 0);
  assert.deepEqual([f.snapshot().attempts, f.snapshot().corrections], [2, 1]);
  assert.equal((await f.invoke(call("four"))).terminate, true);
});

test("nonrepairable compiler limit stops correction and preserves the last admitted surface", async t => {
  const f = await turn(t);
  const valid = await f.invoke(call("initial"));
  assert.equal(valid.evidence.generationValid, true);
  assert.equal(valid.committed, false);
  const previous = structuredClone(f.state.get("bill"));
  const oversized = plan(); oversized.title = "x".repeat(64_001);
  const failure = await f.invoke(call("oversized", oversized));
  assert.equal(failure.errorCode, "PLAN_LIMIT");
  assert.equal(failure.evidence.diagnostic.repairable, false);
  assert.equal(failure.evidence.argumentsTruncated, true);
  assert.equal(failure.evidence.arguments.length, 64_000);
  assert.equal((await f.invoke(call("retry"))).errorCode, "UI_OPERATION_FAILED");
  assert.deepEqual(f.state.get("bill"), previous);
});

test("SDK schema failures consume the same correction allowance for Surface v1", async t => {
  const f = await turn(t, "phase1");
  const first = await f.invoke(call("one", {}, "piora_render_ui"));
  assert.equal(first.errorCode, "UI_ARGUMENTS_INVALID");
  const repaired = await f.invoke(call("two", { id: "bill", title: "Bill", nodes: [
    { id: "amount", type: "number", label: "Amount", value: 4 },
    { id: "answer", type: "metric", label: "Result", value: { ref: "amount" } },
  ] }, "piora_render_ui"));
  assert.equal(repaired.evidence.generationValid, true);
  assert.equal(repaired.evidence.admission.corrections, 1);
  assert.equal(repaired.evidence.persistence, "not-tested");
});

test("original plan types are checked before SDK coercion", async t => {
  const f = await turn(t);
  const invalid = plan(); invalid.inputs[0].value = null;
  const result = await f.invoke(call("null-number", invalid));
  assert.equal(result.evidence.generationValid, false);
  assert.equal(result.evidence.admission.attempts, 1);
  assert.equal(f.state.size, 0);
  assert.equal((await f.invoke(call("repair"))).evidence.generationValid, true);
});

test("the 60-second UI deadline begins at the first attempt and cannot be renewed", async t => {
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  const f = await turn(t);
  now += 300_000;
  assert.equal((await f.invoke(call("one"))).evidence.generationValid, true);
  const prior = structuredClone(f.state.get("bill"));
  now += 60_001;
  const late = await f.invoke(call("two"));
  assert.equal(late.errorCode, "UI_DEADLINE_EXCEEDED");
  assert.equal(f.snapshot().attempts, 1);
  assert.deepEqual(f.state.get("bill"), prior);
});

test("duplicate call replay has no extra execution; a closed originating run stays unavailable", async t => {
  const f = await turn(t);
  const first = await f.invoke(call("same"));
  const replay = await f.invoke(call("same"));
  assert.equal(replay.evidence.surface.revision, first.evidence.surface.revision);
  assert.equal(f.snapshot().attempts, 1);
  const changed = plan(); changed.inputs[0].value = 8;
  assert.equal((await f.invoke(call("same", changed))).errorCode, "UI_CALL_ID_CONFLICT");
  f.close();
  assert.equal((await f.invoke(call("late"))).errorCode, "UI_RUN_UNAVAILABLE");
});

test("three successful revisions exhaust the attempt limit without publishing a fourth", async t => {
  const f = await turn(t);
  for (let i = 1; i <= 3; i++) {
    assert.equal((await f.invoke(call(`revision-${i}`))).evidence.surface.revision, i);
  }
  const denied = await f.invoke(call("fourth"));
  assert.equal(denied.errorCode, "UI_ATTEMPTS_EXHAUSTED");
  assert.equal(f.state.get("bill").revision, 3);
  assert.equal(f.snapshot().attempts, 3);
});

test("cancellation rejects later calls and leaves the previous surface intact", async t => {
  const controller = new AbortController();
  const f = await turn(t, "plan-2", controller.signal);
  await f.invoke(call("initial"));
  const previous = structuredClone(f.state.get("bill"));
  controller.abort();
  await assert.rejects(f.invoke(call("cancelled")), { name: "AbortError" });
  assert.deepEqual(f.state.get("bill"), previous);
});

const reply = content => ({ role: "assistant", content, stopReason: content.some(item => item.type === "toolCall") ? "toolUse" : "stop" });
function adapter(responses) {
  const requests = [];
  const runtime = { getModel: () => ({ provider: "test", id: "fixture" }), completeSimple: async (_model, context) => {
    requests.push(structuredClone(context)); return responses.shift();
  } };
  return { requests, ...createUiModelAdapter({ runtime, variant: evaluationVariant, createTurnExecutor: createAdmittedUiTurn,
    maxRequestsPerTurn: 8, maxToolAttemptsPerTurn: 8 }) };
}
const input = { model: "test/fixture", policyVersion: "plan-2", task: { turns: [{ user: "Let me adjust it" }] } };

test("repeated denial ends the transport with an explicit failed outcome and no extra provider request", async () => {
  const f = adapter([reply([call("bad1", badPlan())]), reply([call("bad2", badPlan())]), reply([call("retry1")]), reply([call("retry2")])]);
  const result = await f.runTask(input);
  assert.equal(result.outcome, "admission-stopped");
  assert.equal(f.requests.length, 4);
  assert.equal(result.turns[0].uiAttempts.length, 4);
  assert.ok(result.turns[0].uiAttempts.every(a => a.evidence.generationValid === false));
  assert.equal(result.turns[0].admission.corrections, 1);
  assert.equal(result.transport.admission.implementation, "production-binding-and-sdk-runToolCall");
});

test("each synthetic user turn gets a new budget, while provider retries within it share one", async () => {
  const f = adapter([reply([call("bad1", badPlan())]), reply([call("bad2", badPlan())]), reply([{ type: "text", text: "Unable to create it." }]),
    reply([call("fresh")]), reply([{ type: "text", text: "Ready." }])]);
  const result = await f.runTask({ ...input, task: { turns: [...input.task.turns, { user: "Try a new calculation" }] } });
  assert.equal(result.outcome, "completed");
  assert.equal(result.turns[0].admission.terminal, "UI_CORRECTIONS_EXHAUSTED");
  assert.equal(result.turns[1].admission.attempts, 1);
  assert.equal(result.turns[1].admission.corrections, 0);
  assert.equal(result.turns[1].uiAttempts[0].evidence.generationValid, true);
  assert.notEqual(result.turns[0].admission.runId, result.turns[1].admission.runId);
});
