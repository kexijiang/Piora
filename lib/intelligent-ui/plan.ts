import { evaluateExpression, initialState, isUiId, validateSurface, type UiExpression, type UiNode } from "./protocol";
import { UI_PLAN_COMPILER_VERSION, UI_PLAN_LIMITS as limits, UI_PLAN_VERSION, UiPlanError, type CompiledUiPlan, type UiPlanAtom, type UiPlanDerived, type UiPlanDiagnostic, type UiPlanInput, type UiPlanOperation, type UiPlanV1, type UiPlanValueType, type UiPlanView } from "./plan-types";
export { UI_PLAN_COMPILER_VERSION, UI_PLAN_LIMITS, UI_PLAN_VERSION, UiPlanError } from "./plan-types";
export type { CompiledUiPlan, UiPlanV1, UiPlanDiagnostic } from "./plan-types";

type RecordValue = Record<string, unknown>;
const operations = new Set(["add", "subtract", "multiply", "divide", "round", "min", "max", "if", "equals"]);
const forbidden = new Set(["__proto__", "constructor", "prototype"]);
function requirePlan(condition: unknown, code: UiPlanDiagnostic["code"], path: string, expected: string, repairable = true): asserts condition {
  if (!condition) throw new UiPlanError(code, path, expected, repairable);
}

