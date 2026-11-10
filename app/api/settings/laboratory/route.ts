import { NextResponse } from "next/server";
import { readLaboratorySettings, writeLaboratorySettings } from "@/lib/laboratory-settings";
import { InvalidJsonBodyError, JsonBodyTooLargeError, parseJsonWithinLimit } from "@/lib/bounded-json";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
export async function GET() {
  try { return NextResponse.json(readLaboratorySettings(), { headers }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500, headers }); }
}

export async function PUT(request: Request) {
  try { return NextResponse.json(writeLaboratorySettings(await parseJsonWithinLimit(request, 1_024)), { headers }); }
  catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, {
      status: error instanceof JsonBodyTooLargeError ? 413 : error instanceof TypeError || error instanceof InvalidJsonBodyError ? 400 : 500, headers,
    });
  }
}
