import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { validateRichSurface, richInitialState, validateRichState, evaluateRichSurface, formatRichSnapshot, richLegacyProjection, richSnapshotUpperBound, UI_RICH_LIMITS, RichProtocolError } = await jiti.import("./rich-protocol.ts");
const { validateSurface, formatSnapshot: formatLegacySnapshot } = await jiti.import("./protocol.ts");
const clone = value => JSON.parse(JSON.stringify(value));
const multiply = (left, right) => ({ op: "multiply", args: [left, right] });
function fixture() {
  return { version: 2, id: "comparison", revision: 1, title: "Compare choices", nodes: [
    { id: "quantity", type: "number", label: "Quantity", value: 2, min: 0, max: 20 },
    { id: "factor", type: "slider", label: "Factor", value: 1, min: 1, max: 3 },
    { id: "category", type: "select", label: "Category", value: "All", options: ["All", "A", "B"] },
    { id: "available", type: "checkbox", label: "Only available", value: false },
    { id: "budget", type: "number", label: "Budget", value: 20, min: 0, max: 100 },
    { id: "note", type: "text", text: "Prices are supplied examples." },
    { id: "total", type: "metric", label: "Total", value: multiply(multiply({ ref: "quantity" }, { ref: "factor" }), 10) },
    { id: "chart", type: "barChart", labels: ["Alpha", "Beta"], values: [multiply({ ref: "quantity" }, 5), multiply({ ref: "quantity" }, 8)] },
    { id: "data", type: "table", columns: ["Name", "Category", "Price", "Available"], rows: [
      ["Alpha", "A", multiply({ ref: "quantity" }, 5), true],
      ["Beta", "B", multiply({ ref: "quantity" }, 8), false],
      ["Gamma", "A", multiply({ ref: "quantity" }, 12), true],
    ] },
  ], layout: [
    { id: "controls", type: "group", title: "Adjust inputs", columns: 2, nodeIds: ["quantity", "factor", "category", "available", "budget", "note"] },
    { id: "choices", type: "comparison", title: "Results", cards: [
      { id: "totalCard", title: "Combined", nodeIds: ["total"] },
      { id: "chartCard", title: "Individual", nodeIds: ["chart"] },
    ] },
    { id: "filtered", type: "filteredTable", title: "Matching choices", tableId: "data", filters: [
      { column: 1, controlId: "category", operator: "equals", inactiveValue: "All" },
      { column: 2, controlId: "budget", operator: "lte" },
      { column: 3, controlId: "available", operator: "equals", inactiveValue: false },
    ] },
  ] };
}
const rejects = (surface, code) => assert.throws(() => validateRichSurface(surface), error => error instanceof RichProtocolError && (!code || error.diagnostic.code === code));

test("Surface2 preserves all eight strict legacy node types without changing the v1 wire contract", () => {
  const input = fixture(), validated = validateRichSurface(input);
  assert.deepEqual(new Set(validated.nodes.map(node => node.type)), new Set(["number", "slider", "select", "checkbox", "text", "metric", "barChart", "table"]));
  assert.deepEqual(validated, input); assert.notEqual(validated, input); assert.notEqual(validated.nodes[0], input.nodes[0]);
  assert.throws(() => validateSurface(input));
  assert.throws(() => validateSurface({ ...input, version: 1 }));
  assert.equal(richLegacyProjection(validated).version, 1);
  assert.deepEqual(richLegacyProjection(validated).nodes, input.nodes);
});

test("default and changed inputs independently determine calculation and stable filtered row indices", () => {
  const surface = fixture(), original = clone(surface), defaults = richInitialState(surface);
  const first = evaluateRichSurface(surface);
  assert.equal(first.nodes.find(node => node.id === "total").value.value, 20);
  assert.deepEqual(first.nodes.find(node => node.id === "chart").values.map(value => value.value), [10, 16]);
  assert.deepEqual(first.tableViews.filtered, { visibleRowIndices: [0, 1], unknownRowIndices: [], excludedRowIndices: [2], totalRows: 3, activeFilterCount: 1 });
  const state = { ...defaults, factor: 2, budget: 30, category: "A", available: true }, second = evaluateRichSurface(surface, state);
  assert.equal(second.nodes.find(node => node.id === "total").value.value, 40);
  assert.deepEqual(second.tableViews.filtered.visibleRowIndices, [0, 2]); assert.equal(second.tableViews.filtered.activeFilterCount, 3);
  assert.deepEqual(surface, original); assert.deepEqual(state, { ...defaults, factor: 2, budget: 30, category: "A", available: true });
  assert.deepEqual(evaluateRichSurface(surface, state), second, "no wall-clock, random or locale-dependent results");
});

