import { inspectHarmonySqlite } from "@/lib/harmony/sqlite-inspector";
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
