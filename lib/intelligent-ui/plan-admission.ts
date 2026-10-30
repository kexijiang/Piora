import { compileUiPlan } from "./plan";
import { compileUiRichPlan } from "./rich-plan";
import { UiPlanError, type UiPlanDiagnostic } from "./plan-types";

/** SDK coercion can turn null into an empty string/zero. Check original plan data first. */
export function originalUiPlanDiagnostic(input: unknown): UiPlanDiagnostic | undefined {
  try {
    const version = input && typeof input === "object" && Object.getOwnPropertyDescriptor(input, "planVersion")?.value;
    const compile = version === 1 ? compileUiPlan : compileUiRichPlan;
    compile(input, { revision: 1 });
    return undefined;
  } catch (error) {
    return error instanceof UiPlanError ? error.diagnostic : {
      code: "PLAN_SHAPE", path: "$", expected: "A complete plain JSON plan", repairable: true,
    };
  }
}
