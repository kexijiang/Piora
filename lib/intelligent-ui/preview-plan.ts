import { Check } from "typebox/value";
import { compileUiRichPlan, compileUiRichPlanCoreFragment, parseUiRichPlanFragment } from "./rich-plan";
import { uiRichPlanSchema } from "./rich-plan-schema";
import { formatRichSnapshot, validateRichSurface, type RichBlock, type UiRichSurface } from "./rich-protocol";
import type { UiPlanAtom, UiPlanView } from "./plan-types";
import type { UiPlanPrefix } from "./preview-parser";

type Result = { status: "waiting" } | { status: "invalid"; diagnostic?: string }
  | { status: "ready"; surface: UiRichSurface; snapshot: string; complete: boolean };
const placedNodes = (block: RichBlock): string[] => block.type === "group" ? block.nodeIds
  : block.type === "comparison" ? block.cards.flatMap(card => card.nodeIds) : [block.tableId];
const atoms = (view: UiPlanView): UiPlanAtom[] => view.kind === "metric" ? [view.value]
  : view.kind === "table" ? view.rows.flat() : view.kind === "barChart" ? view.values : [];
const assert = (condition: unknown): void => { if (!condition) throw new Error("Invalid closed plan declaration or reference"); };

/** Only dependency-complete, formally validated blocks may become a preview. */
export function compileUiPreview(prefix: UiPlanPrefix): Result {
  if (prefix.status === "invalid") return { status: "invalid", diagnostic: prefix.diagnostic };
  try {
    const value = prefix.values, closed = new Set(prefix.completeKeys);
    const properties = uiRichPlanSchema.properties;
    for (const key of Object.keys(value)) {
      assert(Object.hasOwn(properties, key));
      const schema = properties[key as keyof typeof properties];
      if (closed.has(key)) assert(Check(schema, value[key]));
      else {
        assert(schema.type === "array" && Array.isArray(value[key]));
        const arraySchema = schema as typeof properties.inputs & { maxItems: number };
        assert((value[key] as unknown[]).length <= arraySchema.maxItems);
        for (const member of value[key] as unknown[]) assert(Check(arraySchema.items, member));
      }
    }
    if (prefix.status === "complete") {
      const { surface } = compileUiRichPlan(value, { revision: 1 });
      return { status: "ready", surface, snapshot: formatRichSnapshot(surface), complete: true };
    }
    if (!["planVersion", "id", "title"].every(key => closed.has(key))) return { status: "waiting" };
    const { plan, dynamicTextIds } = parseUiRichPlanFragment({ planVersion: 2, id: value.id, title: value.title,
      inputs: value.inputs ?? [], derived: value.derived ?? [], views: value.views ?? [] });
    const layout = (value.layout ?? []) as RichBlock[];
    const inputs = new Map(plan.inputs.map(item => [item.id, item]));
    const derived = new Map(plan.derived.map(item => [item.id, item]));
    const views = new Map(plan.views.map(item => [item.id, item]));
    const ids = new Set([...inputs.keys(), ...views.keys()]);
    const nodeOwners = new Map<string, number>();
    const addId = (id: string) => { assert(!ids.has(id)); ids.add(id); };
    layout.forEach((block, index) => {
      addId(block.id);
      if (block.type === "comparison") block.cards.forEach(card => addId(card.id));
      for (const id of placedNodes(block)) {
        assert(!nodeOwners.has(id)); nodeOwners.set(id, index);
        if (!inputs.has(id) && !views.has(id)) assert(!closed.has("inputs") || !closed.has("views"));
      }
      if (block.type === "filteredTable") {
        assert(!inputs.has(block.tableId));
        if (views.has(block.tableId)) assert(views.get(block.tableId)!.kind === "table");
        else assert(!closed.has("views"));
        assert(!dynamicTextIds.has(block.tableId));
        for (const filter of block.filters) if (!inputs.has(filter.controlId)) {
          assert(!ids.has(filter.controlId) && !closed.has("inputs"));
        }
      }
    });
    // A known non-node cannot become a node in a later fragment.
    for (const id of nodeOwners.keys()) if (ids.has(id)) assert(inputs.has(id) || views.has(id));
    if (closed.has("layout")) for (const id of [...inputs.keys(), ...views.keys()]) assert(nodeOwners.has(id));

    const cache = new Map<string, Set<string> | undefined>(), visiting = new Set<string>();
    function dependencies(items: UiPlanAtom[]): Set<string> | undefined {
      const result = new Set<string>(); let missing = false;
      for (const item of items) {
        if ("literal" in item) continue;
        if ("input" in item) {
          if (inputs.has(item.input)) result.add(item.input);
          else { assert(!ids.has(item.input) && !closed.has("inputs")); missing = true; }
        } else {
          if (!derived.has(item.derived)) { assert(!closed.has("derived")); missing = true; continue; }
          const inner = resolve(item.derived);
          if (inner) for (const id of inner) result.add(id); else missing = true;
        }
      }
      return missing ? undefined : result;
    }
    function resolve(id: string): Set<string> | undefined {
      if (cache.has(id)) return cache.get(id);
      assert(!visiting.has(id)); visiting.add(id);
      const result = dependencies(derived.get(id)!.args); visiting.delete(id); cache.set(id, result); return result;
    }
    for (const id of derived.keys()) resolve(id);
    const nodeDependencies = new Map<string, Set<string> | undefined>(plan.inputs.map(item => [item.id, new Set([item.id])]));
    plan.views.forEach(view => nodeDependencies.set(view.id, dependencies(atoms(view))));
    // Compile all resolvable declarations, including ones outside visible blocks,
    // so a bad closed declaration cannot hide behind projection.
    const readyViews = plan.views.filter(view => nodeDependencies.get(view.id));
    if (!plan.inputs.length && !readyViews.length) return { status: "waiting" };
    const core = compileUiRichPlanCoreFragment({ ...plan, derived: plan.derived.filter(item => cache.get(item.id)), views: readyViews }, dynamicTextIds);
    const selected = new Set<number>();
    function include(index: number, group: Set<number>): boolean {
      if (group.has(index)) return true;
      group.add(index); const block = layout[index], controls = new Set<string>();
      let ready = true;
      for (const id of placedNodes(block)) {
        const deps = nodeDependencies.get(id);
        if (!deps) ready = false; else for (const input of deps) controls.add(input);
      }
      if (block.type === "filteredTable") for (const filter of block.filters) controls.add(filter.controlId);
      for (const input of controls) {
        const owner = nodeOwners.get(input);
        if (owner === undefined) { assert(!closed.has("layout")); ready = false; }
        else if (!include(owner, group)) ready = false;
      }
      return ready;
    }
    layout.forEach((_block, index) => {
      const group = new Set<number>();
      if (include(index, group)) for (const member of group) selected.add(member);
    });
    if (!selected.size) return { status: "waiting" };
    const blocks = layout.filter((_block, index) => selected.has(index));
    const nodes = new Set(blocks.flatMap(placedNodes));
    const surface = validateRichSurface({ ...core, version: 2, nodes: core.nodes.filter(node => nodes.has(node.id)), layout: blocks });
    return { status: "ready", surface, snapshot: formatRichSnapshot(surface), complete: false };
  } catch { return { status: "invalid", diagnostic: "Closed plan data failed validation" }; }
}
