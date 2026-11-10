import { getHarmonyDeviceManager } from "@/lib/harmony";
import { parseJsonWithinLimit } from "@/lib/bounded-json";
import { HarmonyError } from "@/lib/harmony/errors";
import { hasJsonContentType } from "@/lib/request-security";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../_shared";

/** Reconcile owned cleanup without granting input or bypassing a pending driver. */
export async function POST(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  if (!hasJsonContentType(request)) return noStoreJson({ error: "JSON required" }, { status: 415 });
  try {
    const body = await parseJsonWithinLimit(request, 16 * 1024) as Record<string, unknown>;
    if (!body || typeof body.serial !== "string" || !body.serial || body.serial.length > 256) throw new HarmonyError("INVALID_ARGUMENT", "Device serial required");
    if (body.action !== "retry" && body.action !== "confirm") throw new HarmonyError("INVALID_ARGUMENT", "Unsupported recovery action");
    if (body.action === "confirm" && (body.released !== true || body.recordingStopped !== true)) {
      throw new HarmonyError("INVALID_ARGUMENT", "Confirm only after physically checking that keys, touch and recording have stopped");
    }
    const manager = getHarmonyDeviceManager();
    const result = body.action === "retry" ? await manager.retryCleanup(body.serial) : await manager.confirmCleanup(body.serial, request.signal);
    const state = manager.getState();
    return noStoreJson({ ...result, controlStatus: state.controls?.find(control => control.serial === body.serial)?.status ?? null,
      device: state.devices.find(device => device.serial === body.serial) });
  } catch (error) { return harmonyErrorResponse(error); }
}
