import { NextResponse } from "next/server";
import { parseJsonWithinLimit } from "@/lib/bounded-json";
import { readBetaFeatures, writeBetaFeatures } from "@/lib/beta-features";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export async function GET() {
  return NextResponse.json(readBetaFeatures(), { headers: { "Cache-Control": "no-store" } });
}
export async function PUT(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(request)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    return NextResponse.json(writeBetaFeatures(await parseJsonWithinLimit(request, 1_024)));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
