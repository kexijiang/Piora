import { getHarmonyDeviceManager } from "@/lib/harmony";
import { HarmonyError } from "@/lib/harmony/errors";
import type { HarmonyFileScope } from "@/lib/harmony/device-files";
import { InvalidJsonBodyError, JsonBodyTooLargeError, parseJsonWithinLimit } from "@/lib/bounded-json";
import { hasJsonContentType } from "@/lib/request-security";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../_shared";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  if (!hasJsonContentType(request)) return noStoreJson({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const body = await parseJsonWithinLimit(request, 16 * 1024) as Record<string, unknown>;
    if (!body || typeof body.serial !== "string" || typeof body.leaseToken !== "string" || typeof body.command !== "string"
      || (body.kind !== "shared" && body.kind !== "sandbox") || (body.kind === "sandbox" && typeof body.bundleName !== "string")) {
      throw new HarmonyError("INVALID_ARGUMENT", "Choose a device and manual command");
    }
    const scope: HarmonyFileScope = body.kind === "shared" ? { kind: "shared" } : { kind: "sandbox", bundleName: body.bundleName as string };
    return noStoreJson({ result: await getHarmonyDeviceManager().runShellCommand({ serial: body.serial, leaseToken: body.leaseToken,
      scope, command: body.command, signal: request.signal }) });
  } catch (error) {
    if (error instanceof JsonBodyTooLargeError) return noStoreJson({ error: "Request body is too large" }, { status: 413 });
    if (error instanceof InvalidJsonBodyError) return noStoreJson({ error: "Invalid JSON body" }, { status: 400 });
    return harmonyErrorResponse(error);
  }
}
