import { UI_PLAN_LIMITS, UiPlanError, type UiPlanDiagnostic } from "./plan-types";

export type JsonPath = Array<string | number>;

/** Extra JSON depth is allowed only at documented expression positions. Other
 * data, including layout/actions, retains the original flat-plan depth limit. */
export function plan2JsonDepthLimit(path: JsonPath): number {
  let start: number;
  if (path[0] === "derived" && typeof path[1] === "number" && path[2] === "args" && typeof path[3] === "number") start = 4;
  else if (path[0] === "views" && typeof path[1] === "number") {
    if (path[2] === "value") start = 3;
    else if (["values", "parts"].includes(String(path[2])) && typeof path[3] === "number") start = 4;
    else if (path[2] === "rows" && typeof path[3] === "number" && typeof path[4] === "number") start = 5;
    else return UI_PLAN_LIMITS.jsonDepth;
  } else return UI_PLAN_LIMITS.jsonDepth;
  for (let i = start; i < path.length; i += 2) {
    if (path[i] === "args" && (i + 1 === path.length || typeof path[i + 1] === "number")) continue;
    if (i + 1 === path.length && ["op", "literal", "input", "derived"].includes(path[i] as string)) break;
    return UI_PLAN_LIMITS.jsonDepth;
  }
  return UI_PLAN_LIMITS.jsonDepth + 2 * UI_PLAN_LIMITS.expressionDepth;
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const operations = new Set(["add", "subtract", "multiply", "divide", "round", "min", "max", "if", "equals"]);
function check(condition: unknown, code: UiPlanDiagnostic["code"], path: string, expected: string, repairable = true): asserts condition {
  if (!condition) throw new UiPlanError(code, path, expected, repairable);
}

/** Input has already passed the bounded plain-JSON preflight. Inline operations
 * are exact syntax sugar for named operations, never missing-rule inference. */
export function projectPlan2Core(input: Record<string, unknown>, reserved: Set<string>) {
  const generated: Record<string, unknown>[] = [], paths: string[] = [];
  const dynamicTextIds = new Set<string>(), dynamicTextViews = new Set<number>();
  const originalCount = Array.isArray(input.derived) ? input.derived.length : 0;
  let sequence = 0;
  function atom(value: unknown, path: string, depth = 0): unknown {
    if (["string", "number", "boolean"].includes(typeof value)) return { literal: value };
    if (!object(value)) return value;
    if (!(Object.hasOwn(value, "op") || Object.hasOwn(value, "args"))) {
      const keys = Object.keys(value);
      check(keys.length === 1 && ["literal", "input", "derived"].includes(keys[0]), "PLAN_SHAPE", path,
        "Expected one literal or typed input/derived reference, or an inline operation with op and args");
      return value;
    }
    check(Object.keys(value).length === 2 && Object.hasOwn(value, "op") && Object.hasOwn(value, "args"),
      "PLAN_SHAPE", path, "An inline operation contains exactly op and args; use the derived list for named declarations");
    check(typeof value.op === "string" && operations.has(value.op), "PLAN_TYPE", `${path}.op`, "Expected a supported arithmetic, conditional or equality operation");
    check(Array.isArray(value.args) && value.args.length >= 1 && value.args.length <= 32,
      "PLAN_ARITY", `${path}.args`, "Expected 1 to 32 operands");
    check(depth < UI_PLAN_LIMITS.expressionDepth, "PLAN_COMPLEXITY", path, "Inline expressions must fit depth 12", false);
    const args = value.args.map((arg, index) => atom(arg, `${path}.args[${index}]`, depth + 1));
    check(originalCount + generated.length < UI_PLAN_LIMITS.derived, "PLAN_COMPLEXITY", path,
      "Named and inline operations together must fit 256 calculations", false);
    let id: string;
    // Reserve every original string, including unresolved references. An internal
    // name can never accidentally define a missing user-provided reference.
    do { id = `pioraInline${sequence++}`; } while (reserved.has(id));
    reserved.add(id);
    generated.push({ id, op: value.op, args }); paths.push(path);
    return { derived: id };
  }
  const atoms = (value: unknown, path: string) => Array.isArray(value) ? value.map((v, i) => atom(v, `${path}[${i}]`)) : value;
  const derived = Array.isArray(input.derived) ? input.derived.map((item, index) => object(item)
    ? { ...item, args: atoms(item.args, `$.derived[${index}].args`) } : item) : input.derived;
  const views = Array.isArray(input.views) ? input.views.map((item, index) => {
    if (!object(item)) return item;
    const path = `$.views[${index}]`;
    if (item.kind === "dynamicText") {
      check(Object.keys(item).every(key => ["id", "kind", "parts"].includes(key)), "PLAN_SHAPE", path, "Dynamic text has only id, kind and parts");
      check(typeof item.id === "string", "PLAN_ID", `${path}.id`, "A valid view ID");
      check(Array.isArray(item.parts) && item.parts.length >= 1 && item.parts.length <= 12,
        "PLAN_LIMIT", `${path}.parts`, "Dynamic text contains 1 to 12 literal or bound parts");
      dynamicTextIds.add(item.id); dynamicTextViews.add(index);
      // A one-row computation adapter shares all graph, type, expansion and
      // default-evaluation checks. It never becomes a persisted table.
      return { id: item.id, kind: "table", columns: item.parts.map(() => ""), rows: [atoms(item.parts, `${path}.parts`)] };
    }
    if (item.kind === "metric") return { ...item, value: atom(item.value, `${path}.value`) };
    if (item.kind === "barChart") return { ...item, values: atoms(item.values, `${path}.values`) };
    if (item.kind === "table") return { ...item, rows: Array.isArray(item.rows) ? item.rows.map((row, i) => atoms(row, `${path}.rows[${i}]`)) : item.rows };
    return item;
  }) : input.views;
  return {
    dynamicTextIds,
    core: { planVersion: 1, id: input.id, title: input.title, inputs: input.inputs,
      derived: Array.isArray(derived) ? [...derived, ...generated] : derived, views },
    rethrow(error: unknown): never {
      if (error instanceof UiPlanError) {
        const { diagnostic } = error;
        const view = /^\$\.views\[(\d+)\]\.rows\[0\]/.exec(diagnostic.path);
        if (view && dynamicTextViews.has(Number(view[1]))) throw new UiPlanError(diagnostic.code,
          `$.views[${view[1]}].parts${diagnostic.path.slice(view[0].length)}`, diagnostic.expected, diagnostic.repairable);
        const match = /^\$\.derived\[(\d+)\]/.exec(diagnostic.path);
        const origin = match && paths[Number(match[1]) - originalCount];
        if (origin) throw new UiPlanError(diagnostic.code, origin + diagnostic.path.slice(match![0].length), diagnostic.expected, diagnostic.repairable);
      }
      throw error;
    },
  };
}
