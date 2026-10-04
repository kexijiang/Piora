import { Readable } from "node:stream";
import { parseJsonWithinLimit } from "@/lib/bounded-json";
import { HarmonyError } from "@/lib/harmony/errors";
import { getHarmonyDatabaseExportJobs } from "@/lib/harmony/database-export-runtime";
import type { HarmonyDatabaseExportInput } from "@/lib/harmony/database-export-jobs";
import { hasJsonContentType } from "@/lib/request-security";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  try {
    const params = new URL(request.url).searchParams;
    const serial = params.get("serial") ?? "";
    if (!serial) throw new HarmonyError("INVALID_ARGUMENT", "Choose a device for database exports");
    const id = params.get("download");
    if (!id) return noStoreJson({ jobs: getHarmonyDatabaseExportJobs().list(serial) });
    const output = await getHarmonyDatabaseExportJobs().openDownload(id, serial);
    return new Response(Readable.toWeb(output.stream) as ReadableStream, { headers: {
      "Content-Type": output.format === "csv" ? `text/csv; charset=${output.encoding === "utf-16le" ? "utf-16le" : "utf-8"}` : "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${output.filename}"`,
      "Content-Length": String(output.size), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) { return harmonyErrorResponse(error); }
}

export async function POST(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  if (!hasJsonContentType(request)) return noStoreJson({ error: "JSON required" }, { status: 415 });
  try {
    const body = await parseJsonWithinLimit(request, 16 * 1024) as Record<string, unknown>;
    if (!body || body.action !== "create" || typeof body.serial !== "string" || typeof body.snapshotId !== "string"
      || typeof body.source !== "string" || (body.format !== "csv" && body.format !== "json")
      || (body.table !== undefined && typeof body.table !== "string") || (body.sql !== undefined && typeof body.sql !== "string")
      || !body.options || typeof body.options !== "object"
      || (body.destinationPath !== undefined && typeof body.destinationPath !== "string")) {
      throw new HarmonyError("INVALID_ARGUMENT", "Choose a verified snapshot, export format, range and encoding");
    }
    const job = await getHarmonyDatabaseExportJobs().create(body as unknown as HarmonyDatabaseExportInput);
    return noStoreJson({ job }, { status: 202 });
  } catch (error) { return harmonyErrorResponse(error); }
}

export async function DELETE(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  try {
    const params = new URL(request.url).searchParams;
    const serial = params.get("serial") ?? "", id = params.get("id") ?? "";
    if (!serial || !id) throw new HarmonyError("INVALID_ARGUMENT", "Choose a device and database export job");
    const jobs = getHarmonyDatabaseExportJobs();
    if (params.get("remove") === "1") { await jobs.remove(id, serial); return noStoreJson({ removed: true }); }
    return noStoreJson({ job: jobs.cancel(id, serial) });
  } catch (error) { return harmonyErrorResponse(error); }
}
