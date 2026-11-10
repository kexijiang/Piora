import test from "node:test";
import assert from "node:assert/strict";
import { evaluationSettings, evaluationVariant, isolatedUiExecutor } from "../scripts/intelligent-ui-live-evaluation.mjs";

test("baseline and policy comparison share exactly the same tool schema", async () => {
  const baseline = await evaluationVariant("phase1"), candidate = await evaluationVariant("intent-4");
  assert.deepEqual(baseline.tools[0].parameters, candidate.tools[0].parameters);
  assert.notEqual(baseline.systemPrompt, candidate.systemPrompt);
  const plan = await evaluationVariant("plan-1");
  assert.equal(plan.tools[0].name, "piora_render_ui_plan");
  assert.doesNotMatch(plan.systemPrompt, /\bpiora_render_ui\b/);
  assert.match(plan.systemPrompt, /piora_render_ui_plan/);
  assert.ok(plan.tools[0].parameters);
  await assert.rejects(evaluationVariant("unknown"));
  await assert.rejects(evaluationVariant("intent-1"), /Unknown evaluation policy version/, "historical policy labels cannot silently receive revised guidance");
  await assert.rejects(evaluationVariant("intent-2"), /Unknown evaluation policy version/);
  await assert.rejects(evaluationVariant("intent-3"), /Unknown evaluation policy version/);
});

test("all current protocol variants receive the same revised control and clarification policy", async () => {
  for (const version of ["intent-4", "plan-1", "plan-2"]) {
    const { systemPrompt } = await evaluationVariant(version);
    assert.match(systemPrompt, /Intelligent UI decision policy: intent-4/);
    assert.match(systemPrompt, /number input by default/);
    assert.match(systemPrompt, /do not invent max or step/);
    assert.match(systemPrompt, /initial value is not an upper bound/);
    assert.match(systemPrompt, /currency or unit label does not imply a step or rounding rule/);
    assert.match(systemPrompt, /Missing slider bounds are not a reason to delay/);
    assert.match(systemPrompt, /brief, focused question/);
    assert.match(systemPrompt, /Titles, labels and text nodes are static/);
    assert.match(systemPrompt, /metrics or table cells bound to inputs or derived results/);
    assert.match(systemPrompt, /Distinguish a base unit price, a one-time fixed charge and the current calculated total/);
    assert.match(systemPrompt, /Keep conditional explanations conditional/);
    assert.match(systemPrompt, /distinguish adjustable values from the rule/);
    assert.match(systemPrompt, /ask which rule applies before calling the UI tool/);
    assert.match(systemPrompt, /user actually asks for that exploration/);
    assert.match(systemPrompt, /already given in the conversation/);
    assert.match(systemPrompt, /Making that fact editable does not make an invented initial value valid/);
    assert.match(systemPrompt, /Preserve every initial value the user has actually supplied/);
    assert.match((await evaluationVariant(version)).tools[0].description, /If a needed rule or rate is undecided or unavailable, ask first/);
  }
  assert.doesNotMatch((await evaluationVariant("phase1")).systemPrompt, /Intelligent UI decision policy: intent-4/);
});

test("legacy isolated execution computes results but never claims an application commit", async () => {
  const result = await isolatedUiExecutor({ signal: new AbortController().signal, state: new Map(), protocol: "surface-v1",
    call: { id: "call", name: "piora_render_ui", arguments: { id: "bill", title: "分账", nodes: [
      { id: "people", type: "number", label: "人数", value: 6 },
      { id: "share", type: "metric", label: "每人", value: { op: "divide", args: [480, { ref: "people" }] } },
    ] } } });
  assert.equal(result.evidence.generationValid, true);
  assert.match(result.content, /每人: 80/);
  assert.equal(result.committed, false);
  assert.equal(result.evidence.persistence, "not-tested");
});

test("plan experiments use the compiler and return bounded structural diagnostics", async () => {
  const result = await isolatedUiExecutor({ signal: new AbortController().signal, state: new Map(), protocol: "plan-v1",
    call: { id: "call", name: "piora_render_ui_plan", arguments: { planVersion: 1, id: "bill", title: "分账", inputs: [],
      derived: [{ id: "sum", op: "add", args: [{ input: "private-reference" }, { literal: 1 }] }],
      views: [{ id: "answer", kind: "metric", label: "合计", value: { derived: "sum" } }] } } });
  assert.equal(result.isError, true);
  assert.equal(result.evidence.generationValid, false);
  assert.equal(result.errorCode, "PLAN_REFERENCE");
  assert.deepEqual(result.evidence.diagnostic, JSON.parse(result.content));
  assert.equal(result.evidence.diagnostic.repairable, true);
  assert.doesNotMatch(JSON.stringify(result), /private-reference/);
});

test("model settings are applied explicitly and unknown options are rejected", () => {
  assert.equal(evaluationSettings({ maxTokens: 1200 }).maxTokens, 1200);
  assert.equal(evaluationSettings().maxRetries, 0);
  assert.throws(() => evaluationSettings({ apiKey: "no" }));
  assert.throws(() => evaluationSettings({ maxRetries: 5 }));
});

test("rich plan evaluation uses the real layout compiler and does not claim persistence", async () => {
  const variant = await evaluationVariant("plan-2");
  assert.equal(variant.protocol, "plan-v2");
  assert.equal(variant.tools[0].parameters.properties.planVersion.const, 2);
  const plan = { planVersion: 2, id: "bill", title: "分账", inputs: [{ id: "people", valueType: "number", label: "人数", value: 6 }], derived: [],
    views: [{ id: "answer", kind: "metric", label: "人数", value: { input: "people" } }],
    layout: [{ id: "group", type: "group", title: "调整人数", columns: 2, nodeIds: ["people", "answer"] }] };
  const execute = value => isolatedUiExecutor({ signal: new AbortController().signal, state: new Map(), protocol: variant.protocol,
    call: { id: "call", name: "piora_render_ui_plan", arguments: value } });
  const result = await execute(plan);
  assert.equal(result.evidence.surface.version, 2);
  assert.deepEqual(result.evidence.surface.layout, plan.layout);
  assert.equal(result.evidence.generationValid, true);
  assert.equal(result.committed, false);
  assert.equal(result.evidence.browserInteraction, "not-tested");
  const invalid = await execute({ ...plan, layout: [{ ...plan.layout[0], nodeIds: ["people"] }] });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.committed, false);
  assert.match(invalid.content, /Every node must be placed/);
});
