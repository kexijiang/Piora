import { getHarmonyDeviceManager } from "@/lib/harmony";
import { HarmonyError } from "@/lib/harmony/errors";
import { InvalidJsonBodyError, JsonBodyTooLargeError, parseJsonWithinLimit } from "@/lib/bounded-json";
import { hasJsonContentType } from "@/lib/request-security";
import type { HarmonyFileScope } from "@/lib/harmony/device-files";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  try {
    const params = new URL(request.url).searchParams;
    const serial = params.get("serial"), kind = params.get("kind"), path = params.get("path"), bundleName = params.get("bundleName");
    if (!serial || !path || (kind !== "shared" && kind !== "sandbox") || (kind === "sandbox" && !bundleName)) {
      throw new HarmonyError("INVALID_ARGUMENT", "Choose a device text file and scope");
    }
    const scope: HarmonyFileScope = kind === "shared" ? { kind: "shared" } : { kind: "sandbox", bundleName: bundleName! };
    return noStoreJson({ result: await getHarmonyDeviceManager().readTextFile(serial, scope, path, request.signal) });
  } catch (error) { return harmonyErrorResponse(error); }
}

export async function POST(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  if (!hasJsonContentType(request)) return noStoreJson({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const body = await parseJsonWithinLimit(request, 16 * 1024 * 1024) as Record<string, unknown>;
    if (!body || typeof body.serial !== "string" || typeof body.leaseToken !== "string" || typeof body.path !== "string"
      || typeof body.text !== "string" || typeof body.expectedHash !== "string"
      || (body.kind !== "shared" && body.kind !== "sandbox") || (body.kind === "sandbox" && typeof body.bundleName !== "string")) {
      throw new HarmonyError("INVALID_ARGUMENT", "Choose a device text file and expected content hash");
    }
    const scope: HarmonyFileScope = body.kind === "shared" ? { kind: "shared" } : { kind: "sandbox", bundleName: body.bundleName as string };
    const result = await getHarmonyDeviceManager().saveTextFile({ serial: body.serial, leaseToken: body.leaseToken,
      scope, path: body.path, text: body.text, expectedHash: body.expectedHash,
      newlineMode: body.newlineMode === undefined ? undefined : body.newlineMode as "lf" | "crlf" | "cr", signal: request.signal });
    return noStoreJson({ result });
  } catch (error) {
    if (error instanceof JsonBodyTooLargeError) return noStoreJson({ error: "Request body is too large" }, { status: 413 });
    if (error instanceof InvalidJsonBodyError) return noStoreJson({ error: "Invalid JSON body" }, { status: 400 });
    return harmonyErrorResponse(error);
  }
}
