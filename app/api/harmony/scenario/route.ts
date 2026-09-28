import { InvalidJsonBodyError, JsonBodyTooLargeError, parseJsonWithinLimit } from "@/lib/bounded-json";
import { getHarmonyDeviceManager } from "@/lib/harmony";
import { HarmonyError } from "@/lib/harmony/errors";
import { assertScenarioHapsAllowed } from "@/lib/harmony/runtime/allowed-hap";
import type { HarmonyScenarioPolicy, HarmonyScenarioStep, HarmonySnapshot } from "@/lib/harmony/types";
import { hasJsonContentType } from "@/lib/request-security";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../_shared";

export const dynamic = "force-dynamic";

function requiredString(body: Record<string, unknown>, key: string, maximum: number): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new HarmonyError("INVALID_ARGUMENT", `${key} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

function publicSnapshot(snapshot: HarmonySnapshot): unknown {
  return {
    serial: snapshot.serial,
    generation: snapshot.generation,
    revision: snapshot.revision,
    capturedAt: snapshot.capturedAt,
    quality: snapshot.quality,
    tree: snapshot.tree,
    nodes: snapshot.nodes,
    ...(snapshot.screenshot ? {
      screenshot: {
        mimeType: snapshot.screenshot.mimeType,
        width: snapshot.screenshot.width,
        height: snapshot.screenshot.height,
        data: snapshot.screenshot.data.toString("base64"),
      },
    } : {}),
  };
}

export async function POST(request: Request) {
  const denied = requireHarmonyAccess(request);
  if (denied) return denied;
  if (!hasJsonContentType(request)) return noStoreJson({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const parsed = await parseJsonWithinLimit(request, 128 * 1024);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HarmonyError("INVALID_ARGUMENT", "Request body must be a JSON object");
    }
    const body = parsed as Record<string, unknown>;
    if (body.action === "remove") {
      getHarmonyDeviceManager().removeExecution(requiredString(body, "executionId", 36), requiredString(body, "serial", 256));
      return noStoreJson({ removed: true });
    }
    if (body.resumeExecutionId !== undefined) {
      const result = await getHarmonyDeviceManager().resumeScenario(requiredString(body, "resumeExecutionId", 36), requiredString(body, "serial", 256), requiredString(body, "leaseToken", 256), request.signal);
      const { finalSnapshot, ...summary } = result;
      return noStoreJson({ result: { ...summary, ...(finalSnapshot ? { finalSnapshot: publicSnapshot(finalSnapshot) } : {}) } });
    }
    if (!Array.isArray(body.steps)) throw new HarmonyError("INVALID_ARGUMENT", "steps must be an array");
    await assertScenarioHapsAllowed(body.steps);
    if (body.policy !== undefined && (!body.policy || typeof body.policy !== "object" || Array.isArray(body.policy))) {
      throw new HarmonyError("INVALID_ARGUMENT", "policy must be a JSON object when provided");
    }
    const result = await getHarmonyDeviceManager().runScenario({
      serial: requiredString(body, "serial", 256),
      leaseToken: requiredString(body, "leaseToken", 256),
      steps: body.steps as HarmonyScenarioStep[],
      ...(body.policy ? { policy: body.policy as HarmonyScenarioPolicy } : {}),
      signal: request.signal,
    });
    const { finalSnapshot, ...summary } = result;
    return noStoreJson({ result: {
      ...summary,
      ...(finalSnapshot ? { finalSnapshot: publicSnapshot(finalSnapshot) } : {}),
    } });
  } catch (error) {
    if (error instanceof JsonBodyTooLargeError) return noStoreJson({ error: "Request body is too large" }, { status: 413 });
    if (error instanceof InvalidJsonBodyError) return noStoreJson({ error: "Invalid JSON body" }, { status: 400 });
    return harmonyErrorResponse(error);
  }
}

export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  try { return noStoreJson({ executions: getHarmonyDeviceManager().listExecutions(new URL(request.url).searchParams.get("serial") ?? undefined) }); }
  catch (error) { return harmonyErrorResponse(error); }
}
