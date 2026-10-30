import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";

const jiti = createJiti(import.meta.url);
const { compileUiRichPlan, tryCompileUiRichPlan, UiPlanError } = await jiti.import("./rich-plan.ts");
const { uiRichPlanSchema } = await jiti.import("./rich-plan-schema.ts");
const { compileUiPlan } = await jiti.import("./plan.ts");
const { uiPlanSchema } = await jiti.import("./plan-schema.ts");
const { evaluateRichSurface, richInitialState, formatRichSnapshot, validateRichSurface } = await jiti.import("./rich-protocol.ts");
const { validateSurface } = await jiti.import("./protocol.ts");
const { intelligentUiRichPlanPrompt, intelligentUiPlanPrompt, intelligentUiSurfacePrompt } = await jiti.import("./decision-policy.ts");
const literal = value => ({ literal: value }), input = id => ({ input: id }), derived = id => ({ derived: id });
const number = (id, value, extra = {}) => ({ id, valueType: "number", label: id, value, ...extra });
const metric = (id, value, extra = {}) => ({ id, kind: "metric", label: id, value, ...extra });
const compile = value => compileUiRichPlan(value, { revision: 7 });
const core = plan => Object.fromEntries(Object.entries({ ...plan, planVersion: 1 }).filter(([key]) => key !== "layout"));
function fixture() {
  return { planVersion: 2, id: "supplies", title: "Compare supplied choices", inputs: [
    number("people", 4, { min: 1, step: 1 }), number("unitPrice", 12, { unit: "元", min: 0 }),
    number("discount", 0, { min: 0, max: 50, presentation: "slider" }), number("budget", 200, { min: 0 }),
    { id: "category", label: "Category", valueType: "string", value: "All", options: ["All", "A", "B"] },
    { id: "available", label: "Only available", valueType: "boolean", value: false },
  ], derived: [
    { id: "quantity", op: "multiply", args: [input("people"), literal(2)] },
    { id: "gross", op: "multiply", args: [derived("quantity"), input("unitPrice")] },
    { id: "discountFraction", op: "divide", args: [input("discount"), literal(100)] },
    { id: "multiplier", op: "subtract", args: [literal(1), derived("discountFraction")] },
    { id: "total", op: "multiply", args: [derived("gross"), derived("multiplier")] },
    { id: "doubleTotal", op: "multiply", args: [derived("total"), literal(2)] },
  ], views: [
    metric("quantityView", derived("quantity")), metric("totalView", derived("total"), { unit: "元" }),
    { id: "note", kind: "text", text: "Prices are supplied examples." },
    { id: "table", kind: "table", columns: ["Name", "Category", "Cost", "Available"], rows: [
      [literal("Alpha"), literal("A"), derived("total"), literal(true)],
      [literal("Beta"), literal("B"), derived("doubleTotal"), literal(false)],
    ] },
    { id: "chart", kind: "barChart", labels: ["Alpha", "Beta"], values: [derived("total"), derived("doubleTotal")] },
  ], layout: [
    { id: "inputGroup", type: "group", title: "Inputs", columns: 2, nodeIds: ["people", "unitPrice", "discount", "budget", "category", "available"] },
    { id: "comparisonGroup", type: "comparison", title: "Compare", cards: [
      { id: "totalCard", title: "Total", nodeIds: ["totalView"] }, { id: "chartCard", title: "Breakdown", nodeIds: ["chart"] },
    ] },
    { id: "notesGroup", type: "group", title: "Basis", columns: 1, nodeIds: ["quantityView", "note"] },
    { id: "filtered", type: "filteredTable", title: "Matching choices", tableId: "table", filters: [
      { column: 1, controlId: "category", operator: "equals", inactiveValue: "All" },
      { column: 2, controlId: "budget", operator: "lte" },
      { column: 3, controlId: "available", operator: "equals", inactiveValue: false },
    ] },
  ] };
}
function reject(plan, code, repairable, path) {
  const result = tryCompileUiRichPlan(plan, { revision: 7 });
  assert.equal(result.ok, false); assert.equal(result.error.code, code);
  if (repairable !== undefined) assert.equal(result.error.repairable, repairable);
  if (path) assert.equal(result.error.path, path);
  assert.ok(JSON.stringify(result.error).length < 600); return result.error;
}

