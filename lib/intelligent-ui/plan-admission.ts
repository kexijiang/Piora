import { compileUiPlan } from "./plan";
import { compileUiRichPlan } from "./rich-plan";
import { UiPlanError, type UiPlanDiagnostic } from "./plan-types";
import { trialUiInputBoundaries } from "./input-trial";
import { compileA2uiUi } from "../a2ui/ui-compiler";

/** SDK coercion can turn null into an empty string/zero. Check original plan data first. */
export function originalUiPlanDiagnostic(input: unknown, a2uiAuthoring = false): UiPlanDiagnostic | undefined {
  try {
    const version = input && typeof input === "object" && Object.getOwnPropertyDescriptor(input, "planVersion")?.value;
    const compile = a2uiAuthoring || input && typeof input === "object" && Object.hasOwn(input, "messages") ? compileA2uiUi : version === 1 ? compileUiPlan : compileUiRichPlan;
    trialUiInputBoundaries(compile(input, { revision: 1 }).surface);
    return undefined;
  } catch (error) {
    return error instanceof UiPlanError ? error.diagnostic : {
      code: "PLAN_SHAPE", path: "$", expected: "A complete plain JSON plan", repairable: true,
    };
  }
}
