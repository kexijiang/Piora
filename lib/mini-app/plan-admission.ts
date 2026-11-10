import { compileMiniAppPlan } from "./plan";
import { miniAppDiagnostic, type MiniAppDiagnostic } from "./diagnostic";
import { assertMiniAppCapabilities } from "./capabilities";
import { readMiniAppCapabilities } from "./capability-host";
import type { PromptRunIdentity } from "../prompt-run-registry";

/** Validate original JSON before the SDK can coerce numbers, nulls or strings. */
export function originalMiniAppPlanDiagnostic(input: unknown, identity?: PromptRunIdentity): MiniAppDiagnostic | undefined {
  try { assertMiniAppCapabilities(compileMiniAppPlan(input), readMiniAppCapabilities(identity)); return undefined; }
  catch (error) {
    return miniAppDiagnostic(error, { code: "SCHEMA", message: "Expected a complete plain JSON mini app plan",
      path: "$", repairable: true });
  }
}