test("Plan2 compiles every old node type into a real Surface2 with independent expected calculations", () => {
  const source = fixture(), result = compile(source), evaluated = evaluateRichSurface(result.surface);
  assert.equal(result.planVersion, 2); assert.equal(result.compilerVersion, "2.5.0"); assert.equal(result.surface.version, 2); assert.equal(result.surface.revision, 7);
  assert.deepEqual(result.surface, validateRichSurface(result.surface)); assert.throws(() => validateSurface(result.surface));
  assert.deepEqual(new Set(result.surface.nodes.map(node => node.type)), new Set(["number", "slider", "select", "checkbox", "metric", "text", "table", "barChart"]));
  assert.equal(evaluated.nodes.find(node => node.id === "quantityView").value.value, 8);
  assert.equal(evaluated.nodes.find(node => node.id === "totalView").value.value, 96);
  assert.deepEqual(evaluated.tableViews.filtered.visibleRowIndices, [0, 1]);
  const changed = evaluateRichSurface(result.surface, { ...richInitialState(result.surface), people: 9, unitPrice: 15, discount: 10, budget: 300, category: "A", available: true });
  assert.equal(changed.nodes.find(node => node.id === "totalView").value.value, 243);
  assert.deepEqual(changed.nodes.find(node => node.id === "chart").values.map(cell => cell.value), [243, 486]);
  assert.deepEqual(changed.tableViews.filtered.visibleRowIndices, [0]);
  assert.match(formatRichSnapshot(result.surface, changed.state), /\[filtered\] Beta \| B \| 486 \| false/);
  assert.equal(result.surface.nodes.find(node => node.id === "unitPrice").type, "number");
});

test("the core DAG, input meaning and cost remain unchanged while layout cost is included exactly", () => {
  const source = fixture(), rich = compile(source), old = compileUiPlan(core(source), { revision: 7 });
  assert.deepEqual(rich.surface.nodes, old.surface.nodes); assert.deepEqual(rich.inputSemantics, old.inputSemantics);
  assert.deepEqual(rich.inputSemantics.find(item => item.id === "unitPrice"), { id: "unitPrice", valueType: "number", unit: "元" });
  assert.equal(rich.cost.expressionNodes, old.cost.expressionNodes); assert.equal(rich.cost.expressionDepth, old.cost.expressionDepth);
  assert.equal(rich.cost.surfaceCharacters, JSON.stringify(rich.surface).length); assert.ok(rich.cost.surfaceCharacters > old.cost.surfaceCharacters);
  source.inputs[0].value = 90; source.layout[0].nodeIds.length = 0; source.derived[0].args[1].literal = 999;
  assert.equal(evaluateRichSurface(rich.surface).nodes.find(node => node.id === "totalView").value.value, 96);
  assert.equal(rich.surface.layout[0].nodeIds.length, 6);
});

test("Plan2 literal shorthand compiles identically through the SDK without mutating input or interpreting strings", () => {
  const source = fixture(), canonical = structuredClone(source);
  source.derived[0].args[1] = 2;
  source.views[3].rows[0][0] = '120'; canonical.views[3].rows[0][0] = literal('120');
  source.views[3].rows[0][1] = 'A'; source.views[3].rows[0][3] = true;
  source.views[3].rows[1][0] = 'input:people'; canonical.views[3].rows[1][0] = literal('input:people');
  source.views[3].rows[1][3] = false;
  source.views[0].value = 3; canonical.views[0].value = literal(3);
  source.views[4].values[0] = 7; canonical.views[4].values[0] = literal(7);
  const before = JSON.stringify(source), tool = { name: 'piora_render_ui_plan', parameters: uiRichPlanSchema };
  const parsed = validateToolArguments(tool, { type: 'toolCall', id: 'literal', name: tool.name, arguments: source });
  assert.deepEqual(parsed, source); assert.deepEqual(compile(parsed), compile(canonical));
  assert.equal(JSON.stringify(source), before);
  assert.throws(() => compileUiPlan(core(source), { revision: 7 }), /PLAN_SHAPE/, 'Plan1 stays strict');
  assert.throws(() => validateToolArguments({ ...tool, parameters: uiPlanSchema }, { type: 'toolCall', id: 'old', name: tool.name, arguments: core(source) }));
});

