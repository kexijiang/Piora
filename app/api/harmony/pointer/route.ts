import { getHarmonyDeviceManager } from "@/lib/harmony";
import { parseJsonWithinLimit, InvalidJsonBodyError, JsonBodyTooLargeError } from "@/lib/bounded-json";
import { hasJsonContentType } from "@/lib/request-security";
import { HarmonyError } from "@/lib/harmony/errors";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../_shared";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  if (!hasJsonContentType(request)) return noStoreJson({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const body = await parseJsonWithinLimit(request, 2048) as Record<string, unknown>;
    const bad = () => { throw new HarmonyError("INVALID_ARGUMENT", "Invalid live pointer request"); };
    if (!body || typeof body.serial !== "string" || typeof body.leaseToken !== "string" || !["down", "move", "up"].includes(String(body.phase))) bad();
    const serial = body.serial as string, leaseToken = body.leaseToken as string;
    if (body.phase !== "up" && ![body.x, body.y].every(value => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 16384)) bad();
    const manager = getHarmonyDeviceManager();
    if (body.phase === "down") {
      if (typeof body.geometryId !== "string" || !Number.isInteger(body.generation) || Number(body.generation) < 1) bad();
      const result = await manager.beginManualPointer({ serial, leaseToken, x: Number(body.x), y: Number(body.y),
        coordinateSpace: "frame", geometryId: body.geometryId as string, generation: Number(body.generation), signal: request.signal });
      return noStoreJson(result);
    }
    if (typeof body.gestureId !== "string" || !/^[a-f0-9]{32}$/.test(body.gestureId)) bad();
    await manager.updateManualPointer({ serial, leaseToken, gestureId: body.gestureId as string, phase: body.phase as "move" | "up", x: body.x as number, y: body.y as number });
    return noStoreJson({ released: body.phase === "up" });
  } catch (error) {
    if (error instanceof JsonBodyTooLargeError) return noStoreJson({ error: "Request body is too large" }, { status: 413 });
    if (error instanceof InvalidJsonBodyError) return noStoreJson({ error: "Invalid JSON body" }, { status: 400 });
    return harmonyErrorResponse(error);
  }
}
