import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { validateToolArguments } from "@earendil-works/pi-ai";

const jiti = createJiti(import.meta.url);
const { compileUiPlan, tryCompileUiPlan, UiPlanError, UI_PLAN_LIMITS } = await jiti.import("./intelligent-ui/plan.ts");
const { uiPlanSchema } = await jiti.import("./intelligent-ui/plan-schema.ts");
const { evaluateExpression, initialState, validateState, validateSurface } = await jiti.import("./intelligent-ui/protocol.ts");
const literal = value => ({ literal: value });
const input = id => ({ input: id });
const derived = id => ({ derived: id });
const metric = (id, value) => ({ id, kind: "metric", label: id, value });
const compile = plan => compileUiPlan(plan, { revision: 7 });
const numeric = (id, value, extra = {}) => ({ id, valueType: "number", label: id, value, ...extra });
const base = () => ({
  planVersion: 1, id: "supplies", title: "活动用品",
  inputs: [numeric("people", 4, { min: 1, step: 1 }), numeric("unitPrice", 12, { unit: "元", min: 0 })],
  derived: [
    { id: "quantity", op: "multiply", args: [input("people"), literal(2)] },
    { id: "total", op: "multiply", args: [derived("quantity"), input("unitPrice")] },
  ],
  views: [metric("quantityView", derived("quantity")), metric("totalView", derived("total"))],
});
function resultValue(result, id, changes = {}) {
  const state = validateState(result.surface, { ...initialState(result.surface), ...changes });
  return evaluateExpression(result.surface.nodes.find(node => node.id === id).value, state);
}
function rejects(plan, code, path) {
  const result = tryCompileUiPlan(plan, { revision: 7 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, code);
  if (path) assert.equal(result.error.path, path);
  assert.ok(JSON.stringify(result.error).length < 600);
  return result.error;
}

test("flat plan computes independently expected results before and after user edits", () => {
  const source = base();
  const compiled = compile(source);
  assert.equal(compiled.planVersion, 1);
  assert.equal(compiled.compilerVersion, "1.0.0");
  assert.equal(compiled.surface.version, 1);
  assert.equal(compiled.surface.revision, 7);
  assert.equal(resultValue(compiled, "quantityView"), 8);
  assert.equal(resultValue(compiled, "totalView"), 96);
  assert.equal(resultValue(compiled, "totalView", { people: 9, unitPrice: 15 }), 270);
  assert.equal(compiled.cost.surfaceCharacters, JSON.stringify(compiled.surface).length);
  assert.deepEqual(compiled.surface, validateSurface(compiled.surface));
  assert.equal(compiled.surface.nodes[0].type, "number");
  assert.equal(compiled.surface.nodes[1].label, "unitPrice (元)");
  assert.deepEqual(compiled.inputSemantics[1], { id: "unitPrice", valueType: "number", unit: "元" });
  source.inputs[0].value = 99;
  source.derived[0].args[1].literal = 100;
  assert.equal(resultValue(compiled, "totalView"), 96, "compiled immutable snapshot does not alias author input");
});

test("all eight legacy component types compile without exposing derived values as controls", () => {
  const plan = base();
  plan.inputs.push(numeric("discount", 0, { min: 0, max: 50, presentation: "slider" }));
  plan.inputs.push({ id: "size", valueType: "string", label: "Size", value: "small", options: ["small", "large"] });
  plan.inputs.push({ id: "delivery", valueType: "boolean", label: "Delivery", value: false });
  plan.views.push(
    { id: "assumption", kind: "text", text: "假设每人需要两份，单价由用户填写。" },
    { id: "table", kind: "table", columns: ["品名", "份数", "费用"], rows: [[literal("餐包"), derived("quantity"), derived("total")]] },
    { id: "chart", kind: "barChart", labels: ["费用", "份数"], values: [derived("total"), derived("quantity")] },
  );
  const result = compile(plan);
  assert.deepEqual(new Set(result.surface.nodes.map(node => node.type)), new Set(["number", "slider", "select", "checkbox", "text", "metric", "table", "barChart"]));
  assert.deepEqual(initialState(result.surface), { people: 4, unitPrice: 12, discount: 0, size: "small", delivery: false });
  assert.equal(result.surface.nodes.some(node => node.id === "total"), false);
  const table = result.surface.nodes.find(node => node.id === "table");
  assert.deepEqual(table.rows[0].map(expr => evaluateExpression(expr, { people: 5, unitPrice: 10 })), ["餐包", 10, 100]);
  const chart = result.surface.nodes.find(node => node.id === "chart");
  assert.deepEqual(chart.values.map(expr => evaluateExpression(expr, { people: 5, unitPrice: 10 })), [100, 10]);
});

test("forward references and reordered declarations produce the same surface", () => {
  const source = base();
  const expected = compile(source);
  source.derived.reverse();
  assert.deepEqual(compile(source), expected);
});

test("select and checkbox inputs choose lazy branches without evaluating unused divisions", () => {
  const plan = {
    planVersion: 1, id: "conditional", title: "Conditional",
    inputs: [numeric("denominator", 0), { id: "enabled", label: "Enabled", valueType: "boolean", value: false }, { id: "size", label: "Size", valueType: "string", value: "small", options: ["small", "large"] }],
    derived: [
      { id: "price", op: "if", args: [derived("large"), literal(20), literal(10)] },
      { id: "large", op: "equals", args: [input("size"), literal("large")] },
      { id: "unsafe", op: "divide", args: [derived("price"), input("denominator")] },
      { id: "safe", op: "if", args: [input("enabled"), derived("unsafe"), literal(0)] },
    ],
    views: [metric("amount", derived("safe"))],
  };
  const result = compile(plan);
  assert.equal(resultValue(result, "amount"), 0);
  assert.equal(resultValue(result, "amount", { enabled: true, denominator: 2 }), 5);
  assert.equal(resultValue(result, "amount", { enabled: true, denominator: 2, size: "large" }), 10);
  assert.throws(() => resultValue(result, "amount", { enabled: true }), /zero/);
  plan.inputs[1].value = true;
  rejects(plan, "PLAN_DEFAULT_EVALUATION", "$.views[0].value");
});

test("types are checked in unselected branches without evaluating those branches", () => {
  const plan = base();
  plan.derived.push({ id: "invalid", op: "add", args: [literal("SECRET_VALUE"), literal(2)] });
  plan.derived.push({ id: "conditional", op: "if", args: [literal(false), derived("invalid"), literal(0)] });
  plan.views = [metric("display", derived("conditional"))];
  const diagnostic = rejects(plan, "PLAN_TYPE", "$.derived[2].args");
  assert.equal(JSON.stringify(diagnostic).includes("SECRET_VALUE"), false);
});

test("undeclared inputs, wrong reference categories and cycles cannot be normalized away", () => {
  let plan = base(); plan.derived[0].args[0] = input("missing"); rejects(plan, "PLAN_REFERENCE", "$.derived[0].args[0]");
  plan = base(); plan.derived[1].args[0] = input("quantity"); rejects(plan, "PLAN_REFERENCE");
  plan = base(); plan.views[0].value = derived("people"); rejects(plan, "PLAN_REFERENCE");
  plan = base(); plan.derived[0].args[0] = derived("total"); rejects(plan, "PLAN_CYCLE");
  plan = base(); plan.derived[0].args[0] = derived("quantity"); rejects(plan, "PLAN_CYCLE");
});

test("one symbol namespace includes inputs, derived results and view identifiers", () => {
  for (const mutate of [
    plan => { plan.inputs[1].id = "people"; },
    plan => { plan.derived[0].id = "people"; },
    plan => { plan.views[0].id = "quantity"; },
    plan => { plan.views[1].id = "quantityView"; },
    plan => { plan.inputs[0].id = "constructor"; },
    plan => { plan.id = "__proto__"; },
  ]) { const plan = base(); mutate(plan); rejects(plan, "PLAN_ID"); }
});

test("numeric controls default to number and never invent slider bounds", () => {
  const plan = base();
  assert.equal(compile(plan).surface.nodes[0].type, "number");
  plan.inputs[0].max = 20;
  assert.equal(compile(plan).surface.nodes[0].type, "number");
  plan.inputs[0].presentation = "slider";
  assert.equal(compile(plan).surface.nodes[0].type, "slider");
  delete plan.inputs[0].min;
  rejects(plan, "PLAN_RANGE");
});

test("invalid control ranges, scalar types and option changes fail precisely", () => {
  for (const mutate of [
    plan => { plan.inputs[0].min = 5; },
    plan => { plan.inputs[0].step = 0; },
    plan => { plan.inputs[0].max = 0; },
    plan => { plan.inputs[0] = { id: "people", label: "People", valueType: "string", value: "one", options: ["two"] }; },
    plan => { plan.inputs[0] = { id: "people", label: "People", valueType: "string", value: "one", options: ["one", "one"] }; },
  ]) { const plan = base(); mutate(plan); rejects(plan, "PLAN_RANGE"); }
  const plan = base(); plan.inputs[0].value = "4"; rejects(plan, "PLAN_TYPE", "$.inputs[0].value");
});

test("operators enforce arity, conditional branch types and chart numeric values", () => {
  for (const [op, args] of [["round", [literal(1), literal(2)]], ["subtract", [literal(1)]], ["divide", [literal(1), literal(2), literal(3)]], ["equals", [literal(1)]], ["if", [literal(true), literal(1)]]]) {
    const plan = base(); plan.derived[0] = { id: "quantity", op, args }; rejects(plan, "PLAN_ARITY");
  }
  let plan = base(); plan.derived[0] = { id: "quantity", op: "if", args: [literal(1), literal(2), literal(3)] }; rejects(plan, "PLAN_TYPE");
  plan = base(); plan.derived[0] = { id: "quantity", op: "if", args: [literal(true), literal(2), literal("3")] }; rejects(plan, "PLAN_TYPE");
  plan = base(); plan.views = [{ id: "chart", kind: "barChart", labels: ["bad"], values: [literal("3")] }]; rejects(plan, "PLAN_TYPE", "$.views[0].values[0]");
});

test("equality is strict scalar equality and arithmetic is not string coercion", () => {
  const plan = base();
  plan.derived = [{ id: "comparison", op: "equals", args: [literal(1), literal("1")] }];
  plan.views = [metric("result", derived("comparison"))];
  assert.equal(resultValue(compile(plan), "result"), false);
  plan.derived[0].op = "add";
  rejects(plan, "PLAN_TYPE");
});

test("known arithmetic operations preserve independent expected results", () => {
  for (const [op, numbers, expected] of [["add", [3, 4, 5], 12], ["subtract", [3, 4], -1], ["multiply", [3, 4, 5], 60], ["divide", [7, 2], 3.5], ["round", [3.6], 4], ["min", [-3, 4, 5], -3], ["max", [-3, 4, 5], 5]]) {
    const plan = base(); plan.derived = [{ id: "calculated", op, args: numbers.map(literal) }]; plan.views = [metric("result", derived("calculated"))];
    assert.equal(resultValue(compile(plan), "result"), expected);
  }
});

test("unknown properties, embedded expressions and arbitrary code remain rejected", () => {
  for (const mutate of [
    plan => { plan.script = "SECRET_CODE"; },
    plan => { plan.inputs[0].onChange = "SECRET_CODE"; },
    plan => { plan.derived[0].op = "eval"; },
    plan => { plan.derived[0].args[0] = { op: "add", args: [1, 2] }; },
    plan => { plan.views[0].value = { formula: "SECRET_CODE" }; },
    plan => { plan.views[0].value = { input: "people", literal: 2 }; },
    plan => { plan.views[0].kind = "iframe"; },
  ]) {
    const plan = base(); mutate(plan);
    const result = tryCompileUiPlan(plan, { revision: 1 });
    assert.equal(result.ok, false); assert.equal(JSON.stringify(result.error).includes("SECRET_CODE"), false);
  }
});

test("malformed JSON values fail before serialization or allocation", () => {
  for (const value of [undefined, NaN, Infinity, 4n, () => 1, new Date(), new Map()]) {
    const plan = base(); plan.inputs[0].value = value; assert.throws(() => compile(plan), UiPlanError);
  }
  const cyclic = base(); cyclic.views[0].value = cyclic; rejects(cyclic, "PLAN_SHAPE");
  const unsafe = base(); Object.defineProperty(unsafe.inputs[0], "value", { enumerable: true, get() { throw new Error("must not run"); } }); rejects(unsafe, "PLAN_SHAPE");
  const hidden = base(); Object.defineProperty(hidden.inputs[0], "unit", { get() { throw new Error("must not run"); } }); rejects(hidden, "PLAN_SHAPE");
  const hostile = JSON.parse(JSON.stringify(base())); hostile.derived[0].args[0] = JSON.parse('{"__proto__":{"polluted":true}}'); rejects(hostile, "PLAN_SHAPE");
  assert.equal({}.polluted, undefined);
});

test("host supplies surface revision; authoring version is independent", () => {
  const plan = base(); plan.planVersion = 2; rejects(plan, "PLAN_VERSION", "$.planVersion");
  for (const revision of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => compileUiPlan(base(), { revision }), error => error.diagnostic.code === "PLAN_SURFACE");
  const unknown = base(); unknown.compilerVersion = "future"; rejects(unknown, "PLAN_SHAPE");
});

function repeatedDag(count) {
  const plan = { planVersion: 1, id: "dag", title: "DAG", inputs: [numeric("n", 1)], derived: [], views: [] };
  for (let i = 0; i < count; i++) plan.derived.push({ id: `d${i}`, op: "add", args: Array.from({ length: 2 }, () => i ? derived(`d${i - 1}`) : input("n")) });
  plan.views = [metric("result", derived(`d${count - 1}`))];
  return plan;
}

test("repeated DAG costs are computed before expansion and obey old serialized output limits", () => {
  const result = compile(repeatedDag(10));
  assert.equal(result.cost.expressionNodes, 2047);
  assert.equal(result.cost.expressionDepth, 10);
  assert.equal(result.cost.surfaceCharacters, JSON.stringify(result.surface).length);
  assert.equal(resultValue(result, "result"), 1024);
  rejects(repeatedDag(11), "PLAN_COMPLEXITY");
  rejects(repeatedDag(200), "PLAN_COMPLEXITY");
});

test("expression budget is global across all view roots", () => {
  const plan = repeatedDag(6);
  plan.views = [{ id: "table", kind: "table", columns: ["total"], rows: Array.from({ length: 33 }, () => [derived("d5")]) }];
  rejects(plan, "PLAN_COMPLEXITY", "$.views");
});

test("depth limit permits 12 operations but rejects 13 before expansion", () => {
  const plan = base(); plan.derived = []; plan.views = [metric("result", derived("d11"))];
  for (let i = 0; i < 12; i++) plan.derived.push({ id: `d${i}`, op: "round", args: [i ? derived(`d${i - 1}`) : literal(3.4)] });
  assert.equal(resultValue(compile(plan), "result"), 3);
  plan.derived.push({ id: "d12", op: "round", args: [derived("d11")] }); plan.views[0].value = derived("d12");
  rejects(plan, "PLAN_COMPLEXITY");
});

test("large text, arrays and final node counts are bounded independently", () => {
  let plan = base(); plan.title = "x".repeat(65_000); rejects(plan, "PLAN_LIMIT");
  plan = base(); plan.views = Array.from({ length: 63 }, (_, i) => ({ id: `v${i}`, kind: "text", text: "x" })); rejects(plan, "PLAN_COMPLEXITY");
  plan = base(); plan.views = Array.from({ length: 64 }, (_, i) => ({ id: `v${i}`, kind: "text", text: "x".repeat(2000) })); rejects(plan, "PLAN_LIMIT");
  plan = base(); plan.derived = Array.from({ length: UI_PLAN_LIMITS.derived + 1 }, (_, i) => ({ id: `d${i}`, op: "round", args: [literal(1)] })); rejects(plan, "PLAN_SHAPE");
});

test("cost follows actual JSON escaping and UTF-16 length instead of byte count", () => {
  const plan = base(); plan.views = [metric("quoted", literal('中文 "quoted"\n\t😀'))];
  const result = compile(plan);
  assert.equal(result.cost.surfaceCharacters, JSON.stringify(result.surface).length);
  assert.notEqual(result.cost.surfaceCharacters, Buffer.byteLength(JSON.stringify(result.surface)));
});

test("default failures are diagnosed, while unit metadata never silently rounds", () => {
  const plan = base(); plan.derived = [{ id: "division", op: "divide", args: [literal(1), literal(3)] }]; plan.views = [{ ...metric("result", derived("division")), unit: "元" }];
  assert.equal(resultValue(compile(plan), "result"), 1 / 3);
  plan.derived[0].args[1] = literal(0); rejects(plan, "PLAN_DEFAULT_EVALUATION");
  plan.derived = [{ id: "division", op: "multiply", args: [literal(1e12), literal(1e12)] }]; rejects(plan, "PLAN_DEFAULT_EVALUATION");
});

test("flat provider schema accepts valid plans and rejects nested formula authoring", () => {
  const tool = { name: "piora_ui_plan", parameters: uiPlanSchema };
  assert.deepEqual(validateToolArguments(tool, { type: "toolCall", id: "call", name: tool.name, arguments: base() }), base());
  const invalid = base(); invalid.views[0].value = { op: "multiply", args: [2, 3] };
  assert.throws(() => validateToolArguments(tool, { type: "toolCall", id: "call", name: tool.name, arguments: invalid }));
  assert.equal(JSON.stringify(uiPlanSchema).includes('"$ref"'), false);
  assert.ok(JSON.stringify(uiPlanSchema).length < 15_000);
});

test("compiled dependency graphs agree with independently calculated scenarios across edits", () => {
  // Generate several shapes; the expected calculation is independent of the AST evaluator.
  for (let offset = 1; offset <= 12; offset++) {
    const plan = {
      planVersion: 1, id: "scenario", title: "Scenario",
      inputs: [numeric("a", offset), numeric("b", 3), { id: "enabled", valueType: "boolean", label: "Enabled", value: true }],
      derived: [
        { id: "sum", op: "add", args: [input("a"), input("b")] },
        { id: "scaled", op: "multiply", args: [derived("sum"), literal(offset)] },
        { id: "adjusted", op: "subtract", args: [derived("scaled"), input("b")] },
        { id: "limited", op: "min", args: [derived("adjusted"), literal(100)] },
        { id: "chosen", op: "if", args: [input("enabled"), derived("limited"), literal(0)] },
      ].reverse(),
      views: [metric("result", derived("chosen"))],
    };
    const compiled = compile(plan);
    for (const a of [-2, 0, 8]) for (const b of [1, 7]) for (const enabled of [true, false]) {
      assert.equal(resultValue(compiled, "result", { a, b, enabled }), enabled ? Math.min((a + b) * offset - b, 100) : 0);
    }
    assert.equal(compiled.cost.surfaceCharacters, JSON.stringify(compiled.surface).length);
  }
});

test("bounded diagnostics do not echo attacker-chosen property names or reference identifiers", () => {
  const plan = base();
  plan.views[0].value = { derived: "PRIVATE_ACCOUNT_IDENTIFIER" };
  assert.equal(JSON.stringify(rejects(plan, "PLAN_REFERENCE")).includes("PRIVATE_ACCOUNT_IDENTIFIER"), false);
  const property = base(); property["PRIVATE_ACCOUNT_IDENTIFIER"] = "PRIVATE_SECRET";
  const diagnostic = JSON.stringify(rejects(property, "PLAN_SHAPE"));
  assert.equal(diagnostic.includes("PRIVATE_ACCOUNT_IDENTIFIER"), false);
  assert.equal(diagnostic.includes("PRIVATE_SECRET"), false);
});
