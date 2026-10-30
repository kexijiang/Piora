import { compilePlan2Core, parsePlan2CoreFragment } from "./plan";
import { UI_PLAN_LIMITS, UiPlanError, type CompiledUiPlan, type UiPlanDiagnostic, type UiPlanV1, type UiPlanAtom, type UiPlanView, type UiPlanDerived } from "./plan-types";
import { RichProtocolError, validateRichSurface, type RichBlock, type UiRichSurface, type UiRichNode } from "./rich-protocol";
import { validateUiActions, UiActionError, type UiActionDeclaration } from "./action-contract";
import { plan2JsonDepthLimit, projectPlan2Core, type JsonPath } from "./plan2-expressions";

export const UI_RICH_PLAN_VERSION = 2 as const;
export const UI_RICH_PLAN_COMPILER_VERSION = "2.5.0";
export type UiPlanV2Atom = UiPlanAtom | string | number | boolean | { op: UiPlanDerived["op"]; args: UiPlanV2Atom[] };
type UiPlanV2View = Extract<UiPlanView, { kind: "text" }>
  | { id: string; kind: "dynamicText"; parts: UiPlanV2Atom[] }
  | (Omit<Extract<UiPlanView, { kind: "metric" }>, "value"> & { value: UiPlanV2Atom })
  | (Omit<Extract<UiPlanView, { kind: "table" }>, "rows"> & { rows: UiPlanV2Atom[][] })
  | (Omit<Extract<UiPlanView, { kind: "barChart" }>, "values"> & { values: UiPlanV2Atom[] });
export interface UiPlanV2 extends Omit<UiPlanV1, "planVersion" | "derived" | "views"> {
  planVersion: 2; layout: RichBlock[]; actions?: UiActionDeclaration;
  derived: Array<Omit<UiPlanDerived, "args"> & { args: UiPlanV2Atom[] }>; views: UiPlanV2View[];
}
export interface CompiledUiRichPlan {
  planVersion: 2; compilerVersion: typeof UI_RICH_PLAN_COMPILER_VERSION; surface: UiRichSurface;
  inputSemantics: CompiledUiPlan["inputSemantics"];
  actions?: UiActionDeclaration;
  cost: CompiledUiPlan["cost"];
}
export { UiPlanError } from "./plan-types";