test("snapshots retain grouped controls, comparison content and every filtered-out row", () => {
  const text = formatRichSnapshot(fixture());
  for (const expected of ["Adjust inputs", "Quantity: 2", "Only available: false", "Prices are supplied examples.", "Results", "Combined", "Total: 20", "Individual", "Alpha: 10", "Rows shown: 2/3", "[shown] Alpha | A | 10 | true", "[filtered] Gamma | A | 24 | true"]) assert.ok(text.includes(expected), expected);
  assert.equal(text.match(/Total: 20/g).length, 1);
});

test("contains is deterministic case-sensitive text matching, while gte compares numbers", () => {
  const surface = fixture(), block = surface.layout[2];
  block.filters = [{ column: 0, controlId: "category", operator: "contains", inactiveValue: "All" }];
  assert.deepEqual(evaluateRichSurface(surface, { ...richInitialState(surface), category: "A" }).tableViews.filtered.visibleRowIndices, [0]);
  block.filters = [{ column: 2, controlId: "budget", operator: "gte" }];
  assert.deepEqual(evaluateRichSurface(surface, { ...richInitialState(surface), budget: 15 }).tableViews.filtered.visibleRowIndices, [1, 2]);
});

test("empty results and an empty dataset are explicit and do not truncate source rows", () => {
  const surface = fixture(), state = { ...richInitialState(surface), budget: 0 };
  assert.deepEqual(evaluateRichSurface(surface, state).tableViews.filtered.visibleRowIndices, []);
  assert.match(formatRichSnapshot(surface, state), /Rows shown: 0\/3/);
  assert.match(formatRichSnapshot(surface, state), /\[filtered\] Beta/);
  surface.nodes.at(-1).rows = [];
  assert.deepEqual(evaluateRichSurface(surface).tableViews.filtered.visibleRowIndices, []);
  assert.match(formatRichSnapshot(surface), /Rows shown: 0\/0/);
});

test("calculation failures remain visible as unknown rows, without zero coercion or hiding", () => {
  const surface = fixture(); surface.nodes.at(-1).rows[2][2] = { op: "divide", args: [10, { ref: "quantity" }] };
  const result = evaluateRichSurface(surface, { ...richInitialState(surface), quantity: 0, category: "B", budget: 0 });
  assert.deepEqual(result.tableViews.filtered.visibleRowIndices, [1, 2]);
  assert.deepEqual(result.tableViews.filtered.unknownRowIndices, [2]);
  assert.deepEqual(result.nodes.at(-1).rows[2][2], { error: "CALCULATION_UNAVAILABLE" });
  assert.match(formatRichSnapshot(surface, result.state), /\[unknown\] Gamma.*\[calculation unavailable\]/);
});

test("if evaluation stays lazy, including in filter columns", () => {
  const surface = fixture(); surface.nodes.at(-1).rows[0][2] = { op: "if", args: [
    { op: "equals", args: [{ ref: "quantity" }, 0] }, 0, { op: "divide", args: [10, { ref: "quantity" }] },
  ] };
  const result = evaluateRichSurface(surface, { ...richInitialState(surface), quantity: 0 });
  assert.equal(result.nodes.at(-1).rows[0][2].value, 0); assert.deepEqual(result.tableViews.filtered.unknownRowIndices, []);
});

for (const [name, change, code] of [
  ["missing output placement", s => s.layout[0].nodeIds.pop(), "RICH_LAYOUT"],
  ["duplicated placement", s => s.layout[0].nodeIds.push("total"), "RICH_LAYOUT"],
  ["missing node", s => s.layout[0].nodeIds.push("missing"), "RICH_REFERENCE"],
  ["block/node id collision", s => s.layout[0].id = "quantity", "RICH_ID"],
  ["card/node id collision", s => s.layout[1].cards[0].id = "total", "RICH_ID"],
  ["card/block id collision", s => s.layout[1].cards[0].id = "controls", "RICH_ID"],
  ["unknown root key", s => s.actions = [], "RICH_SHAPE"],
  ["unknown layout key", s => s.layout[0].hidden = true, "RICH_SHAPE"],
  ["unknown card key", s => s.layout[1].cards[0].onClick = "run", "RICH_SHAPE"],
  ["unknown filter key", s => s.layout[2].filters[0].script = "run", "RICH_SHAPE"],
  ["nested layout reference", s => s.layout[0].nodeIds[0] = "choices", "RICH_REFERENCE"],
  ["invalid table reference", s => s.layout[2].tableId = "unknown", "RICH_REFERENCE"],
  ["non-control filter reference", s => s.layout[2].filters[0].controlId = "total", "RICH_REFERENCE"],
  ["out-of-range column", s => s.layout[2].filters[0].column = 8, "RICH_REFERENCE"],
  ["implicit truthiness operator", s => s.layout[2].filters[0].operator = "truthy", "RICH_FILTER"],
  ["object disguised as an operator", s => s.layout[2].filters[0].operator = { toString: "unexpected" }, "RICH_FILTER"],
  ["invalid all-option", s => s.layout[2].filters[0].inactiveValue = "not an option", "RICH_FILTER"],
  ["duplicate predicate", s => s.layout[2].filters.push(clone(s.layout[2].filters[0])), "RICH_FILTER"],
]) test(`strict validation rejects ${name}`, () => { const surface = fixture(); change(surface); rejects(surface, code); });

