import { InvalidJsonBodyError, JsonBodyTooLargeError, parseJsonWithinLimit } from "@/lib/bounded-json";
import { getHarmonyDeviceManager } from "@/lib/harmony";
import { HarmonyError } from "@/lib/harmony/errors";
import { hasJsonContentType } from "@/lib/request-security";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../_shared";

export const dynamic = "force-dynamic";

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9:._-]{1,160}$/.test(value);
}

function validSerial(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:\[\]-]{1,256}$/.test(value);
}

export async function POST(request: Request) {
  const denied = requireHarmonyAccess(request);
  if (denied) return denied;
  if (!hasJsonContentType(request)) return noStoreJson({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const body = await parseJsonWithinLimit(request, 8 * 1024) as Record<string, unknown>;
    const manager = getHarmonyDeviceManager();
    if (body.action === "acquire" || body.action === "takeover") {
      if (!validSerial(body.serial) || !validIdentity(body.ownerId)) {
        throw new HarmonyError("INVALID_ARGUMENT", "A valid serial and ownerId are required");
      }
      if (body.action === "takeover") {
        if (body.confirmed !== true) throw new HarmonyError("INVALID_ARGUMENT", "Explicitly confirm stopping the current controller before taking over");
        await manager.preemptAgentForManual(body.serial);
      }
      const lease = await manager.acquireLease({
        serial: body.serial,
        owner: { kind: "manual", id: body.ownerId },
        ttlMs: 5 * 60_000,
        signal: request.signal,
      });
      return noStoreJson({ lease });
    }
    if (body.action === "renew") {
      if (!validIdentity(body.leaseToken)) throw new HarmonyError("INVALID_ARGUMENT", "A valid leaseToken is required");
      return noStoreJson({ lease: await manager.renewLease(body.leaseToken, 5 * 60_000) });
    }
    if (body.action === "release") {
      if (!validIdentity(body.leaseToken)) throw new HarmonyError("INVALID_ARGUMENT", "A valid leaseToken is required");
      return noStoreJson({ released: manager.releaseLease(body.leaseToken) });
    }
    throw new HarmonyError("INVALID_ARGUMENT", "Unsupported manual lease action");
  } catch (error) {
    if (error instanceof JsonBodyTooLargeError) return noStoreJson({ error: "Request body is too large" }, { status: 413 });
    if (error instanceof InvalidJsonBodyError) return noStoreJson({ error: "Invalid JSON body" }, { status: 400 });
    return harmonyErrorResponse(error);
  }
}
