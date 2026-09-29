import { InvalidJsonBodyError, JsonBodyTooLargeError, parseJsonWithinLimit } from "@/lib/bounded-json";
import { discoverHdcCandidates, getHarmonyDeviceManager } from "@/lib/harmony";
import { resolveHarmonyStorage } from "@/lib/harmony/artifacts";
import { HarmonyError } from "@/lib/harmony/errors";
import { hasJsonContentType } from "@/lib/request-security";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request);
  if (denied) return denied;
  try {
    const manager = getHarmonyDeviceManager();
    const [config, diagnostics] = await Promise.all([manager.getConfig(), manager.getDiagnostics()]);
    return noStoreJson({ config, storage: resolveHarmonyStorage(config), diagnostics, candidates: discoverHdcCandidates({ config }) });
  } catch (error) {
    return harmonyErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  const denied = requireHarmonyAccess(request);
  if (denied) return denied;
  if (!hasJsonContentType(request)) return noStoreJson({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const body = await parseJsonWithinLimit(request, 8 * 1024) as Record<string, unknown>;
    if (body.hdcPath !== undefined && body.hdcPath !== null && typeof body.hdcPath !== "string") {
      throw new HarmonyError("INVALID_ARGUMENT", "hdcPath must be an absolute path or null");
    }
    if (body.video !== undefined && body.video !== null) {
      if (!body.video || typeof body.video !== "object" || Array.isArray(body.video)) throw new HarmonyError("INVALID_ARGUMENT", "video must be an object or null");
      const video = body.video as Record<string, unknown>;
      if ((video.provider !== "bundled" && video.provider !== "hos-scrcpy")
        || (video.packageDirectory !== undefined && typeof video.packageDirectory !== "string")
        || (video.javaPath !== undefined && typeof video.javaPath !== "string")) {
        throw new HarmonyError("INVALID_ARGUMENT", "video requires a known provider and optional paths");
      }
    }
    if (body.vision !== undefined && body.vision !== null) {
      if (!body.vision || typeof body.vision !== "object" || Array.isArray(body.vision)) {
        throw new HarmonyError("INVALID_ARGUMENT", "vision must be an object or null");
      }
      const vision = body.vision as Record<string, unknown>;
      if (typeof vision.enabled !== "boolean" || typeof vision.provider !== "string" || typeof vision.modelId !== "string") {
        throw new HarmonyError("INVALID_ARGUMENT", "vision requires enabled, provider, and modelId");
      }
      if (vision.shareScreenshotWithActionModel !== undefined && typeof vision.shareScreenshotWithActionModel !== "boolean") {
        throw new HarmonyError("INVALID_ARGUMENT", "shareScreenshotWithActionModel must be boolean");
      }
    }
    if (body.storage !== undefined && body.storage !== null) {
      if (!body.storage || typeof body.storage !== "object" || Array.isArray(body.storage)) {
        throw new HarmonyError("INVALID_ARGUMENT", "storage must be an object or null");
      }
      const storage = body.storage as Record<string, unknown>;
      for (const key of ["screenshotDirectory", "recordingDirectory"] as const) {
        if (storage[key] !== undefined && typeof storage[key] !== "string") {
          throw new HarmonyError("INVALID_ARGUMENT", `${key} must be an absolute path`);
        }
      }
    }
    const manager = getHarmonyDeviceManager();
    const config = await manager.updateConfig({
      ...(body.hdcPath !== undefined ? { hdcPath: body.hdcPath as string | null } : {}),
      ...(body.video !== undefined ? { video: body.video as import("@/lib/harmony").HarmonyConfig["video"] | null } : {}),
      ...(body.storage !== undefined ? { storage: body.storage as import("@/lib/harmony").HarmonyConfig["storage"] | null } : {}),
      ...(body.vision !== undefined ? { vision: body.vision as import("@/lib/harmony").HarmonyConfig["vision"] | null } : {}),
    }, request.signal);
    return noStoreJson({ config, storage: resolveHarmonyStorage(config), diagnostics: await manager.getDiagnostics(), candidates: discoverHdcCandidates({ config }) });
  } catch (error) {
    if (error instanceof JsonBodyTooLargeError) return noStoreJson({ error: "Request body is too large" }, { status: 413 });
    if (error instanceof InvalidJsonBodyError) return noStoreJson({ error: "Invalid JSON body" }, { status: 400 });
    return harmonyErrorResponse(error);
  }
}
