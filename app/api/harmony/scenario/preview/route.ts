import { InvalidJsonBodyError, JsonBodyTooLargeError, parseJsonWithinLimit } from "@/lib/bounded-json";
import { HarmonyError } from "@/lib/harmony/errors";
import { validateHarmonyScenario } from "@/lib/harmony/scenario-executor";
import type { HarmonyScenarioPolicy, HarmonyScenarioStep } from "@/lib/harmony/types";
import { hasJsonContentType } from "@/lib/request-security";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../../_shared";

export async function POST(request: Request) {
  const denied = requireHarmonyAccess(request);
  if (denied) return denied;
  if (!hasJsonContentType(request)) return noStoreJson({ error: "JSON required" }, { status: 415 });
  try {
    const body = await parseJsonWithinLimit(request, 128 * 1024);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HarmonyError("INVALID_ARGUMENT", "A scenario object is required");
    const { steps, policy } = body as { steps: HarmonyScenarioStep[]; policy?: HarmonyScenarioPolicy };
    // Validation does not construct a manager, acquire a lease, read a device, or dispatch.
    validateHarmonyScenario({ serial: "preview", leaseToken: "preview", steps, policy });
    return noStoreJson({ stepCount: steps.length, requiredActions: [...new Set(steps.map(step => step.action))], deviceVerified: false });
  } catch (error) {
    if (error instanceof JsonBodyTooLargeError) return noStoreJson({ error: "Request body is too large" }, { status: 413 });
    if (error instanceof InvalidJsonBodyError) return noStoreJson({ error: "Invalid JSON body" }, { status: 400 });
    return harmonyErrorResponse(error);
  }
}
