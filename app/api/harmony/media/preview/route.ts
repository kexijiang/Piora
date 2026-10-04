import { readFile, lstat } from "node:fs/promises";
import { basename, join } from "node:path";
import { getHarmonyDeviceManager } from "@/lib/harmony";
import { resolveHarmonyStorage, safeHarmonyDeviceName } from "@/lib/harmony/artifacts";
import { HarmonyError } from "@/lib/harmony/errors";
import { harmonyErrorResponse, requireHarmonyAccess } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  try {
    const params = new URL(request.url).searchParams;
    const serial = params.get("serial") ?? "";
    const filename = params.get("filename") ?? "";
    const prefix = safeHarmonyDeviceName(serial);
    if (!/^[A-Za-z0-9._:\[\]-]{1,256}$/.test(serial) || basename(filename) !== filename
      || !/^[A-Za-z0-9._-]{1,180}\.png$/.test(filename) || !filename.startsWith(`${prefix}-`)) {
      throw new HarmonyError("INVALID_ARGUMENT", "Choose a screenshot from the current device");
    }
    const directory = resolveHarmonyStorage(getHarmonyDeviceManager().getConfig()).screenshotDirectory;
    const path = join(directory, filename);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 64 || info.size > 20 * 1024 * 1024) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Screenshot preview is unavailable");
    }
    return new Response(await readFile(path), { headers: { "Content-Type": "image/png", "Content-Length": String(info.size),
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return harmonyErrorResponse(error); }
}
