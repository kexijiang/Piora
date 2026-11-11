import { refreshLiveToolApprovals } from "@/lib/rpc-manager";
import { NextResponse } from "next/server";
import { readToolApprovalSettings, writeToolApprovalSettings } from "@/lib/tool-approval-settings";
import { InvalidJsonBodyError, JsonBodyTooLargeError, parseJsonWithinLimit } from "@/lib/bounded-json";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
export async function GET() {
  try { return NextResponse.json(readToolApprovalSettings(), { headers }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500, headers }); }
}

export async function PUT(request: Request) {
  try {
    const settings = writeToolApprovalSettings(await parseJsonWithinLimit(request, 1_024));
    refreshLiveToolApprovals();
    return NextResponse.json(settings, { headers });
  }
  catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, {
      status: error instanceof JsonBodyTooLargeError ? 413 : error instanceof TypeError || error instanceof InvalidJsonBodyError ? 400 : 500, headers,
    });
  }
}