/** Bound traversal before JSON serialization, schema parsing or graph allocation. */
function preflight(input: unknown): void {
  let characters = 0, values = 0;
  const ancestors = new Set<object>();
  const add = (length: number) => {
    characters += length;
    requirePlan(characters <= limits.characters, "PLAN_LIMIT", "$", "Plan JSON must be at most 64000 characters", false);
  };
  function scan(value: unknown, depth: number): void {
    requirePlan(++values <= limits.jsonValues && depth <= limits.jsonDepth, "PLAN_LIMIT", "$", "Plan JSON exceeds the traversal or nesting limit", false);
    if (typeof value === "string") {
      requirePlan(value.length <= limits.characters, "PLAN_LIMIT", "$", "Plan string exceeds the character limit", false);
      add(JSON.stringify(value).length); return;
    }
    if (typeof value === "number") {
      requirePlan(Number.isFinite(value), "PLAN_TYPE", "$", "All numbers must be finite"); add(String(value).length); return;
    }
    if (typeof value === "boolean" || value === null) { add(String(value).length); return; }
    requirePlan(value !== null && typeof value === "object", "PLAN_SHAPE", "$", "Only plain JSON data is accepted");
    const prototype = Object.getPrototypeOf(value);
    requirePlan(Array.isArray(value) ? prototype === Array.prototype : prototype === Object.prototype || prototype === null, "PLAN_SHAPE", "$", "Only plain JSON arrays and objects are accepted");
    requirePlan(!ancestors.has(value), "PLAN_SHAPE", "$", "JSON objects must not contain cycles");
    ancestors.add(value);
    const keys = Object.keys(value);
    requirePlan(Object.getOwnPropertyNames(value).length === keys.length + (Array.isArray(value) ? 1 : 0), "PLAN_SHAPE", "$", "Non-enumerable JSON properties are not accepted");
    requirePlan(keys.length <= limits.jsonValues && (Array.isArray(value) ? value.length <= limits.jsonValues && keys.length === value.length : true), "PLAN_LIMIT", "$", "JSON collection exceeds the limit or contains holes", false);
    requirePlan(Object.getOwnPropertySymbols(value).length === 0, "PLAN_SHAPE", "$", "Only JSON properties are accepted");
    add(2 + Math.max(0, keys.length - 1));
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index];
      requirePlan(!forbidden.has(key) && (!Array.isArray(value) || key === String(index)), "PLAN_SHAPE", "$", "Only JSON data properties are accepted");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      requirePlan(descriptor && "value" in descriptor, "PLAN_SHAPE", "$", "Accessor properties are not accepted");
      if (!Array.isArray(value)) {
        requirePlan(key.length <= limits.characters, "PLAN_LIMIT", "$", "Property name exceeds the limit", false);
        add(JSON.stringify(key).length + 1);
      }
      scan(descriptor.value, depth + 1);
    }
    ancestors.delete(value);
  }
  scan(input, 0);
}
function object(value: unknown, path: string): RecordValue {
  requirePlan(value && typeof value === "object" && !Array.isArray(value), "PLAN_SHAPE", path, "Expected an object");
  return value as RecordValue;
}
function keys(value: RecordValue, allowed: string[], path: string): void {
  requirePlan(Object.keys(value).every(key => allowed.includes(key)), "PLAN_SHAPE", path, "Object contains unsupported properties");
}
function string(value: unknown, path: string, max = 160, nonempty = false): string {
  requirePlan(typeof value === "string" && value.length <= max && (!nonempty || value.trim().length > 0), "PLAN_TYPE", path, `Expected ${nonempty ? "nonempty " : ""}text of at most ${max} characters`);
  return value;
}
function numeric(value: unknown, path: string): number {
  requirePlan(typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e12, "PLAN_TYPE", path, "Expected a finite number between -1e12 and 1e12");
  return value;
}
function array(value: unknown, path: string, min: number, max: number): unknown[] {
  requirePlan(Array.isArray(value) && value.length >= min && value.length <= max, "PLAN_SHAPE", path, `Expected an array with ${min} to ${max} items`);
  return value;
}
function id(value: unknown, path: string): string {
  requirePlan(isUiId(value), "PLAN_ID", path, "Expected a safe, stable identifier of at most 64 characters");
  return value;
}
function atom(value: unknown, path: string): UiPlanAtom {
  const item = object(value, path), names = Object.keys(item);
  requirePlan(names.length === 1, "PLAN_SHAPE", path, "Expected exactly one literal, input, or derived field");
  switch (names[0]) {
    case "literal": {
      const literal = item.literal;
      if (typeof literal === "string") return { literal: string(literal, `${path}.literal`, 2000) };
      if (typeof literal === "boolean") return { literal };
      return { literal: numeric(literal, `${path}.literal`) };
    }
    case "input": return { input: id(item.input, `${path}.input`) };
    case "derived": return { derived: id(item.derived, `${path}.derived`) };
    default: throw new UiPlanError("PLAN_SHAPE", path, "Expected a literal, input, or derived reference; nested expressions are unsupported");
  }
}
function labelled(item: RecordValue, path: string): { label: string; unit?: string } {
  const label = string(item.label, `${path}.label`);
  if (item.unit === undefined) return { label };
  const unit = string(item.unit, `${path}.unit`, 40, true);
  requirePlan(`${label} (${unit})`.length <= 160, "PLAN_LIMIT", `${path}.label`, "Combined label and unit must fit 160 characters", false);
  return { label, unit };
}
function input(value: unknown, path: string): UiPlanInput {
  const item = object(value, path), base = { id: id(item.id, `${path}.id`), ...labelled(item, path) };
  switch (item.valueType) {
    case "number": {
      keys(item, ["id", "valueType", "label", "value", "min", "max", "step", "unit", "presentation"], path);
      const result: Extract<UiPlanInput, { valueType: "number" }> = { ...base, valueType: "number", value: numeric(item.value, `${path}.value`) };
      for (const key of ["min", "max", "step"] as const) if (item[key] !== undefined) result[key] = numeric(item[key], `${path}.${key}`);
      requirePlan(result.step === undefined || result.step > 0, "PLAN_RANGE", `${path}.step`, "Step must be positive");
      requirePlan(result.min === undefined || result.max === undefined || result.min <= result.max, "PLAN_RANGE", path, "Minimum must not exceed maximum");
      requirePlan((result.min === undefined || result.value >= result.min) && (result.max === undefined || result.value <= result.max), "PLAN_RANGE", `${path}.value`, "Default value must be within its declared range");
      if (item.presentation !== undefined) {
        requirePlan(item.presentation === "number" || item.presentation === "slider", "PLAN_TYPE", `${path}.presentation`, "Expected number or slider presentation");
        result.presentation = item.presentation;
      }
      requirePlan(result.presentation !== "slider" || result.min !== undefined && result.max !== undefined && result.min < result.max, "PLAN_RANGE", path, "Slider presentation requires an explicit increasing finite range");
      return result;
    }
    case "string": {
      keys(item, ["id", "valueType", "label", "value", "options", "unit"], path);
      const options = array(item.options, `${path}.options`, 1, 40).map((option, i) => string(option, `${path}.options[${i}]`));
      const value = string(item.value, `${path}.value`);
      requirePlan(new Set(options).size === options.length && options.includes(value), "PLAN_RANGE", `${path}.options`, "Options must be unique and contain the default value");
      return { ...base, valueType: "string", value, options };
    }
    case "boolean":
      keys(item, ["id", "valueType", "label", "value", "unit"], path);
      requirePlan(typeof item.value === "boolean", "PLAN_TYPE", `${path}.value`, "Expected a boolean value");
      return { ...base, valueType: "boolean", value: item.value };
    default: throw new UiPlanError("PLAN_TYPE", `${path}.valueType`, "Expected number, string or boolean");
  }
}
function derived(value: unknown, path: string): UiPlanDerived {
  const item = object(value, path);
  keys(item, ["id", "op", "args"], path);
  requirePlan(typeof item.op === "string" && operations.has(item.op), "PLAN_TYPE", `${path}.op`, "Expected a supported arithmetic, conditional or equality operation");
  const args = array(item.args, `${path}.args`, 1, 32).map((value, i) => atom(value, `${path}.args[${i}]`));
  const arity = item.op === "round" ? 1 : item.op === "if" ? 3 : ["subtract", "divide", "equals"].includes(item.op) ? 2 : undefined;
  requirePlan(arity === undefined || args.length === arity, "PLAN_ARITY", `${path}.args`, `Expected ${arity ?? "1 to 32"} operands`);
  return { id: id(item.id, `${path}.id`), op: item.op as UiPlanOperation, args };
}
function view(value: unknown, path: string): UiPlanView {
  const item = object(value, path), viewId = id(item.id, `${path}.id`);
  switch (item.kind) {
    case "text": keys(item, ["id", "kind", "text"], path); return { id: viewId, kind: "text", text: string(item.text, `${path}.text`, 2000) };
    case "metric": keys(item, ["id", "kind", "label", "value", "unit"], path); return { id: viewId, kind: "metric", ...labelled(item, path), value: atom(item.value, `${path}.value`) };
    case "table": {
      keys(item, ["id", "kind", "columns", "rows"], path);
      const columns = array(item.columns, `${path}.columns`, 1, 12).map((column, i) => string(column, `${path}.columns[${i}]`));
      const rows = array(item.rows, `${path}.rows`, 0, 100).map((row, i) => array(row, `${path}.rows[${i}]`, columns.length, columns.length).map((value, j) => atom(value, `${path}.rows[${i}][${j}]`)));
      return { id: viewId, kind: "table", columns, rows };
    }
    case "barChart": {
      keys(item, ["id", "kind", "labels", "values"], path);
      const labels = array(item.labels, `${path}.labels`, 0, 40).map((label, i) => string(label, `${path}.labels[${i}]`));
      const values = array(item.values, `${path}.values`, labels.length, labels.length).map((value, i) => atom(value, `${path}.values[${i}]`));
      return { id: viewId, kind: "barChart", labels, values };
    }
    default: throw new UiPlanError("PLAN_TYPE", `${path}.kind`, "Expected text, metric, table or barChart");
  }
}
function parse(inputValue: unknown, fragment = false, separateDerivedIds = false): UiPlanV1 {
  preflight(inputValue);
  const value = object(inputValue, "$");
  keys(value, ["planVersion", "id", "title", "inputs", "derived", "views"], "$");
  requirePlan(value.planVersion === UI_PLAN_VERSION, "PLAN_VERSION", "$.planVersion", "Expected plan version 1", false);
  const plan: UiPlanV1 = {
    planVersion: 1, id: id(value.id, "$.id"), title: string(value.title, "$.title", 160, true),
    inputs: array(value.inputs, "$.inputs", 0, limits.inputs).map((value, i) => input(value, `$.inputs[${i}]`)),
    derived: array(value.derived, "$.derived", 0, limits.derived).map((value, i) => derived(value, `$.derived[${i}]`)),
    views: array(value.views, "$.views", fragment ? 0 : 1, limits.views).map((value, i) => view(value, `$.views[${i}]`)),
  };
  requirePlan(plan.inputs.length + plan.views.length <= limits.surfaceNodes, "PLAN_COMPLEXITY", "$", "Inputs and views together must fit 64 surface nodes", false);
  const ids = new Set<string>();
  const derivedIds = separateDerivedIds ? new Set<string>() : ids;
  for (const collection of ["inputs", "derived", "views"] as const) plan[collection].forEach((item, i) => {
    const namespace = collection === "derived" ? derivedIds : ids;
    requirePlan(!namespace.has(item.id), "PLAN_ID", `$.${collection}[${i}].id`, separateDerivedIds
      ? collection === "derived" ? "Derived result identifiers must be unique" : "Inputs and views must have distinct identifiers"
      : "Inputs, derived results and views must have distinct identifiers");
    namespace.add(item.id);
  });
  return plan;
}

