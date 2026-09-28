import { getHarmonyDeviceManager } from "@/lib/harmony";
import { HarmonyError } from "@/lib/harmony/errors";
import type { HarmonyFileScope } from "@/lib/harmony/device-files";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  try {
    const params = new URL(request.url).searchParams;
    const serial = params.get("serial"), kind = params.get("kind"), path = params.get("path");
    const bundleName = params.get("bundleName");
    if (!serial || !path || (kind !== "shared" && kind !== "sandbox") || (kind === "sandbox" && !bundleName)) {
      throw new HarmonyError("INVALID_ARGUMENT", "Choose a device, file scope and path");
    }
    const scope: HarmonyFileScope = kind === "shared" ? { kind: "shared" } : { kind: "sandbox", bundleName: bundleName! };
    const result = await getHarmonyDeviceManager().listFiles(serial, scope, path, request.signal);
    return noStoreJson({ scope, path, ...result });
  } catch (error) { return harmonyErrorResponse(error); }
}
