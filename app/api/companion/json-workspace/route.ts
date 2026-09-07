import { NextResponse } from "next/server";
import { parseJsonWithinLimit } from "@/lib/bounded-json";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { JsonWorkspaceConflict, readJsonWorkspace, writeJsonWorkspace } from "@/lib/json-workspace-storage";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  try { return NextResponse.json(readJsonWorkspace()); }
  catch (error) { return NextResponse.json({ error: String(error) }, { status: 500 }); }
}
export async function PUT(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(request)) return NextResponse.json({ error: "Expected JSON" }, { status: 415 });
  try {
    const body = await parseJsonWithinLimit(request, 16 * 1024 * 1024) as { workbench: unknown; revision: number };
    const next = writeJsonWorkspace(body.workbench, body.revision);
    return NextResponse.json({ revision: next.revision });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: error instanceof JsonWorkspaceConflict ? 409 : 400 }); }
}