test("original-data admission rejects invalid shorthand before SDK coercion can change its meaning", async () => {
  const tool = { name: 'piora_render_ui_plan', parameters: uiRichPlanSchema };
  const { bindAnswerOutputAdmission } = await jiti.import('../answer-output-admission.ts');
  for (const value of [null, [], {}, { ref: 'people' }, { input: 'people', literal: 1 }, Infinity, 1e13, 'x'.repeat(2001)]) {
    const source = fixture(); source.views[3].rows[0][0] = value;
    assert.throws(() => compile(source));
    const agent = { pioraToolAdmissionVersion: 2 };
    const binding = bindAnswerOutputAdmission({ agent, identity: { sessionId: 'literal', runId: 'invalid' }, loadedTools: [tool], isActive: () => true, onRepeatedDenial() {} });
    try {
      const outcome = await agent.admitToolCall({ toolCall: { id: 'invalid', name: tool.name, arguments: source } });
      assert.equal(outcome.immediate.isError, true);
      assert.equal(binding.snapshot().attempts, 1);
      if (value === null) {
        // This is the SDK behavior the production admission must precede.
        assert.equal(validateToolArguments(tool, { type: 'toolCall', id: 'invalid', name: tool.name, arguments: source }).views[3].rows[0][0], 'null');
        assert.equal(outcome.immediate.result.details.intelligentUiDiagnostic.repairable, true);
        const corrected = await agent.admitToolCall({ toolCall: { id: 'fixed', name: tool.name, arguments: fixture() } });
        assert.equal(corrected.immediate, undefined); assert.equal(binding.snapshot().corrections, 1);
        corrected.settle({ isError: false, result: { content: [] } }, 'execution');
      }
    } finally { binding.cancel(); }
  }
  const source = fixture(); source.derived[0].args[1] = '2';
  reject(source, 'PLAN_TYPE', true); // Numeric-looking text is not converted to a number.
  source.derived[0].args[1] = true; reject(source, 'PLAN_TYPE', true);
});

test('original plan admission retains non-repairable limit and version diagnostics', async () => {
  const { originalUiPlanDiagnostic } = await jiti.import('./plan-admission.ts');
  const version = fixture(); version.planVersion = 3;
  assert.equal(originalUiPlanDiagnostic(version).code, 'PLAN_VERSION');
  assert.equal(originalUiPlanDiagnostic(version).repairable, false);
  const huge = fixture(); huge.title = 'x'.repeat(64001);
  assert.equal(originalUiPlanDiagnostic(huge).code, 'PLAN_LIMIT');
  assert.equal(originalUiPlanDiagnostic(huge).repairable, false);
});

test("forward derived references compile identically and lazy if does not evaluate the unchosen branch", () => {
  const source = fixture(), expected = compile(source); source.derived.reverse(); assert.deepEqual(compile(source), expected);
  const lazy = { planVersion: 2, id: "lazy", title: "Lazy", inputs: [number("x", 0)], derived: [
    { id: "selected", op: "if", args: [derived("zero"), literal(0), derived("inverse")] },
    { id: "inverse", op: "divide", args: [literal(1), input("x")] },
    { id: "zero", op: "equals", args: [input("x"), literal(0)] },
  ], views: [metric("value", derived("selected"))], layout: [{ id: "group", type: "group", title: "Result", columns: 1, nodeIds: ["x", "value"] }] };
  const compiled = compile(lazy);
  assert.equal(evaluateRichSurface(compiled.surface).nodes[1].value.value, 0);
  assert.equal(evaluateRichSurface(compiled.surface, { x: 4 }).nodes[1].value.value, 0.25);
});

for (const [name, change] of [
  ["block vs derived", p => p.layout[0].id = "quantity"],
  ["card vs derived", p => p.layout[1].cards[0].id = "total"],
  ["block vs unused derived", p => { p.derived.push({ id: "unused", op: "add", args: [literal(1)] }); p.layout[0].id = "unused"; }],
]) test(`separate calculation names preserve layout identities: ${name}`, () => {
  const plan = fixture(), nodes = compile(plan).surface.nodes; change(plan);
  const original = structuredClone(plan), result = compile(plan);
  assert.deepEqual(plan, original); assert.deepEqual(result.surface.nodes, nodes);
  assert.deepEqual(result.surface.layout, plan.layout);
  assert.equal(evaluateRichSurface(result.surface, { ...richInitialState(result.surface), people: 6 }).nodes.find(n => n.id === 'totalView').value.value, 144);
});

