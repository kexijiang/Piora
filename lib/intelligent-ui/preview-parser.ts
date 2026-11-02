import { UI_PLAN_LIMITS } from "./plan-types";
import { plan2JsonDepthLimit } from "./plan2-expressions";
import { parseAnswerOutputPrefix, type AnswerOutputPrefix } from "../answer-output-prefix";

export type UiPlanPrefix = AnswerOutputPrefix;

/** Preserve the component protocol's existing limits over the shared scanner. */
export function parseUiPlanPrefix(source: string): UiPlanPrefix {
  return parseAnswerOutputPrefix(source, {
    characters: UI_PLAN_LIMITS.characters, values: UI_PLAN_LIMITS.jsonValues, depth: plan2JsonDepthLimit,
  });
}
