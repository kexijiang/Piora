import { getHarmonyDeviceManager } from "@/lib/harmony";
import { HarmonyError } from "@/lib/harmony/errors";
import { InvalidJsonBodyError, JsonBodyTooLargeError, parseJsonWithinLimit } from "@/lib/bounded-json";
import { hasJsonContentType } from "@/lib/request-security";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../../_shared";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  if (!hasJsonContentType(request)) return noStoreJson({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const body = await parseJsonWithinLimit(request, 1024) as Record<string, unknown>;
    if (!body || typeof body.address !== "string" || (body.action !== "connect" && body.action !== "disconnect")) {
      throw new HarmonyError("INVALID_ARGUMENT", "Choose a TCP device address and connection action");
    }
    const devices = await getHarmonyDeviceManager().connectTcpDevice(body.address, body.action === "disconnect", request.signal);
    return noStoreJson({ devices });
  } catch (error) {
    if (error instanceof JsonBodyTooLargeError) return noStoreJson({ error: "Request body is too large" }, { status: 413 });
    if (error instanceof InvalidJsonBodyError) return noStoreJson({ error: "Invalid JSON body" }, { status: 400 });
    return harmonyErrorResponse(error);
  }
}