for (const [name, change, path] of [
  ["card vs input", p => p.layout[1].cards[0].id = "people", "$.layout[1].cards[0].id"],
  ["block vs view", p => p.layout[0].id = "totalView", "$.layout[0].id"],
  ["input vs view", p => p.views[0].id = "people", "$.views[0].id"],
  ["duplicate derived", p => p.derived.push({ ...p.derived[0] }), "$.derived[6].id"],
  ["unsafe derived", p => p.derived[0].id = "__proto__", "$.derived[0].id"],
]) test(`real ID collisions and unsafe identifiers remain rejected: ${name}`, () => { const plan = fixture(); change(plan); reject(plan, "PLAN_ID", true, path); });

test('same names resolve by the declared reference kind, with unchanged state keys and Plan1 behavior', () => {
  const plan = { planVersion: 2, id: 'budget', title: 'Budget', inputs: [number('count', 4)],
    derived: [{ id: 'count', op: 'multiply', args: [input('count'), literal(3)] },
      { id: 'total', op: 'add', args: [derived('count'), literal(5)] }],
    views: [metric('total', derived('total')), metric('raw', input('count')), metric('expanded', derived('count'))],
    layout: [{ id: 'group', type: 'group', title: 'Budget', columns: 1, nodeIds: ['count', 'total', 'raw', 'expanded'] }] };
  const original = structuredClone(plan), compiled = compile(plan);
  const values = state => evaluateRichSurface(compiled.surface, state).nodes.filter(n => n.type === 'metric').map(n => n.value.value);
  assert.deepEqual(values(), [17, 4, 12]); assert.deepEqual(values({ count: 6 }), [23, 6, 18]);
  assert.deepEqual(compiled.inputSemantics, [{ id: 'count', valueType: 'number' }]);
  assert.deepEqual(richInitialState(compiled.surface), { count: 4 }); assert.deepEqual(plan, original);
  assert.throws(() => compileUiPlan(core(plan), { revision: 1 }), /PLAN_ID/);
  const missingInput = structuredClone(plan); missingInput.views[1].value = input('total'); reject(missingInput, 'PLAN_REFERENCE', true);
  const missingDerived = structuredClone(plan); missingDerived.views[1].value = derived('raw'); reject(missingDerived, 'PLAN_REFERENCE', true);
  const cycle = structuredClone(plan); cycle.derived[0].args[0] = derived('count'); reject(cycle, 'PLAN_CYCLE', true);
});

test('desktop reproduction still rejects missing calculations and accepts a fully defined same-name result', () => {
  const captured = JSON.parse(readFileSync(new URL('../../tests/fixtures/intelligent-ui/desktop-outing-plan2-arguments.json', import.meta.url), 'utf8'));
  // Removing the false ID collision must not conceal the second, real error.
  reject(captured.firstAttempt, 'PLAN_REFERENCE', true, '$.views[6].rows[0][2]');
  const plan = structuredClone(captured.correctedAttempt);
  plan.views.find(view => view.id === 'totalMetric').id = 'grandTotal';
  plan.layout[1].cards[0].nodeIds[0] = 'grandTotal';
  const original = structuredClone(plan), surface = compile(plan).surface;
  const initial = evaluateRichSurface(surface), changed = evaluateRichSurface(surface, { people: 6, mealPerPerson: 50 });
  assert.equal(initial.nodes.find(n => n.id === 'grandTotal').value.value, 400);
  assert.equal(changed.nodes.find(n => n.id === 'grandTotal').value.value, 600);
  assert.equal(changed.nodes.find(n => n.id === 'perPersonMetric').value.value, 100);
  assert.deepEqual(plan, original);
  assert.equal(surface.title, '周末出游费用测算（4人）', 'compiler does not guess how to rewrite static business copy');
});

test("layout cannot omit a result, place it twice or expose a derived symbol as a control", () => {
  const missing = fixture(); missing.layout[2].nodeIds.pop(); reject(missing, "PLAN_SHAPE", true);
  const duplicate = fixture(); duplicate.layout[2].nodeIds.push("totalView"); reject(duplicate, "PLAN_SHAPE", true);
  const derivedReference = fixture(); derivedReference.layout[2].nodeIds[0] = "quantity"; reject(derivedReference, "PLAN_REFERENCE", true);
});

