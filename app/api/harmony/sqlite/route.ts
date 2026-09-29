import { closeHarmonySqliteSnapshot, inspectHarmonySqlite, openHarmonySqliteSnapshot, readHarmonySqliteSnapshot } from "@/lib/harmony/sqlite-inspector";
import { HarmonyError } from "@/lib/harmony/errors";
import { parseJsonWithinLimit } from "@/lib/bounded-json";
import { hasJsonContentType } from "@/lib/request-security";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  try {
    const params = new URL(request.url).searchParams;
    const offsetText = params.get("offset") ?? "0";
    const offset = /^\d{1,5}$/.test(offsetText) ? Number(offsetText) : Number.NaN;
    return noStoreJson({ result: await inspectHarmonySqlite(params.get("path") ?? "", params.get("table") ?? undefined, offset) });
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
      await closeHarmonySqliteSnapshot(body.id);
      return noStoreJson({ closed: true });
    }
    if (body.action === "read" && typeof body.id === "string") {
      const table = body.table === undefined ? undefined : body.table;
      const sql = body.sql === undefined ? undefined : body.sql;
      const offset = body.offset === undefined ? 0 : body.offset;
      if ((table !== undefined && typeof table !== "string") || (sql !== undefined && typeof sql !== "string") || typeof offset !== "number") {
        throw new HarmonyError("INVALID_ARGUMENT", "Choose a table or read-only query and numeric offset");
      }
      return noStoreJson({ result: await readHarmonySqliteSnapshot(body.id, table, offset, sql) });
    }
    throw new HarmonyError("INVALID_ARGUMENT", "Choose open, read or close with the required fields");
  } catch (error) { return harmonyErrorResponse(error); }
}
