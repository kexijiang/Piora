/** Versioned, data-only UI protocol. No code, URLs, HTML or arbitrary actions. */
export type UiValue = string | number | boolean;
export type UiState = Record<string, UiValue>;
export type UiExpression = UiValue | { ref: string } | { op: "add" | "subtract" | "multiply" | "divide" | "round" | "min" | "max" | "if" | "equals"; args: UiExpression[] };
export type UiNode =
  | { id: string; type: "text"; text: string }
  | { id: string; type: "number" | "slider"; label: string; value: number; min?: number; max?: number; step?: number }
  | { id: string; type: "select"; label: string; value: string; options: string[] }
  | { id: string; type: "checkbox"; label: string; value: boolean }
  | { id: string; type: "metric"; label: string; value: UiExpression }
  | { id: string; type: "table"; columns: string[]; rows: UiExpression[][] }
  | { id: string; type: "barChart"; labels: string[]; values: UiExpression[] };
export interface UiSurface { version: 1; id: string; revision: number; title: string; nodes: UiNode[] }
export const MAX_SURFACE_BYTES = 64_000;
const forbidden = new Set(["__proto__", "constructor", "prototype"]);
const ops = new Set(["add", "subtract", "multiply", "divide", "round", "min", "max", "if", "equals"]);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, limit = 2000): v is string => typeof v === "string" && v.length <= limit;
const number = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e12;
export const isUiId = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(v) && !forbidden.has(v);
const control = (node: UiNode): node is Extract<UiNode, { type: "number" | "slider" | "select" | "checkbox" }> => ["number", "slider", "select", "checkbox"].includes(node.type);
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function keys(value: Record<string, unknown>, allowed: string[]) {
  check(Object.keys(value).every(key => allowed.includes(key) && !forbidden.has(key)), "Unknown UI property");
}
function expression(value: unknown, refs: Set<string>, budget: { count: number }, depth = 0): asserts value is UiExpression {
  check(++budget.count <= 4096 && depth <= 12, "UI expression budget exceeded");
  if (text(value) || number(value) || typeof value === "boolean") return;
  check(object(value), "Invalid UI expression");
  if ("ref" in value) { keys(value, ["ref"]); check(typeof value.ref === "string" && refs.has(value.ref), "Unknown UI control reference"); return; }
  keys(value, ["op", "args"]);
  check(typeof value.op === "string" && ops.has(value.op), "Unsupported UI operation");
  check(Array.isArray(value.args) && value.args.length > 0 && value.args.length <= 32, "Invalid UI operation arguments");
  check(value.op !== "round" || value.args.length === 1, "round requires one argument");
  check(!["divide", "subtract", "equals"].includes(value.op) || value.args.length === 2, "Binary operation requires two arguments");
  check(value.op !== "if" || value.args.length === 3, "if requires condition, true value, false value");
  value.args.forEach(arg => expression(arg, refs, budget, depth + 1));
}

export function validateSurface(input: unknown): UiSurface {
  check(object(input), "UI surface must be an object");
  check(JSON.stringify(input).length <= MAX_SURFACE_BYTES, "UI surface too large");
  keys(input, ["version", "id", "revision", "title", "nodes"]);
  check(input.version === 1 && isUiId(input.id), "Unsupported UI version or surface id");
  check(Number.isSafeInteger(input.revision) && Number(input.revision) > 0, "Invalid UI revision");
  check(text(input.title, 160) && input.title.trim(), "UI title is required");
  check(Array.isArray(input.nodes) && input.nodes.length > 0 && input.nodes.length <= 64, "UI requires 1 to 64 nodes");
  const ids = new Set<string>(), refs = new Set<string>(), budget = { count: 0 };
  for (const node of input.nodes) {
    check(object(node) && isUiId(node.id) && !ids.has(node.id), "Duplicate or invalid UI node id");
    ids.add(node.id);
    if (["number", "slider", "select", "checkbox"].includes(String(node.type))) refs.add(node.id);
  }
  for (const node of input.nodes as Record<string, unknown>[]) {
    switch (node.type) {
      case "text": keys(node, ["id", "type", "text"]); check(text(node.text), "Invalid UI text"); break;
      case "number": case "slider":
        keys(node, ["id", "type", "label", "value", "min", "max", "step"]);
        check(text(node.label, 160) && number(node.value), "Invalid numeric control");
        for (const key of ["min", "max", "step"]) check(node[key] === undefined || number(node[key]), "Invalid control range");
        check(node.step === undefined || Number(node.step) > 0, "Control step must be positive");
        check(node.min === undefined || node.max === undefined || Number(node.min) <= Number(node.max), "Invalid control bounds");
        check(node.min === undefined || node.value >= Number(node.min), "Control value below minimum");
        check(node.max === undefined || node.value <= Number(node.max), "Control value above maximum");
        check(node.type !== "slider" || number(node.min) && number(node.max) && node.min < node.max, "Slider requires finite min and max");
        break;
      case "select":
        keys(node, ["id", "type", "label", "value", "options"]);
        check(text(node.label, 160) && text(node.value, 160) && Array.isArray(node.options) && node.options.length > 0 && node.options.length <= 40 && node.options.every(v => text(v, 160)) && new Set(node.options).size === node.options.length && node.options.includes(node.value), "Invalid select control"); break;
      case "checkbox": keys(node, ["id", "type", "label", "value"]); check(text(node.label, 160) && typeof node.value === "boolean", "Invalid checkbox"); break;
      case "metric": keys(node, ["id", "type", "label", "value"]); check(text(node.label, 160), "Invalid metric label"); expression(node.value, refs, budget); break;
      case "table":
        keys(node, ["id", "type", "columns", "rows"]);
        check(Array.isArray(node.columns) && node.columns.length > 0 && node.columns.length <= 12 && node.columns.every(v => text(v, 160)), "Invalid table columns");
        check(Array.isArray(node.rows) && node.rows.length <= 100, "Too many table rows");
        for (const row of node.rows) { check(Array.isArray(row) && row.length === node.columns.length, "Invalid table row"); row.forEach(v => expression(v, refs, budget)); } break;
      case "barChart":
        keys(node, ["id", "type", "labels", "values"]);
        check(Array.isArray(node.labels) && node.labels.length <= 40 && node.labels.every(v => text(v, 160)), "Invalid chart labels");
        check(Array.isArray(node.values) && node.values.length === node.labels.length, "Invalid chart values"); node.values.forEach(v => expression(v, refs, budget)); break;
      default: throw new Error("Unsupported UI node type");
    }
  }
  // Copy data into ordinary JSON structures; callers cannot mutate the source object.
  return JSON.parse(JSON.stringify(input)) as UiSurface;
}