interface ExpressionInfo { type: UiPlanValueType; nodes: number; depth: number; characters: number }
function checkCost(info: ExpressionInfo, path: string): ExpressionInfo {
  requirePlan(info.nodes <= limits.expressionNodes && info.depth <= limits.expressionDepth && info.characters <= limits.surfaceCharacters, "PLAN_COMPLEXITY", path, "Expanded expressions must fit 4096 nodes, depth 12 and 64000 JSON characters", false);
  return info;
}
const displayLabel = (item: { label: string; unit?: string }) => item.unit === undefined ? item.label : `${item.label} (${item.unit})`;

/** Compile a complete candidate. This function neither publishes nor persists a surface. */
function compile(inputValue: unknown, options: { revision: number }, fragment = false, separateDerivedIds = false): CompiledUiPlan {
  requirePlan(Number.isSafeInteger(options?.revision) && options.revision > 0, "PLAN_SURFACE", "$revision", "The host must supply a positive safe revision", false);
  const plan = parse(inputValue, fragment, separateDerivedIds);
  const inputs = new Map(plan.inputs.map(item => [item.id, item]));
  const definitions = new Map(plan.derived.map((item, i) => [item.id, { item, path: `$.derived[${i}]` }]));
  const resolved = new Map<string, ExpressionInfo>(), resolving = new Set<string>();
  function atomInfo(value: UiPlanAtom, path: string): ExpressionInfo {
    if ("literal" in value) return { type: typeof value.literal as UiPlanValueType, nodes: 1, depth: 0, characters: JSON.stringify(value.literal).length };
    if ("input" in value) {
      const source = inputs.get(value.input);
      requirePlan(source, "PLAN_REFERENCE", path, "Input reference must resolve to a declared input");
      return { type: source.valueType, nodes: 1, depth: 0, characters: JSON.stringify({ ref: value.input }).length };
    }
    requirePlan(definitions.has(value.derived), "PLAN_REFERENCE", path, "Derived reference must resolve to a declared derived result");
    return resolve(value.derived);
  }
  function resolve(name: string): ExpressionInfo {
    const cached = resolved.get(name);
    if (cached) return cached;
    const { item, path } = definitions.get(name)!;
    requirePlan(!resolving.has(name), "PLAN_CYCLE", path, "Derived references must form an acyclic graph");
    resolving.add(name);
    const args = item.args.map((value, i) => atomInfo(value, `${path}.args[${i}]`));
    let type: UiPlanValueType = "number";
    if (item.op === "if") {
      requirePlan(args[0].type === "boolean", "PLAN_TYPE", `${path}.args[0]`, "Conditional expression requires a boolean condition");
      requirePlan(args[1].type === args[2].type, "PLAN_TYPE", `${path}.args`, "Conditional branches must return the same scalar type");
      type = args[1].type;
    } else if (item.op === "equals") type = "boolean";
    else requirePlan(args.every(arg => arg.type === "number"), "PLAN_TYPE", `${path}.args`, "Arithmetic operands must have numeric types");
    const info = checkCost({ type, nodes: 1 + args.reduce((sum, arg) => sum + arg.nodes, 0), depth: 1 + Math.max(...args.map(arg => arg.depth)), characters: JSON.stringify({ op: item.op, args: [] }).length + args.reduce((sum, arg) => sum + arg.characters, 0) + args.length - 1 }, path);
    resolving.delete(name); resolved.set(name, info); return info;
  }
  // Validate every declaration, including unused ones; do not numerically evaluate branches here.
  for (const name of definitions.keys()) resolve(name);
  const roots: Array<{ value: UiPlanAtom; path: string; info: ExpressionInfo }> = [];
  function root(value: UiPlanAtom, path: string, numeric = false): null {
    const info = atomInfo(value, path);
    requirePlan(!numeric || info.type === "number", "PLAN_TYPE", path, "Bar chart values must be numeric");
    roots.push({ value, path, info }); return null;
  }
  const inputNodes: UiNode[] = plan.inputs.map(item => {
    const base = { id: item.id, label: displayLabel(item) };
    if (item.valueType === "boolean") return { ...base, type: "checkbox", value: item.value };
    if (item.valueType === "string") return { ...base, type: "select", value: item.value, options: [...item.options] };
    const node: Extract<UiNode, { type: "number" | "slider" }> = { ...base, type: item.presentation ?? "number", value: item.value };
    for (const key of ["min", "max", "step"] as const) if (item[key] !== undefined) node[key] = item[key];
    return node;
  });
  const viewSkeletons = plan.views.map((item, i) => {
    const path = `$.views[${i}]`;
    switch (item.kind) {
      case "text": return { id: item.id, type: "text", text: item.text };
      case "metric": return { id: item.id, type: "metric", label: displayLabel(item), value: root(item.value, `${path}.value`) };
      case "table": return { id: item.id, type: "table", columns: item.columns, rows: item.rows.map((row, r) => row.map((value, c) => root(value, `${path}.rows[${r}][${c}]`))) };
      case "barChart": return { id: item.id, type: "barChart", labels: item.labels, values: item.values.map((value, v) => root(value, `${path}.values[${v}]`, true)) };
    }
  });
  const skeleton = { version: 1 as const, id: plan.id, revision: options.revision, title: plan.title, nodes: [...inputNodes, ...viewSkeletons] };
  const expressionNodes = roots.reduce((sum, root) => sum + root.info.nodes, 0);
  const expressionDepth = roots.reduce((max, root) => Math.max(max, root.info.depth), 0);
  // Exact UTF-16 JSON length, matching validateSurface (despite its historical BYTES name).
  const surfaceCharacters = JSON.stringify(skeleton).length + roots.reduce((sum, root) => sum + root.info.characters - 4, 0);
  requirePlan(expressionNodes <= limits.expressionNodes && surfaceCharacters <= limits.surfaceCharacters, "PLAN_COMPLEXITY", "$.views", "Combined expanded output must fit 4096 expression nodes and 64000 JSON characters", false);
  function expand(value: UiPlanAtom): UiExpression {
    if ("literal" in value) return value.literal;
    if ("input" in value) return { ref: value.input };
    const item = definitions.get(value.derived)!.item;
    return { op: item.op, args: item.args.map(expand) };
  }
  let nextRoot = 0;
  const nodes: UiNode[] = [...inputNodes, ...plan.views.map((item): UiNode => {
    switch (item.kind) {
      case "text": return { id: item.id, type: "text", text: item.text };
      case "metric": return { id: item.id, type: "metric", label: displayLabel(item), value: expand(roots[nextRoot++].value) };
      case "table": return { id: item.id, type: "table", columns: [...item.columns], rows: item.rows.map(row => row.map(() => expand(roots[nextRoot++].value))) };
      case "barChart": return { id: item.id, type: "barChart", labels: [...item.labels], values: item.values.map(() => expand(roots[nextRoot++].value)) };
    }
  })];
  let surface;
  try { surface = validateSurface({ ...skeleton, nodes }); }
  catch { throw new UiPlanError("PLAN_SURFACE", "$", "Compiled candidate must satisfy the persisted surface protocol", false); }
  const state = initialState(surface);
  // Only displayed roots are evaluated. Dead branches remain lazy, including divide by zero.
  for (const entry of roots) {
    try { evaluateExpression(expand(entry.value), state); }
    catch { throw new UiPlanError("PLAN_DEFAULT_EVALUATION", entry.path, "Displayed results must evaluate with the default inputs; check zero divisors and numeric range"); }
  }
  return {
    planVersion: 1, compilerVersion: UI_PLAN_COMPILER_VERSION, surface,
    inputSemantics: plan.inputs.map(item => ({ id: item.id, valueType: item.valueType, ...(item.unit === undefined ? {} : { unit: item.unit }), ...(item.valueType === "string" ? { options: [...item.options] } : {}) })),
    cost: { expressionNodes, expressionDepth, surfaceCharacters },
  };
}