test("graph failures and layout type failures share the existing bounded UiPlanError contract", () => {
  const cyclic = fixture(); cyclic.derived[0].args[0] = derived("total"); reject(cyclic, "PLAN_CYCLE", true);
  const missing = fixture(); missing.views[0].value = derived("PRIVATE_IDENTIFIER");
  assert.equal(JSON.stringify(reject(missing, "PLAN_REFERENCE", true)).includes("PRIVATE_IDENTIFIER"), false);
  const wrongType = fixture(); wrongType.layout[3].filters[1].controlId = "category"; reject(wrongType, "PLAN_TYPE", true);
  assert.throws(() => compileUiRichPlan(wrongType, { revision: 7 }), error => error instanceof UiPlanError);
  const badDefault = fixture(); badDefault.derived[2].args[1] = literal(0); reject(badDefault, "PLAN_DEFAULT_EVALUATION", true);
});

test("complete authoring JSON is bounded before layout can be projected away", () => {
  const hugeLayout = fixture(); hugeLayout.layout[0].title = "x".repeat(64_000); reject(hugeLayout, "PLAN_LIMIT", false);
  const deepLayout = fixture(); let nested = {};
  for (let i = 0; i < 12; i++) nested = { nested };
  deepLayout.layout[0].extra = nested; reject(deepLayout, "PLAN_LIMIT", false);
  const cyclic = fixture(); cyclic.layout[0].extra = cyclic; reject(cyclic, "PLAN_SHAPE", true);
  const accessor = fixture(); let reads = 0;
  Object.defineProperty(accessor, "layout", { enumerable: true, get() { reads++; return []; } });
  reject(accessor, "PLAN_SHAPE", true); assert.equal(reads, 0);
  const nonfinite = fixture(); nonfinite.layout[3].filters[0].inactiveValue = Infinity; reject(nonfinite, "PLAN_TYPE", true);
});

test("expanded core plus layout must fit the Surface2 limit even when compact authoring JSON fits", () => {
  const plan = { planVersion: 2, id: "expanded", title: "Expanded", inputs: [number("n", 1)], derived: [], views: [], layout: [] };
  plan.derived.push({ id: "d0", op: "add", args: [input("n"), literal(1)] });
  for (let i = 1; i <= 7; i++) plan.derived.push({ id: `d${i}`, op: "add", args: [derived(`d${i - 1}`), derived(`d${i - 1}`)] });
  plan.views.push(metric("result", derived("d7")));
  for (let index = 0; ; index++) {
    plan.views.push({ id: `detail${index}`, kind: "text", text: "" });
    const available = 63_950 - compileUiPlan(core(plan), { revision: 7 }).cost.surfaceCharacters;
    assert.ok(available >= 0); plan.views.at(-1).text = "x".repeat(Math.min(2_000, available));
    if (available <= 2_000) break;
  }
  plan.layout = [{ id: "all", type: "group", title: "Required detail ".repeat(10), columns: 1, nodeIds: ["n", ...plan.views.map(view => view.id)] }];
  assert.ok(JSON.stringify(plan).length < 64_000);
  assert.equal(compileUiPlan(core(plan), { revision: 7 }).cost.surfaceCharacters, 63_950);
  reject(plan, "PLAN_COMPLEXITY", false);
});

test("shared DAG expansion limits cannot be bypassed by the rich wrapper", () => {
  const plan = fixture(); plan.derived = [{ id: "d0", op: "add", args: [input("people"), literal(1)] }];
  for (let i = 1; i <= 15; i++) plan.derived.push({ id: `d${i}`, op: "add", args: [derived(`d${i - 1}`), derived(`d${i - 1}`)] });
  plan.views = [metric("result", derived("d15"))]; plan.layout = [{ id: "all", type: "group", title: "All", columns: 1, nodeIds: [...plan.inputs.map(item => item.id), "result"] }];
  reject(plan, "PLAN_COMPLEXITY", false);
});

test("snapshot inflation from a valid alternate select value is rejected before a candidate exists", () => {
  const long = "x".repeat(160), plan = { planVersion: 2, id: "inflation", title: "Inflation", inputs: [
    { id: "choice", valueType: "string", label: "Choice", value: "s", options: ["s", long] },
  ], derived: [], views: [{ id: "table", kind: "table", columns: Array(9).fill("Value"), rows: Array.from({ length: 100 }, () => Array.from({ length: 9 }, () => input("choice"))) }],
    layout: [{ id: "all", type: "group", title: "All data", columns: 1, nodeIds: ["choice", "table"] }] };
  assert.ok(JSON.stringify(plan).length < 64_000); compileUiPlan(core(plan), { revision: 7 });
  reject(plan, "PLAN_COMPLEXITY", false);
});

