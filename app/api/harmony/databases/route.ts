import { cancelDeviceDatabaseScan, databaseIdForDevicePath, deviceDatabaseCatalog, openDeviceDatabase } from "@/lib/harmony/device-databases";
import { assertHarmonySqliteSnapshotOwner, closeHarmonySqliteSnapshot, exportHarmonySqliteSnapshot, readHarmonySqliteSnapshot, type HarmonySqliteExportOptions } from "@/lib/harmony/sqlite-inspector";
import { HarmonyError } from "@/lib/harmony/errors";
import { parseJsonWithinLimit } from "@/lib/bounded-json";
import { hasJsonContentType } from "@/lib/request-security";
import { Readable } from "node:stream";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  try {
    const params = new URL(request.url).searchParams;
    return noStoreJson(deviceDatabaseCatalog(params.get("serial") ?? "", params.get("refresh") === "1"));
  } catch (error) { return harmonyErrorResponse(error); }
}

export async function POST(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  if (!hasJsonContentType(request)) return noStoreJson({ error: "JSON required" }, { status: 415 });
  try {
    const body = await parseJsonWithinLimit(request, 8 * 1024) as Record<string, unknown>;
    if (!body || typeof body !== "object") throw new HarmonyError("INVALID_ARGUMENT", "Choose a database action");
    if (body.action === "cancel_scan" && typeof body.serial === "string" && typeof body.startedAt === "string") {
      cancelDeviceDatabaseScan(body.serial, body.startedAt);
      return noStoreJson({ cancelled: true });
    }
    if (body.action === "resolve" && typeof body.serial === "string" && typeof body.bundleName === "string" && typeof body.path === "string") {
      return noStoreJson({ databaseId: databaseIdForDevicePath(body.serial, body.bundleName, body.path) ?? null });
    }
    if (body.action === "open" && typeof body.serial === "string" && typeof body.databaseId === "string") {
      return noStoreJson(await openDeviceDatabase(body.serial, body.databaseId, request.signal));
    }
    if (body.action === "close" && typeof body.id === "string" && typeof body.serial === "string") {
      assertHarmonySqliteSnapshotOwner(body.id, body.serial);
      await closeHarmonySqliteSnapshot(body.id);
      return noStoreJson({ closed: true });
    }
    if (body.action === "read" && typeof body.id === "string" && typeof body.serial === "string") {
      assertHarmonySqliteSnapshotOwner(body.id, body.serial);
      const { table, sql, offset = 0 } = body;
      if ((table !== undefined && typeof table !== "string") || (sql !== undefined && typeof sql !== "string") || typeof offset !== "number") {
        throw new HarmonyError("INVALID_ARGUMENT", "Choose a table or read-only query and numeric offset");
      }
      const started = Date.now();
      const result = await readHarmonySqliteSnapshot(body.id, table as string | undefined, offset, sql as string | undefined, request.signal);
      return noStoreJson({ result, durationMs: Date.now() - started });
    }
    if (body.action === "export" && typeof body.id === "string" && typeof body.serial === "string" && (body.format === "csv" || body.format === "json")) {
      assertHarmonySqliteSnapshotOwner(body.id, body.serial);
      const { table, sql } = body;
      if ((table !== undefined && typeof table !== "string") || (sql !== undefined && typeof sql !== "string")) {
        throw new HarmonyError("INVALID_ARGUMENT", "Choose a table or read-only query to export");
      }
      const options = { range: body.range ?? "all", offset: body.offset ?? 0, encoding: body.encoding ?? "utf-8" } as HarmonySqliteExportOptions;
      const { stream, filename, size } = await exportHarmonySqliteSnapshot(body.id, table as string | undefined, sql as string | undefined, body.format, options, request.signal);
      return new Response(Readable.toWeb(stream) as ReadableStream, { headers: {
        "Content-Type": body.format === "csv" ? `text/csv; charset=${options.encoding === "utf-16le" ? "utf-16le" : "utf-8"}` : "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(size), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
      } });
    }
    throw new HarmonyError("INVALID_ARGUMENT", "Choose open, read, export or close with the required fields");
  } catch (error) { return harmonyErrorResponse(error); }
}
