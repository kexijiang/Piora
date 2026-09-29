import { randomUUID } from "node:crypto";
import { getHarmonyDeviceManager } from "@/lib/harmony";
import { HarmonyError } from "@/lib/harmony/errors";
import type { HarmonyFileScope } from "@/lib/harmony/device-files";
import type { HarmonyTransferInput } from "@/lib/harmony/transfer-jobs";
import { getHarmonyTransferJobs, validateHarmonyTransferItems } from "@/lib/harmony/transfer-runtime";
import { InvalidJsonBodyError, JsonBodyTooLargeError, parseJsonWithinLimit } from "@/lib/bounded-json";
import { hasJsonContentType } from "@/lib/request-security";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  try {
    const serial = new URL(request.url).searchParams.get("serial") ?? undefined;
    if (serial && !/^[A-Za-z0-9._:\[\]-]{1,256}$/.test(serial)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid device serial");
    return noStoreJson({ jobs: getHarmonyTransferJobs().list(serial) });
  } catch (error) { return harmonyErrorResponse(error); }
}

export async function POST(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  if (!hasJsonContentType(request)) return noStoreJson({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const body = await parseJsonWithinLimit(request, 64 * 1024) as Record<string, unknown>;
    if (!body || typeof body.serial !== "string" || !body.scope || typeof body.scope !== "object" || !Array.isArray(body.items)) {
      throw new HarmonyError("INVALID_ARGUMENT", "Choose a device, scope and files");
    }
    const rawScope = body.scope as Record<string, unknown>;
    const scope: HarmonyFileScope = rawScope.kind === "shared" ? { kind: "shared" }
      : rawScope.kind === "sandbox" && typeof rawScope.bundleName === "string" ? { kind: "sandbox", bundleName: rawScope.bundleName }
        : (() => { throw new HarmonyError("INVALID_ARGUMENT", "Invalid device file scope"); })();
    const items = body.items.map((value: unknown): HarmonyTransferInput => {
      if (!value || typeof value !== "object") throw new HarmonyError("INVALID_ARGUMENT", "Invalid transfer item");
      const item = value as Record<string, unknown>;
      if (item.direction === "download") return { direction: "download", path: item.path as string, destinationPath: item.destinationPath as string };
      if (item.direction === "upload") return { direction: "upload", sourcePath: item.sourcePath as string, path: item.path as string, overwrite: item.overwrite as boolean };
      throw new HarmonyError("INVALID_ARGUMENT", "Unknown transfer direction");
    });
    await validateHarmonyTransferItems(scope, items);
    const jobs = getHarmonyTransferJobs();
    const id = randomUUID();
    let taskToken: string | undefined;
    if (items.some(item => item.direction === "upload")) {
      if (typeof body.leaseToken !== "string") throw new HarmonyError("LEASE_REQUIRED", "Acquire manual device control before queuing uploads");
      taskToken = getHarmonyDeviceManager().handoffTransferLease(body.serial, body.leaseToken, id).token;
    }
    let job;
    try { job = jobs.create(body.serial, scope, items, taskToken, id); }
    catch (error) { if (taskToken) getHarmonyDeviceManager().releaseLease(taskToken); throw error; }
    return noStoreJson({ job }, { status: 202 });
  } catch (error) {
    if (error instanceof JsonBodyTooLargeError) return noStoreJson({ error: "Request body is too large" }, { status: 413 });
    if (error instanceof InvalidJsonBodyError) return noStoreJson({ error: "Invalid JSON body" }, { status: 400 });
    return harmonyErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  try {
    const params = new URL(request.url).searchParams;
    const id = params.get("id");
    if (!id || !/^[a-f0-9-]{36}$/.test(id)) throw new HarmonyError("INVALID_ARGUMENT", "Choose a transfer job");
    const jobs = getHarmonyTransferJobs();
    if (params.get("remove") === "1") { jobs.remove(id); return noStoreJson({ removed: true }); }
    return noStoreJson({ job: jobs.cancel(id) });
  } catch (error) { return harmonyErrorResponse(error); }
}
