import { getHarmonyDeviceManager } from "@/lib/harmony";
import { HarmonyError } from "@/lib/harmony/errors";
import { InvalidJsonBodyError, JsonBodyTooLargeError, parseJsonWithinLimit } from "@/lib/bounded-json";
import { hasJsonContentType } from "@/lib/request-security";
import { assertNewHarmonyLocalFileAllowed } from "@/lib/harmony/runtime/local-file-access";
import { validateDeviceFileOffset, type HarmonyFileScope } from "@/lib/harmony/device-files";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  try {
    const params = new URL(request.url).searchParams;
    const serial = params.get("serial"), kind = params.get("kind"), path = params.get("path");
    const bundleName = params.get("bundleName");
    const offsetText = params.get("offset") ?? "0";
    if (!serial || !path || (kind !== "shared" && kind !== "sandbox") || (kind === "sandbox" && !bundleName)) {
      throw new HarmonyError("INVALID_ARGUMENT", "Choose a device, file scope and path");
    }
    const scope: HarmonyFileScope = kind === "shared" ? { kind: "shared" } : { kind: "sandbox", bundleName: bundleName! };
    if (params.get("stat") === "1") return noStoreJson({ file: await getHarmonyDeviceManager().statFile(serial, scope, path, request.signal) });
    const offset = validateDeviceFileOffset(/^\d+$/.test(offsetText) ? Number(offsetText) : Number.NaN);
    const result = await getHarmonyDeviceManager().listFiles(serial, scope, path, request.signal, offset);
    return noStoreJson({ scope, path, offset, ...result });
  } catch (error) { return harmonyErrorResponse(error); }
}

export async function POST(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  if (!hasJsonContentType(request)) return noStoreJson({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const body = await parseJsonWithinLimit(request, 16 * 1024) as Record<string, unknown>;
    if (!body || body.action !== "download" || typeof body.serial !== "string" || typeof body.path !== "string"
      || typeof body.destinationPath !== "string" || (body.kind !== "shared" && body.kind !== "sandbox")
      || (body.kind === "sandbox" && typeof body.bundleName !== "string")) {
      throw new HarmonyError("INVALID_ARGUMENT", "Choose a device file and local destination");
    }
    const scope: HarmonyFileScope = body.kind === "shared" ? { kind: "shared" } : { kind: "sandbox", bundleName: body.bundleName as string };
    await assertNewHarmonyLocalFileAllowed(body.destinationPath);
    const result = await getHarmonyDeviceManager().pullFile(body.serial, scope, body.path, body.destinationPath, request.signal);
    return noStoreJson({ result });
  } catch (error) {
    if (error instanceof JsonBodyTooLargeError) return noStoreJson({ error: "Request body is too large" }, { status: 413 });
    if (error instanceof InvalidJsonBodyError) return noStoreJson({ error: "Invalid JSON body" }, { status: 400 });
    return harmonyErrorResponse(error);
  }
}
