import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getHarmonyDeviceManager } from "./index";
import { HarmonyError } from "./errors";
import { defaultHarmonyConfigPath } from "./runtime";
import { assertHarmonyLocalSourceAllowed, assertNewHarmonyLocalFileAllowed } from "./runtime/local-file-access";
import { validateDeviceFilePath, validateWritableDeviceFilePath, type HarmonyFileScope } from "./device-files";
import { HarmonyTransferJobs, type HarmonyTransferInput } from "./transfer-jobs";

declare global { var __pioraHarmonyTransferJobs: HarmonyTransferJobs | undefined; }

export async function validateHarmonyTransferItems(scope: HarmonyFileScope, items: HarmonyTransferInput[]): Promise<void> {
  if (!Array.isArray(items) || items.length < 1 || items.length > 20) throw new HarmonyError("INVALID_ARGUMENT", "Choose 1–20 files to transfer");
  const targets = new Set<string>();
  for (const item of items) {
    if (!item || typeof item.path !== "string" || item.path.length > 4096) throw new HarmonyError("INVALID_ARGUMENT", "Choose a valid device file path");
    if (item.direction === "download") {
      if (typeof item.destinationPath !== "string" || item.destinationPath.length > 4096) throw new HarmonyError("INVALID_ARGUMENT", "Choose an allowed local destination");
      validateDeviceFilePath(scope, item.path);
      await assertNewHarmonyLocalFileAllowed(item.destinationPath);
      const destination = resolve(item.destinationPath);
      const key = `local:${process.platform === "win32" ? destination.toLowerCase() : destination}`;
      if (targets.has(key)) throw new HarmonyError("INVALID_ARGUMENT", "Duplicate download destination in one batch");
      targets.add(key);
    } else if (item.direction === "upload") {
      if (typeof item.sourcePath !== "string" || item.sourcePath.length > 4096 || typeof item.overwrite !== "boolean") {
        throw new HarmonyError("INVALID_ARGUMENT", "Choose an allowed upload source and overwrite option");
      }
      validateWritableDeviceFilePath(scope, item.path);
      await assertHarmonyLocalSourceAllowed(item.sourcePath);
      const key = `device:${item.path}`;
      if (targets.has(key)) throw new HarmonyError("INVALID_ARGUMENT", "Duplicate device target in one batch");
      targets.add(key);
    } else throw new HarmonyError("INVALID_ARGUMENT", "Unknown transfer direction");
  }
}

export function getHarmonyTransferJobs(): HarmonyTransferJobs {
  if (!globalThis.__pioraHarmonyTransferJobs) {
    globalThis.__pioraHarmonyTransferJobs = new HarmonyTransferJobs(
      join(dirname(defaultHarmonyConfigPath()), "harmony-transfer-jobs.json"),
      async (job, item, leaseToken, signal) => {
        const manager = getHarmonyDeviceManager();
        if (item.direction === "download") {
          await assertNewHarmonyLocalFileAllowed(item.destinationPath);
          validateDeviceFilePath(job.scope, item.path);
          return await manager.pullFile(job.serial, job.scope, item.path, item.destinationPath, signal);
        }
        if (!leaseToken) throw new HarmonyError("LEASE_REQUIRED", "Device control is required for uploads");
        await assertHarmonyLocalSourceAllowed(item.sourcePath);
        validateWritableDeviceFilePath(job.scope, item.path);
        const size = (await stat(item.sourcePath)).size;
        await manager.uploadFile({ serial: job.serial, scope: job.scope, sourcePath: item.sourcePath, path: item.path,
          overwrite: item.overwrite, leaseToken, signal });
        return { size };
      },
      { renew: token => { getHarmonyDeviceManager().renewLease(token, 30 * 60_000); },
        release: token => { getHarmonyDeviceManager().releaseLease(token); } },
    );
  }
  return globalThis.__pioraHarmonyTransferJobs;
}
