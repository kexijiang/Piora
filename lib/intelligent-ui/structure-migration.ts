import { initialState, validateState, type UiState, type UiSurface } from "./surface-document";
import type { CompiledUiPlan } from "./plan-types";

type Node = UiSurface["nodes"][number];
export type MigrationControl = Extract<Node, { type: "number" | "slider" | "select" | "checkbox" }>;
export interface UiMigrationField {
  id: string;
  change: "compatible" | "changed" | "added" | "removed";
  before?: MigrationControl;
  after?: MigrationControl;
  beforeMeaning?: CompiledUiPlan["inputSemantics"][number];
  afterMeaning?: CompiledUiPlan["inputSemantics"][number];
  savedValue?: UiState[string];
  suggestedValue?: UiState[string];
}
export interface UiMigrationReview {
  proposalId: string; digest: string; toolCallId: string; leafId: string;
  status: "provisional" | "ready" | "committed" | "cancelled" | "stale";
  fields: UiMigrationField[]; suggestedState: UiState;
  pendingConfirmation?: { requestId: string; state: UiState };
}
type Semantics = CompiledUiPlan["inputSemantics"];
const control = (node: Node): node is MigrationControl => ["number", "slider", "select", "checkbox"].includes(node.type);
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}`;
  return JSON.stringify(value);
}
const shape = (node: MigrationControl) => Object.fromEntries(Object.entries(node).filter(([key]) => key !== "value"));

/** No ID-based unit conversion. Only identical meanings retain saved values. */
export function assessUiMigration(previous: { surface: UiSurface; state: UiState; semantics?: Semantics } | undefined,
  next: { surface: UiSurface; semantics: Semantics }) {
  const suggestedState = initialState(next.surface), fields: UiMigrationField[] = [];
  const before = new Map((previous ? [...previous.surface.nodes].filter(control) : []).map(node => [node.id, node]));
  for (const after of [...next.surface.nodes].filter(control)) {
    const old = before.get(after.id), previousMeaning = previous?.semantics?.find(item => item.id === after.id);
    const nextMeaning = next.semantics.find(item => item.id === after.id);
    const compatible = !!old && stable(shape(old)) === stable(shape(after))
      && (!previous?.semantics || !!previousMeaning && !!nextMeaning && stable(previousMeaning) === stable(nextMeaning));
    if (compatible) suggestedState[after.id] = previous!.state[after.id];
    fields.push({ id: after.id, change: !old ? "added" : compatible ? "compatible" : "changed",
      ...(old ? { before: old, savedValue: previous!.state[old.id], ...(previousMeaning ? { beforeMeaning: previousMeaning } : {}) } : {}),
      after, ...(nextMeaning ? { afterMeaning: nextMeaning } : {}), suggestedValue: suggestedState[after.id] });
    before.delete(after.id);
  }
  for (const old of before.values()) {
    const meaning = previous?.semantics?.find(item => item.id === old.id);
    fields.push({ id: old.id, change: "removed", before: old, savedValue: previous!.state[old.id], ...(meaning ? { beforeMeaning: meaning } : {}) });
  }
  validateState(next.surface, suggestedState);
  return { fields, suggestedState, requiresConfirmation: fields.some(field => field.change === "changed" || field.change === "removed") };
}