export function compileUiPlan(inputValue: unknown, options: { revision: number }): CompiledUiPlan {
  return compile(inputValue, options);
}

/** Preview-only declarations: absent future views are allowed, all supplied data is strict. */
export function parseUiPlanFragment(inputValue: unknown): UiPlanV1 { return parse(inputValue, true); }
/** Never used by tool admission/publication. The result still needs layout validation. */
export function compileUiPlanFragment(inputValue: unknown): CompiledUiPlan { return compile(inputValue, { revision: 1 }, true); }

/** Internal normalized Plan2 core. Typed input/derived references use separate maps.
 * Plan1 public entry points retain their original shared-ID contract. */
export function parsePlan2CoreFragment(inputValue: unknown): UiPlanV1 { return parse(inputValue, true, true); }
export function compilePlan2Core(inputValue: unknown, options: { revision: number }, fragment = false): CompiledUiPlan {
  return compile(inputValue, options, fragment, true);
}

export function tryCompileUiPlan(inputValue: unknown, options: { revision: number }): { ok: true; value: CompiledUiPlan } | { ok: false; error: UiPlanDiagnostic } {
  try { return { ok: true, value: compileUiPlan(inputValue, options) }; }
  catch (error) { if (error instanceof UiPlanError) return { ok: false, error: error.diagnostic }; throw error; }
}
