import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHarmonyDeviceManager } from "@/lib/harmony";
import type { HarmonyFileScope } from "@/lib/harmony/device-files";
import { deviceMediaMime, MAX_DEVICE_MEDIA_PREVIEW_BYTES, mediaByteRange } from "@/lib/harmony/device-media";
import { HarmonyError } from "@/lib/harmony/errors";
import { harmonyErrorResponse, requireHarmonyAccess } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  try {
    const params = new URL(request.url).searchParams;
    const serial = params.get("serial") ?? "";
    const path = params.get("path") ?? "";
    const kind = params.get("kind");
    const bundleName = params.get("bundleName") ?? "";
    if (kind !== "shared" && kind !== "sandbox") throw new HarmonyError("INVALID_ARGUMENT", "Choose a device file scope");
    const scope: HarmonyFileScope = kind === "shared" ? { kind: "shared" } : { kind: "sandbox", bundleName };
    const manager = getHarmonyDeviceManager();
    const file = await manager.statFile(serial, scope, path, request.signal);
    if (file.kind !== "file" || !file.size || file.size > MAX_DEVICE_MEDIA_PREVIEW_BYTES) {
      throw new HarmonyError("INVALID_ARGUMENT", "Choose a regular media file no larger than 16 MiB");
    }
    const directory = await mkdtemp(join(tmpdir(), "piora-device-media-"));
    try {
      const local = join(directory, "preview-media");
      await manager.pullFile(serial, scope, path, local, request.signal);
      const after = await manager.statFile(serial, scope, path, request.signal);
      if ((await stat(local)).size !== file.size || after.kind !== "file" || after.size !== file.size
        || (file.modifiedAt !== undefined && after.modifiedAt !== undefined && after.modifiedAt !== file.modifiedAt)) {
        throw new HarmonyError("STALE_SNAPSHOT", "Media changed while the preview was captured");
      }
      const bytes = await readFile(local);
      const mime = deviceMediaMime(path, bytes);
      const range = mediaByteRange(request.headers.get("range"), bytes.length);
      const body = range ? bytes.subarray(range.start, range.end + 1) : bytes;
      return new Response(body, { status: range ? 206 : 200, headers: {
        "Content-Type": mime, "Content-Length": String(body.length), "Accept-Ranges": "bytes",
        ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${bytes.length}` } : {}),
        "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
      } });
    } finally { await rm(directory, { recursive: true, force: true }); }
  } catch (error) { return harmonyErrorResponse(error); }
}