function check(condition: unknown, code: UiPlanDiagnostic["code"], path: string, expected: string, repairable = true): asserts condition {
  if (!condition) throw new UiPlanError(code, path, expected, repairable);
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const forbidden = new Set(["__proto__", "constructor", "prototype"]);

/** Layout counts toward input limits before anything is projected into Plan1. */
function preflight(input: unknown): Set<string> {
  const pending: Array<{ value: unknown; path: JsonPath; leave?: boolean }> = [{ value: input, path: [] }];
  const ancestors = new Set<object>();
  const strings = new Set<string>();
  let values = 0, characters = 0;
  while (pending.length) {
    const { value, path, leave } = pending.pop()!;
    if (leave) { ancestors.delete(value as object); continue; }
    check(++values <= UI_PLAN_LIMITS.jsonValues && path.length <= plan2JsonDepthLimit(path), "PLAN_LIMIT", "$", "Complete plan JSON exceeds the traversal or nesting limit", false);
    if (typeof value === "string") {
      check(value.length <= UI_PLAN_LIMITS.characters, "PLAN_LIMIT", "$", "Plan string exceeds the character limit", false);
      characters += JSON.stringify(value).length;
      strings.add(value);
    } else if (typeof value === "number") {
      check(Number.isFinite(value), "PLAN_TYPE", "$", "All numbers must be finite"); characters += String(value).length;
    } else if (value === null || typeof value === "boolean") characters += String(value).length;
    else {
      check(typeof value === "object", "PLAN_SHAPE", "$", "Only plain JSON data is accepted");
      const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
      check(array ? prototype === Array.prototype : prototype === Object.prototype || prototype === null, "PLAN_SHAPE", "$", "Only plain JSON arrays and objects are accepted");
      check(!ancestors.has(value), "PLAN_SHAPE", "$", "JSON objects must not contain cycles");
      const names = Object.keys(value);
      check(Object.getOwnPropertyNames(value).length === names.length + (array ? 1 : 0) && Object.getOwnPropertySymbols(value).length === 0, "PLAN_SHAPE", "$", "Only enumerable JSON properties are accepted");
      check(names.length <= UI_PLAN_LIMITS.jsonValues && (!array || value.length <= UI_PLAN_LIMITS.jsonValues && names.length === value.length), "PLAN_LIMIT", "$", "JSON collection exceeds the limit or contains holes", false);
      characters += 2 + Math.max(0, names.length - 1);
      ancestors.add(value); pending.push({ value, path, leave: true });
      for (let index = 0; index < names.length; index++) {
        const name = names[index], descriptor = Object.getOwnPropertyDescriptor(value, name);
        check(!forbidden.has(name) && (!array || name === String(index)) && descriptor && "value" in descriptor, "PLAN_SHAPE", "$", "Only ordinary JSON data properties are accepted");
        check(name.length <= UI_PLAN_LIMITS.characters, "PLAN_LIMIT", "$", "Property name exceeds the limit", false);
        if (!array) characters += JSON.stringify(name).length + 1;
        pending.push({ value: descriptor.value, path: [...path, array ? index : name] });
      }
    }
    check(characters <= UI_PLAN_LIMITS.characters, "PLAN_LIMIT", "$", "Complete plan JSON must be at most 64000 characters", false);
  }
  return strings;
}

const richErrorCodes: Record<RichProtocolError["diagnostic"]["code"], UiPlanDiagnostic["code"]> = {
  RICH_SHAPE: "PLAN_SHAPE", RICH_VERSION: "PLAN_VERSION", RICH_LIMIT: "PLAN_COMPLEXITY",
  RICH_ID: "PLAN_ID", RICH_REFERENCE: "PLAN_REFERENCE", RICH_TYPE: "PLAN_TYPE",
  RICH_LAYOUT: "PLAN_SHAPE", RICH_FILTER: "PLAN_TYPE",
};

/** Preview and final compilation use identical normalization and core limits. */
export function parseUiRichPlanFragment(input: Record<string, unknown>): { plan: UiPlanV1; dynamicTextIds: Set<string> } {
  const projected = projectPlan2Core(input, preflight(input));
  try { return { plan: parsePlan2CoreFragment(projected.core), dynamicTextIds: projected.dynamicTextIds }; }
  catch (error) { return projected.rethrow(error); }
}

/** Preview has already normalized and checked the closed Plan2 declarations. */
export function compileUiRichPlanCoreFragment(input: UiPlanV1, dynamicTextIds: ReadonlySet<string>): Omit<UiRichSurface, "version" | "layout"> {
  const { surface } = compilePlan2Core(input, { revision: 1 }, true);
  return { id: surface.id, revision: surface.revision, title: surface.title, nodes: restoreDynamicText(surface.nodes, dynamicTextIds) };
}

function restoreDynamicText(nodes: CompiledUiPlan["surface"]["nodes"], ids: ReadonlySet<string>): UiRichNode[] {
  return nodes.map(node => ids.has(node.id) && node.type === "table" ? { id: node.id, type: "dynamicText", parts: node.rows[0] } : node);
}

/** The existing graph compiler keeps its typing, lazy-if and expansion budgets. */
export function compileUiRichPlan(input: unknown, options: { revision: number }): CompiledUiRichPlan {
  const reserved = preflight(input);
  check(object(input), "PLAN_SHAPE", "$", "Expected a complete Plan2 object");
  check(Object.keys(input).every(key => ["planVersion", "id", "title", "inputs", "derived", "views", "layout", "actions"].includes(key)), "PLAN_SHAPE", "$", "Object contains unsupported properties");
  check(input.planVersion === UI_RICH_PLAN_VERSION, "PLAN_VERSION", "$.planVersion", "Expected plan version 2", false);
  check(Array.isArray(input.layout), "PLAN_SHAPE", "$.layout", "Expected a complete explicit layout");
  const projected = projectPlan2Core(input, reserved);
  let core: CompiledUiPlan;
  try { core = compilePlan2Core(projected.core, options); }
  catch (error) { return projected.rethrow(error); }
  // Derived names only occur in explicitly typed calculation references. They
  // never become Surface node IDs or layout identities and need not reserve them.
  const plan = input as unknown as UiPlanV2;
  const declared = new Set([...plan.inputs, ...plan.views].map(item => item.id));
  input.layout.forEach((block, index) => {
    if (!object(block)) return; // Rich validation reports its precise structural path.
    check(!declared.has(block.id as string), "PLAN_ID", `$.layout[${index}].id`, "Layout and card IDs must differ from every input and view");
    if (block.type === "comparison" && Array.isArray(block.cards)) block.cards.forEach((card, cardIndex) => {
      if (object(card)) check(!declared.has(card.id as string), "PLAN_ID", `$.layout[${index}].cards[${cardIndex}].id`, "Layout and card IDs must differ from every input and view");
    });
  });
  let surface: UiRichSurface;
  try { surface = validateRichSurface({ ...core.surface, version: 2, nodes: restoreDynamicText(core.surface.nodes, projected.dynamicTextIds), layout: input.layout }); }
  catch (error) {
    if (error instanceof RichProtocolError) {
      const { code, path, expected, repairable } = error.diagnostic;
      throw new UiPlanError(richErrorCodes[code], path, expected, repairable);
    }
    throw error;
  }
  let actions: UiActionDeclaration | undefined;
  if (Object.hasOwn(input, "actions")) {
    try { actions = validateUiActions(input.actions); }
    catch (error) {
      if (error instanceof UiActionError) throw new UiPlanError(error.code === "LIMIT" ? "PLAN_LIMIT" : "PLAN_SHAPE", "$.actions", error.message, error.code !== "LIMIT");
      throw error;
    }
  }
  return { planVersion: 2, compilerVersion: UI_RICH_PLAN_COMPILER_VERSION, surface, ...(actions ? { actions } : {}),
    inputSemantics: core.inputSemantics,
    cost: { ...core.cost, surfaceCharacters: JSON.stringify(surface).length } };
}

export function tryCompileUiRichPlan(input: unknown, options: { revision: number }): { ok: true; value: CompiledUiRichPlan } | { ok: false; error: UiPlanDiagnostic } {
  try { return { ok: true, value: compileUiRichPlan(input, options) }; }
  catch (error) { if (error instanceof UiPlanError) return { ok: false, error: error.diagnostic }; throw error; }
}
