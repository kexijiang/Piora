import * as legacy from "./protocol";
import { formatRichSnapshot, richInitialState, validateRichState, validateRichSurface, type UiRichSurface } from "./rich-protocol";

/** Persisted surface versions are independent of the answerOutput envelope.
 * Legacy extraction deliberately stays in protocol.ts and accepts only v1. */
export type UiSurface = legacy.UiSurface | UiRichSurface;
export type { UiExpression, UiState, UiValue } from "./protocol";
export type { UiRichNode as UiNode } from "./rich-protocol";
export { evaluateExpression, isUiId } from "./protocol";

export function validateSurface(input: unknown): UiSurface {
  return input && typeof input === "object" && "version" in input && input.version === 2
    ? validateRichSurface(input) : legacy.validateSurface(input);
}
export function initialState(surface: UiSurface): legacy.UiState {
  return surface.version === 2 ? richInitialState(surface) : legacy.initialState(surface);
}
export function validateState(surface: UiSurface, input: unknown): legacy.UiState {
  return surface.version === 2 ? validateRichState(surface, input) : legacy.validateState(surface, input);
}
export function formatSnapshot(surface: UiSurface, state = initialState(surface)): string {
  return surface.version === 2 ? formatRichSnapshot(surface, state) : legacy.formatSnapshot(surface, state);
}