export function initialState(surface: UiSurface): UiState {
  return Object.fromEntries(surface.nodes.filter(control).map(node => [node.id, node.value]));
}
export function validateState(surface: UiSurface, input: unknown): UiState {
  check(object(input), "UI state must be an object");
  const nodes = surface.nodes.filter(control), ids = nodes.map(node => node.id);
  keys(input, ids);
  const state: UiState = {};
  for (const node of nodes) {
    const value = input[node.id];
    if (node.type === "number" || node.type === "slider") check(number(value) && (node.min === undefined || value >= node.min) && (node.max === undefined || value <= node.max), `Invalid numeric value: ${node.id}`);
    else if (node.type === "checkbox") check(typeof value === "boolean", `Invalid checkbox value: ${node.id}`);
    else if (node.type === "select") check(typeof value === "string" && node.options.includes(value), `Invalid selected value: ${node.id}`);
    state[node.id] = value as UiValue;
  }
  return state;
}
/** Keep compatible user values when a later surface revision adds/removes fields. */
export function mergeState(surface: UiSurface, previous: UiState): UiState {
  const state = initialState(surface);
  for (const node of surface.nodes.filter(control)) {
    if (!Object.hasOwn(previous, node.id)) continue;
    try { Object.assign(state, validateState(surface, { ...state, [node.id]: previous[node.id] })); } catch { /* Changed type/range uses the new default. */ }
  }
  return state;
}
export function evaluateExpression(expr: UiExpression, state: UiState, depth = 0): UiValue {
  if (depth > 12) throw new Error("UI expression depth exceeded");
  if (typeof expr !== "object") return expr;
  if ("ref" in expr) { if (!Object.hasOwn(state, expr.ref)) throw new Error("Missing UI value"); return state[expr.ref]; }
  if (expr.op === "if") {
    const condition = evaluateExpression(expr.args[0], state, depth + 1);
    if (typeof condition !== "boolean") throw new Error("Condition needs a boolean value");
    return evaluateExpression(expr.args[condition ? 1 : 2], state, depth + 1);
  }
  const values = expr.args.map(arg => evaluateExpression(arg, state, depth + 1));
  if (expr.op === "equals") return values[0] === values[1];
  if (!values.every(value => typeof value === "number" && Number.isFinite(value))) throw new Error("Calculation needs numeric values");
  const nums = values as number[];
  let result: number;
  switch (expr.op) {
    case "add": result = nums.reduce((a, b) => a + b, 0); break;
    case "subtract": result = nums[0] - nums[1]; break;
    case "multiply": result = nums.reduce((a, b) => a * b, 1); break;
    case "divide": if (nums[1] === 0) throw new Error("Cannot divide by zero"); result = nums[0] / nums[1]; break;
    case "round": result = Math.round(nums[0]); break;
    case "min": result = Math.min(...nums); break;
    case "max": result = Math.max(...nums); break;
    default: throw new Error("Unsupported operation");
  }
  if (!Number.isFinite(result) || Math.abs(result) > 1e15) throw new Error("Calculation result out of range");
  return result;
}
export function formatSnapshot(surface: UiSurface, state = initialState(surface)): string {
  const value = (expr: UiExpression) => { try { return String(evaluateExpression(expr, state)); } catch { return "[calculation unavailable]"; } };
  return [surface.title, ...surface.nodes.map(node => {
    if (control(node)) return `${node.label}: ${state[node.id]}`;
    switch (node.type) {
      case "text": return node.text;
      case "metric": return `${node.label}: ${value(node.value)}`;
      case "table": return [node.columns.join(" | "), ...node.rows.map(row => row.map(value).join(" | "))].join("\n");
      case "barChart": return node.labels.map((label, i) => `${label}: ${value(node.values[i])}`).join("\n");
    }
  })].join("\n");
}
export function extractSurface(details: unknown): UiSurface | null {
  if (!object(details) || !object(details.answerOutput) || details.answerOutput.kind !== "intelligent-ui" || details.answerOutput.version !== 1) return null;
  try { return validateSurface(details.answerOutput.payload); } catch { return null; }
}