for (const [name, change] of [
  ["numeric comparison on a string input", s => s.layout[2].filters[0].operator = "gte"],
  ["contains on numeric input", s => s.layout[2].filters[1].operator = "contains"],
  ["mixed table column values", s => s.nodes.at(-1).rows[0][2] = "10"],
  ["condition with alternative output types", s => s.nodes.at(-1).rows[0][2] = { op: "if", args: [{ ref: "available" }, 10, "unknown"] }],
]) test(`filter type checking rejects ${name}`, () => { const surface = fixture(); change(surface); rejects(surface, "RICH_TYPE"); });

test("input state has exact controls and preserves finite numeric bounds and select choices", () => {
  const surface = fixture(), initial = richInitialState(surface);
  for (const state of [{ ...initial, extra: 1 }, { ...initial, quantity: -1 }, { ...initial, quantity: Infinity }, { ...initial, category: "unknown" }, { ...initial, available: 1 }, {}]) {
    assert.throws(() => validateRichState(surface, state), error => error instanceof RichProtocolError && error.diagnostic.path === "$.state");
  }
  assert.deepEqual(validateRichState(surface, initial), initial);
});

test("aggregate table-row and predicate budgets cannot be bypassed with multiple blocks", () => {
  const surface = { version: 2, id: "limits", revision: 1, title: "Limits", nodes: [], layout: [] };
  for (let i = 0; i < 3; i++) {
    surface.nodes.push({ id: `table${i}`, type: "table", columns: ["Value"], rows: Array.from({ length: i === 2 ? 1 : 100 }, () => [1]) });
    surface.layout.push({ id: `group${i}`, type: "group", title: "Data", columns: 1, nodeIds: [`table${i}`] });
  }
  rejects(surface, "RICH_LIMIT");
  surface.nodes = [{ id: "threshold", type: "number", label: "Threshold", value: 1 }];
  surface.layout = [{ id: "input", type: "group", title: "Input", columns: 1, nodeIds: ["threshold"] }];
  for (let i = 0; i < 5; i++) {
    surface.nodes.push({ id: `table${i}`, type: "table", columns: Array.from({ length: 7 }, (_, j) => `C${j}`), rows: [] });
    surface.layout.push({ id: `filtered${i}`, type: "filteredTable", title: "Data", tableId: `table${i}`, filters: Array.from({ length: 7 }, (_, column) => ({ column, controlId: "threshold", operator: "gte" })) });
  }
  rejects(surface, "RICH_LIMIT");
});

test("total card and legacy expression budgets remain bounded", () => {
  const surface = { version: 2, id: "limits", revision: 1, title: "Limits", nodes: [], layout: [] };
  for (let group = 0; group < 3; group++) {
    const cards = [];
    for (let i = 0; i < 6; i++) {
      const id = `text${group}_${i}`; surface.nodes.push({ id, type: "text", text: "value" }); cards.push({ id: `card${group}_${i}`, title: "Choice", nodeIds: [id] });
    }
    surface.layout.push({ id: `group${group}`, type: "comparison", title: "Choices", cards });
  }
  rejects(surface, "RICH_LIMIT");
  const tooDeep = fixture(); let expression = 1;
  for (let i = 0; i < 13; i++) expression = { op: "round", args: [expression] };
  tooDeep.nodes.find(node => node.type === "metric").value = expression; rejects(tooDeep);
  const tooMany = { version: 2, id: "count", revision: 1, title: "Count", nodes: [
    { id: "first", type: "table", columns: Array(12).fill("Column"), rows: Array.from({ length: 100 }, () => Array.from({ length: 12 }, () => ({ op: "add", args: [1, 2] }))) },
    { id: "second", type: "table", columns: Array(12).fill("Column"), rows: Array.from({ length: 100 }, () => Array(12).fill(1)) },
  ], layout: [{ id: "all", type: "group", title: "All", columns: 1, nodeIds: ["first", "second"] }] };
  rejects(tooMany);
});

