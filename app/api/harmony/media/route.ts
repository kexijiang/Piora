import { InvalidJsonBodyError, JsonBodyTooLargeError, parseJsonWithinLimit } from "@/lib/bounded-json";
import { getHarmonyDeviceManager } from "@/lib/harmony";
import { resolveHarmonyStorage } from "@/lib/harmony/artifacts";
import { HarmonyError } from "@/lib/harmony/errors";
import { hasJsonContentType } from "@/lib/request-security";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../_shared";

export const dynamic = "force-dynamic";

function requiredString(body: Record<string, unknown>, key: string, maximum = 256): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new HarmonyError("INVALID_ARGUMENT", `${key} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

function optionalString(body: Record<string, unknown>, key: string, maximum = 256): string | undefined {
  const value = body[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new HarmonyError("INVALID_ARGUMENT", `${key} must be a non-empty string of at most ${maximum} characters when provided`);
  }
  return value;
}

export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request);
  if (denied) return denied;
  try {
    const manager = getHarmonyDeviceManager();
    const serial = new URL(request.url).searchParams.get("serial")?.trim();
    const recording = serial ? manager.getRecordingState(serial) : undefined;
    return noStoreJson({
      recording: recording ? {
        serial: recording.serial,
        recordingId: recording.recordingId,
        startedAt: recording.startedAt,
        ownerId: recording.ownerId,
        method: recording.method ?? "stream",
        ...(recording.systemRecorderStateUnknown ? { systemRecorderStateUnknown: true } : {}),
      } : null,
      storage: resolveHarmonyStorage(manager.getConfig()),
    });
  } catch (error) {
    return harmonyErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const denied = requireHarmonyAccess(request);
  if (denied) return denied;
  if (!hasJsonContentType(request)) return noStoreJson({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const body = await parseJsonWithinLimit(request, 8 * 1024) as Record<string, unknown>;
    const serial = requiredString(body, "serial", 256);
    const manager = getHarmonyDeviceManager();
    if (body.action === "capture_screenshot") {
      const artifact = await manager.captureScreenshotArtifact({ serial, signal: request.signal });
      return noStoreJson({ artifact });
    }
    const ownerId = requiredString(body, "ownerId", 160);
    const leaseToken = optionalString(body, "leaseToken", 256);
    if (body.action === "start_recording") {
      const recording = await manager.startRecording({ serial, ownerId, ...(leaseToken ? { leaseToken } : {}), signal: request.signal });
      return noStoreJson({ recording: {
        serial: recording.serial,
        recordingId: recording.recordingId,
        startedAt: recording.startedAt,
        ownerId: recording.ownerId,
        method: recording.method ?? "stream",
        ...(recording.systemRecorderStateUnknown ? { systemRecorderStateUnknown: true } : {}),
      } });
    }
    if (body.action === "stop_recording") {
      const recordingId = optionalString(body, "recordingId", 64);
      const artifact = await manager.stopRecording({ serial, ownerId, ...(leaseToken ? { leaseToken } : {}),
        ...(recordingId ? { recordingId } : {}), signal: request.signal });
      return noStoreJson({ artifact });
    }
    if (body.action === "retrieve_recording") {
      // Retrieval only, after the user stopped an unconfirmed system recording on the phone.
      const recordingId = optionalString(body, "recordingId", 64);
      const artifact = await manager.retrieveRecording({ serial, ownerId, ...(leaseToken ? { leaseToken } : {}),
        ...(recordingId ? { recordingId } : {}), signal: request.signal });
      return noStoreJson({ artifact });
    }
    if (body.action === "abandon_recording") {
      // PC-side only: forgets the unconfirmed recording; the phone gallery copy stays untouched.
      const recordingId = optionalString(body, "recordingId", 64);
      await manager.abandonRecording({ serial, ownerId, ...(leaseToken ? { leaseToken } : {}),
        ...(recordingId ? { recordingId } : {}), signal: request.signal });
      return noStoreJson({ abandoned: true });
    }
    throw new HarmonyError("INVALID_ARGUMENT", "Unsupported Harmony media action");
  } catch (error) {
    if (error instanceof JsonBodyTooLargeError) return noStoreJson({ error: "Request body is too large" }, { status: 413 });
    if (error instanceof InvalidJsonBodyError) return noStoreJson({ error: "Invalid JSON body" }, { status: 400 });
    return harmonyErrorResponse(error);
  }
}
