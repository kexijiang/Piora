import { validateState, type UiNode, type UiState, type UiSurface } from "./surface-document";

export type MigrationControl = Extract<UiNode, { type: "number" | "slider" | "select" | "checkbox" }>;
export const migrationControls = (surface: UiSurface): MigrationControl[] => [...surface.nodes].filter((node): node is MigrationControl => ["number", "slider", "select", "checkbox"].includes(node.type));

/** An explicit mapping copies literal values only. It never infers equivalent
 * labels, units or IDs, converts units, clamps numbers or chooses an option. */
export function mapDraftValues(source: UiSurface, sourceState: UiState, target: UiSurface, targetState: UiState, mapping: Record<string, string>): UiState {
  const from = new Map(migrationControls(source).map(node => [node.id, node]));
  const to = new Map(migrationControls(target).map(node => [node.id, node]));
  const state = { ...validateState(target, targetState) };
  validateState(source, sourceState);
  for (const [targetId, sourceId] of Object.entries(mapping)) {
    if (!to.has(targetId) || !from.has(sourceId)) throw new Error("Choose existing fields before migrating the draft.");
    state[targetId] = sourceState[sourceId];
  }
  return validateState(target, state);
}
