import { compileMiniAppPlan, validateMiniAppInputs, type MiniAppInput, type MiniAppPlan1 } from "./plan";
import type { JsonRecord } from "./json";

export interface MiniAppMigrationField {
  id: string; change: "compatible" | "changed" | "added" | "removed";
  before?: MiniAppInput; after?: MiniAppInput; savedValue?: unknown; suggestedValue?: unknown;
}
export interface MiniAppMigrationReview {
  toolCallId: string; publicationId: string; digest: string; leafId: string;
  status: "ready" | "committed" | "cancelled" | "stale";
  fields: MiniAppMigrationField[]; suggestedInputs: JsonRecord;
  resets: readonly ["state", "tick", "rng", "view"];
  progress?: { description: string; clock: "reset" | "preserve" };
  pending?: MiniAppMigrationChoice;
}
export interface MiniAppMigrationChoice {
  toolCallId: string; publicationId: string; digest: string; leafId: string; requestId: string;
  decision: "confirm" | "cancel"; inputs: JsonRecord;
  progress?: "reset" | "migrate";
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return "{" + entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",") + "}";
  }
  return JSON.stringify(value);
}
const shape = (input: MiniAppInput) => Object.fromEntries(Object.entries(input).filter(([key]) => key !== "value"));

/** Values alone cannot prove semantic compatibility, including implicit units. */
export function assessMiniAppMigration(previous: MiniAppPlan1, savedInputs: JsonRecord, next: MiniAppPlan1) {
  const suggestedInputs = { ...compileMiniAppPlan(next).initialInputs }, fields: MiniAppMigrationField[] = [];
  const before = new Map(previous.inputs.map(input => [input.id, input]));
  for (const after of next.inputs) {
    const old = before.get(after.id), compatible = !!old && stable(shape(old)) === stable(shape(after));
    if (compatible) suggestedInputs[after.id] = savedInputs[after.id];
    fields.push({ id: after.id, change: !old ? "added" : compatible ? "compatible" : "changed",
      ...(old ? { before: old, savedValue: savedInputs[old.id] } : {}), after, suggestedValue: suggestedInputs[after.id] });
    before.delete(after.id);
  }
  for (const old of before.values()) fields.push({ id: old.id, change: "removed", before: old, savedValue: savedInputs[old.id] });
  validateMiniAppInputs(next, suggestedInputs);
  return { fields, suggestedInputs, resets: ["state", "tick", "rng", "view"] as const };
}