test("JSON size, cycles, accessors and nonfinite values are rejected before unsafe serialization", () => {
  const huge = fixture(); huge.nodes[5].text = "x".repeat(64_000); rejects(huge, "RICH_LIMIT");
  const cyclic = fixture(); cyclic.extra = cyclic; rejects(cyclic, "RICH_SHAPE");
  const nonfinite = fixture(); nonfinite.nodes[0].value = NaN; rejects(nonfinite, "RICH_SHAPE");
  const accessor = fixture(); let reads = 0; Object.defineProperty(accessor, "unsafe", { enumerable: true, get() { reads++; return 1; } });
  rejects(accessor, "RICH_SHAPE"); assert.equal(reads, 0);
  const sparse = fixture(); delete sparse.nodes[0]; rejects(sparse, "RICH_SHAPE");
  const shared = fixture(), ref = { ref: "quantity" }; shared.nodes.at(-1).rows[0][2] = multiply(ref, ref);
  assert.equal(evaluateRichSurface(shared).nodes.at(-1).rows[0][2].value, 4, "shared JSON-equivalent values are not mistaken for a cycle");
});

test("diagnostics contain structural paths and expectations, never supplied identifiers or content", () => {
  const surface = fixture(), secret = "private-payroll-2026"; surface.layout[0].nodeIds[0] = secret;
  assert.throws(() => validateRichSurface(surface), error => {
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.equal(error.diagnostic.path, "$.layout[0].nodeIds[0]");
    assert.equal(error.diagnostic.repairable, true); return true;
  });
});

test("version and resource-limit errors do not authorize repairs that discard required output", () => {
  const wrongVersion = fixture(); wrongVersion.version = 3;
  const excessiveNodes = fixture(); excessiveNodes.nodes = Array.from({ length: 65 }, (_, index) => ({ id: `n${index}`, type: "text", text: "required" }));
  const excessiveDepth = fixture(); let expression = 1;
  for (let i = 0; i < 13; i++) expression = { op: "round", args: [expression] };
  excessiveDepth.nodes.find(node => node.type === "metric").value = expression;
  const excessiveSize = fixture(); excessiveSize.nodes[5].text = "x".repeat(64_000);
  for (const surface of [wrongVersion, excessiveNodes, excessiveDepth, excessiveSize]) assert.throws(() => validateRichSurface(surface), error => {
    assert.ok(["RICH_LIMIT", "RICH_VERSION"].includes(error.diagnostic.code)); assert.equal(error.diagnostic.repairable, false); return true;
  });
});

test("snapshot budget considers the longest permitted control value before publication", () => {
  const long = "x".repeat(160), surface = { version: 2, id: "inflation", revision: 1, title: "Inflation", nodes: [
    { id: "choice", type: "select", label: "Choice", value: "s", options: ["s", long] },
    { id: "table", type: "table", columns: Array(9).fill("Value"), rows: Array.from({ length: 100 }, () => Array.from({ length: 9 }, () => ({ ref: "choice" }))) },
  ], layout: [{ id: "inputs", type: "group", title: "Inputs", columns: 1, nodeIds: ["choice"] },
    { id: "filtered", type: "filteredTable", title: "Details", tableId: "table", filters: [{ column: 0, controlId: "choice", operator: "equals" }] }] };
  assert.ok(JSON.stringify(surface).length < 64_000);
  assert.ok(formatLegacySnapshot(richLegacyProjection(surface)).length < 128_000, "the short default alone does not prove safety");
  assert.ok(formatLegacySnapshot(richLegacyProjection(surface), { choice: long }).length > 128_000);
  assert.throws(() => validateRichSurface(surface), error => error.diagnostic.code === "RICH_LIMIT" && error.diagnostic.repairable === false);
  surface.nodes[1].rows.length = 70;
  const valid = validateRichSurface(surface), bound = richSnapshotUpperBound(valid);
  assert.equal(UI_RICH_LIMITS.snapshotCharacters, 128_000); assert.ok(bound <= 128_000);
  for (const choice of ["s", long]) assert.ok(formatRichSnapshot(valid, { choice }).length <= bound);
});

test("snapshot upper bound includes branch alternatives, errors, layout titles and row markers", () => {
  const surface = fixture(); surface.nodes.find(node => node.id === "total").value = { op: "if", args: [{ ref: "available" }, "x".repeat(150), { op: "divide", args: [1, { ref: "quantity" }] }] };
  const validated = validateRichSurface(surface), bound = richSnapshotUpperBound(validated);
  for (const quantity of [0, 2, 20]) for (const available of [false, true]) {
    const snapshot = formatRichSnapshot(validated, { ...richInitialState(validated), quantity, available, budget: 0 });
    assert.ok(snapshot.length <= bound); assert.ok(bound <= UI_RICH_LIMITS.snapshotCharacters);
  }
});
