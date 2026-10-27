import { getHarmonyDeviceManager } from "@/lib/harmony";
import { listHarmonyMediaHistory, deleteHarmonyMedia } from "@/lib/harmony/media-history";
import { InvalidJsonBodyError, JsonBodyTooLargeError, parseJsonWithinLimit } from "@/lib/bounded-json";
import { hasJsonContentType } from "@/lib/request-security";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  try {
    const serial = new URL(request.url).searchParams.get("serial") ?? "";
    return noStoreJson(await listHarmonyMediaHistory(getHarmonyDeviceManager().getConfig(), serial));
  } catch (error) { return harmonyErrorResponse(error); }
}

export async function POST(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  if (!hasJsonContentType(request)) return noStoreJson({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const body = await parseJsonWithinLimit(request, 4096) as Record<string, unknown>;
    if (!body || body.action !== "delete" || typeof body.serial !== "string" || typeof body.filename !== "string") return noStoreJson({ error: "Invalid media deletion" }, { status: 400 });
    await deleteHarmonyMedia(getHarmonyDeviceManager().getConfig(), body.serial, body.filename);
    return noStoreJson({ deleted: true });
  } catch (error) {
    if (error instanceof JsonBodyTooLargeError) return noStoreJson({ error: "Request body is too large" }, { status: 413 });
    if (error instanceof InvalidJsonBodyError) return noStoreJson({ error: "Invalid JSON body" }, { status: 400 });
    return harmonyErrorResponse(error);
  }
}
