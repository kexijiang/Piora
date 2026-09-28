import { InvalidJsonBodyError, JsonBodyTooLargeError, parseJsonWithinLimit } from "@/lib/bounded-json";
import { getHarmonyDeviceManager } from "@/lib/harmony";
import { dispatchHarmonyAction } from "@/lib/harmony/action-dispatcher";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { HarmonyError } from "@/lib/harmony/errors";
import { hasJsonContentType } from "@/lib/request-security";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../_shared";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  if (!hasJsonContentType(request)) return noStoreJson({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const body = await parseJsonWithinLimit(request, 16 * 1024) as Record<string, unknown>;
    if (body?.action === "install_app" && (typeof body.hapPath !== "string" || !isExistingFilePathAllowed(body.hapPath, await getAllowedFileRoots()))) {
      throw new HarmonyError("INVALID_ARGUMENT", "Select a HAP within an allowed workspace root");
    }
    return noStoreJson({ result: await dispatchHarmonyAction(getHarmonyDeviceManager(), body, request.signal) });
  } catch (error) {
    if (error instanceof JsonBodyTooLargeError) return noStoreJson({ error: "Request body is too large" }, { status: 413 });
    if (error instanceof InvalidJsonBodyError) return noStoreJson({ error: "Invalid JSON body" }, { status: 400 });
    return harmonyErrorResponse(error);
  }
}