test("schema is one standalone Plan2 object used by the real SDK argument validator", () => {
  const tool = { name: "piora_render_ui_plan", parameters: uiRichPlanSchema }, source = fixture();
  const parsed = validateToolArguments(tool, { type: "toolCall", id: "candidate", name: tool.name, arguments: source });
  assert.deepEqual(parsed, source); assert.equal(compile(parsed).surface.version, 2);
  assert.equal(uiRichPlanSchema.type, "object"); assert.equal(uiRichPlanSchema.anyOf, undefined); assert.equal(uiRichPlanSchema.properties.planVersion.const, 2);
  assert.equal(uiPlanSchema.properties.planVersion.const, 1); assert.equal(uiPlanSchema.properties.layout, undefined);
  assert.equal(JSON.stringify(uiRichPlanSchema).includes('"$ref"'), false); assert.ok(JSON.stringify(uiRichPlanSchema).length < 20_000);
  for (const [name, change] of [["version", p => p.planVersion = 1], ["root property", p => p.revision = 1], ["layout property", p => p.layout[0].hidden = true], ["unsupported inline operation", p => p.views[0].value = { op: "execute", args: [1, 2] }]]) {
    const invalid = fixture(); change(invalid);
    assert.throws(() => validateToolArguments(tool, { type: "toolCall", id: "candidate", name: tool.name, arguments: invalid }), undefined, name);
  }
});

test("SDK schema and host compiler reject fractional columns without truncating their meaning", () => {
  const tool = { name: "piora_render_ui_plan", parameters: uiRichPlanSchema };
  const validate = arguments_ => validateToolArguments(tool, { type: "toolCall", id: "candidate", name: tool.name, arguments: arguments_ });
  for (const column of [0.5, 1.9, -0.5, 11.1]) {
    const source = fixture(); source.layout[3].filters[0].column = column;
    reject(source, "PLAN_REFERENCE", true, "$.layout[3].filters[0].column");
    assert.throws(() => validate(source), undefined, `fractional column ${column}`);
    assert.equal(source.layout[3].filters[0].column, column);
  }
  for (const column of [0, 1, 2, 3, 11]) {
    const source = fixture(); source.layout[3].filters[0].column = column;
    assert.equal(validate(source).layout[3].filters[0].column, column);
  }
});

test("Plan1 and Surface1 guidance remains unchanged when Plan2 guidance is requested", () => {
  const oldPlan = intelligentUiPlanPrompt(), oldSurface = intelligentUiSurfacePrompt(), rich = intelligentUiRichPlanPrompt();
  assert.deepEqual(intelligentUiPlanPrompt(), oldPlan); assert.deepEqual(intelligentUiSurfacePrompt(), oldSurface);
  assert.match(rich.promptSnippet, /piora_render_ui_plan/);
  const text = rich.promptGuidelines.join("\n");
  assert.match(text, /planVersion:2/); assert.doesNotMatch(text, /Submit a complete UiPlanV1/);
  for (const token of ["filteredTable", "inactiveValue", "zero-based", "AND", "exactly once", "not automatically repairable", "exact disk receipt"]) assert.ok(text.includes(token), token);
  assert.match(oldPlan.promptGuidelines.join("\n"), /planVersion:1/);
});

test("unsupported versions, host revisions and extra properties fail without inventing identities", () => {
  const version = fixture(); version.planVersion = 1; reject(version, "PLAN_VERSION", false, "$.planVersion");
  for (const key of ["revision", "operationId", "contextId", "requestId", "epoch"]) { const plan = fixture(); plan[key] = "PRIVATE"; reject(plan, "PLAN_SHAPE", true); }
  assert.throws(() => compileUiRichPlan(fixture(), { revision: 0 }), error => error instanceof UiPlanError && !error.diagnostic.repairable);
  const encoded = fixture(); encoded.layout[0].title = '中文 "quoted" \\ layout';
  const result = compile(encoded); assert.equal(result.cost.surfaceCharacters, JSON.stringify(result.surface).length);
});
