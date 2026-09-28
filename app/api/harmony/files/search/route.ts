import { getHarmonyDeviceManager } from "@/lib/harmony";
import { HarmonyError } from "@/lib/harmony/errors";
import type { HarmonyFileScope } from "@/lib/harmony/device-files";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  try {
    const params = new URL(request.url).searchParams;
    const serial = params.get("serial"), kind = params.get("kind"), path = params.get("path"), query = params.get("query"), bundleName = params.get("bundleName");
    if (!serial || !path || !query || (kind !== "shared" && kind !== "sandbox") || (kind === "sandbox" && !bundleName)) {
      throw new HarmonyError("INVALID_ARGUMENT", "Choose a device directory, scope and search text");
    }
    const scope: HarmonyFileScope = kind === "shared" ? { kind: "shared" } : { kind: "sandbox", bundleName: bundleName! };
    return noStoreJson({ result: await getHarmonyDeviceManager().searchFiles(serial, scope, path, query, request.signal) });
  } catch (error) { return harmonyErrorResponse(error); }
}
