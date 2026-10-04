import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHarmonyDeviceManager } from "@/lib/harmony";
import type { HarmonyFileScope } from "@/lib/harmony/device-files";
import { deviceHexPreview, MAX_DEVICE_HEX_FILE_BYTES } from "@/lib/harmony/device-hex";
import { HarmonyError } from "@/lib/harmony/errors";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  try {
    const params = new URL(request.url).searchParams;
    const serial = params.get("serial") ?? "", path = params.get("path") ?? "";
    const kind = params.get("kind"), bundleName = params.get("bundleName") ?? "";
    if (!serial || !path || (kind !== "shared" && kind !== "sandbox") || (kind === "sandbox" && !bundleName)) {
      throw new HarmonyError("INVALID_ARGUMENT", "Choose a device, file scope and path");
    }
    const scope: HarmonyFileScope = kind === "shared" ? { kind: "shared" } : { kind: "sandbox", bundleName };
    const manager = getHarmonyDeviceManager();
    const before = await manager.statFile(serial, scope, path, request.signal);
    if (before.kind !== "file" || before.size === undefined || before.size > MAX_DEVICE_HEX_FILE_BYTES) {
      throw new HarmonyError("INVALID_ARGUMENT", "Choose a regular file no larger than 64 KiB for hexadecimal preview");
    }
    const directory = await mkdtemp(join(tmpdir(), "piora-device-hex-"));
    try {
      const local = join(directory, "preview.bin");
      await manager.pullFile(serial, scope, path, local, request.signal);
      const after = await manager.statFile(serial, scope, path, request.signal);
      if ((await stat(local)).size !== before.size || after.kind !== "file" || after.size !== before.size
        || (before.modifiedAt !== undefined && after.modifiedAt !== undefined && before.modifiedAt !== after.modifiedAt)) {
        throw new HarmonyError("STALE_SNAPSHOT", "File changed while its hexadecimal preview was captured");
      }
      return noStoreJson({ preview: deviceHexPreview(await readFile(local)) });
    } finally { await rm(directory, { recursive: true, force: true }); }
  } catch (error) { return harmonyErrorResponse(error); }
}
