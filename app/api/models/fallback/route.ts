import { NextResponse } from "next/server";
import { parseJsonWithinLimit } from "@/lib/bounded-json";
import { readModelFallbackConfig, writeModelFallbackConfig } from "@/lib/model-fallback-config";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(readModelFallbackConfig(), { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: Request) {
  try {
    const config = writeModelFallbackConfig(await parseJsonWithinLimit(request, 1_024));
    return NextResponse.json(config);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
