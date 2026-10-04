import { getHarmonyDeviceManager } from "@/lib/harmony";
import { listHarmonyMediaHistory } from "@/lib/harmony/media-history";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  try {
    const serial = new URL(request.url).searchParams.get("serial") ?? "";
    return noStoreJson(await listHarmonyMediaHistory(getHarmonyDeviceManager().getConfig(), serial));
  } catch (error) { return harmonyErrorResponse(error); }
}
