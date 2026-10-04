import { getHarmonyDeviceManager } from "@/lib/harmony";
import { getHarmonyDatabaseExportJobs } from "@/lib/harmony/database-export-runtime";
import { getHarmonyTransferJobs } from "@/lib/harmony/transfer-runtime";
import { listHarmonyMediaHistory } from "@/lib/harmony/media-history";
import { summarizeHarmonyTasks } from "@/lib/harmony/task-overview";
import { HarmonyError } from "@/lib/harmony/errors";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  try {
    const parameters = new URL(request.url).searchParams;
    const serial = parameters.get("serial") ?? "";
    if (!/^[A-Za-z0-9._:\[\]-]{1,256}$/.test(serial)) throw new HarmonyError("INVALID_ARGUMENT", "Choose a valid device");
    const filter = parameters.get("filter") ?? "all";
    if (filter !== "all" && filter !== "active" && filter !== "completed" && filter !== "attention")
      throw new HarmonyError("INVALID_ARGUMENT", "Choose a valid task status");
    const manager = getHarmonyDeviceManager();
    const media = await listHarmonyMediaHistory(manager.getConfig(), serial);
    const overview = summarizeHarmonyTasks({ transfers: getHarmonyTransferJobs().list(serial),
      databases: getHarmonyDatabaseExportJobs().list(serial), scenarios: manager.listExecutions(serial), media: media.artifacts,
      operations: manager.operationTasks.list(serial) }, 100, filter);
    return noStoreJson({ ...overview, truncated: overview.truncated || media.truncated });
  } catch (error) { return harmonyErrorResponse(error); }
}
