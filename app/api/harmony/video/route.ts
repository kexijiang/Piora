import { getHarmonyDeviceManager } from "@/lib/harmony";
import { HarmonyError } from "@/lib/harmony/errors";
import { prepareVideoStream } from "@/lib/harmony/media/stream-start";
import { harmonyErrorResponse, requireHarmonyAccess, requiredQuery } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request);
  if (denied) return denied;
  try {
    const serial = requiredQuery(request, "serial");
    const manager = getHarmonyDeviceManager();
    const connection = await manager.openVideoStream({ serial, signal: request.signal });
    const device = manager.getState().devices.find((candidate) => candidate.serial === serial);
    if (!device) {
      await connection.close();
      throw new HarmonyError("DEVICE_NOT_FOUND", "The selected Harmony device is not connected");
    }
    return new Response(await prepareVideoStream(connection, request.signal), {
      headers: {
        "Content-Type": "application/vnd.piora.harmony-stream",
        "Cache-Control": "private, no-store, no-transform",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
        "X-Harmony-Generation": String(device.generation),
      },
    });
  } catch (error) {
    return harmonyErrorResponse(error);
  }
}
