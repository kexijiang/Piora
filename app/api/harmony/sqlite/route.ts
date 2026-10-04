import { assertHarmonySqliteSnapshotOwner, closeHarmonySqliteSnapshot, exportHarmonySqliteSnapshot, inspectHarmonySqlite, openHarmonySqliteSnapshot, readHarmonySqliteSnapshot } from "@/lib/harmony/sqlite-inspector";
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
    const offsetText = params.get("offset") ?? "0";
    const offset = /^\d{1,5}$/.test(offsetText) ? Number(offsetText) : Number.NaN;
    return noStoreJson({ result: await inspectHarmonySqlite(params.get("path") ?? "", params.get("table") ?? undefined, offset, undefined, request.signal) });
  } catch (error) { return harmonyErrorResponse(error); }
}

export async function POST(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  if (!hasJsonContentType(request)) return noStoreJson({ error: "JSON required" }, { status: 415 });
  try {
    const body = await parseJsonWithinLimit(request, 8 * 1024) as Record<string, unknown>;
    if (!body || typeof body !== "object") throw new HarmonyError("INVALID_ARGUMENT", "Choose a database action");
    if (body.action === "open" && typeof body.path === "string") return noStoreJson(await openHarmonySqliteSnapshot(body.path));
    if (body.action === "close" && typeof body.id === "string") {
      assertHarmonySqliteSnapshotOwner(body.id);
      await closeHarmonySqliteSnapshot(body.id);
      return noStoreJson({ closed: true });
    }
    if (body.action === "read" && typeof body.id === "string") {
      assertHarmonySqliteSnapshotOwner(body.id);
      const table = body.table === undefined ? undefined : body.table;
      const sql = body.sql === undefined ? undefined : body.sql;
      const offset = body.offset === undefined ? 0 : body.offset;
      if ((table !== undefined && typeof table !== "string") || (sql !== undefined && typeof sql !== "string") || typeof offset !== "number") {
        throw new HarmonyError("INVALID_ARGUMENT", "Choose a table or read-only query and numeric offset");
      }
      return noStoreJson({ result: await readHarmonySqliteSnapshot(body.id, table, offset, sql, request.signal) });
    }
    if (body.action === "export" && typeof body.id === "string" && (body.format === "csv" || body.format === "json")) {
      assertHarmonySqliteSnapshotOwner(body.id);
      const table = body.table === undefined ? undefined : body.table;
      const sql = body.sql === undefined ? undefined : body.sql;
      if ((table !== undefined && typeof table !== "string") || (sql !== undefined && typeof sql !== "string")) {
        throw new HarmonyError("INVALID_ARGUMENT", "Choose a table or read-only query to export");
      }
      const { stream, filename, size } = await exportHarmonySqliteSnapshot(body.id, table, sql, body.format, undefined, request.signal);
      return new Response(Readable.toWeb(stream) as ReadableStream, { headers: {
        "Content-Type": body.format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(size),
        "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
      } });
    }
    throw new HarmonyError("INVALID_ARGUMENT", "Choose open, read, export or close with the required fields");
  } catch (error) { return harmonyErrorResponse(error); }
}
