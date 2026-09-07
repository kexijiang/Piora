import { NextResponse } from "next/server";
import { InvalidJsonBodyError, JsonBodyTooLargeError, parseJsonWithinLimit } from "@/lib/bounded-json";
import { getCompanionStorageInfo, updateCompanionStorageDirectory } from "@/lib/companion-storage";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getPocketStorageInfo, isPocketStorageScope, updatePocketStorageDirectory } from "@/lib/pocket-storage";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  const requested = new URL(request.url).searchParams.get("scope");
  const scope = isPocketStorageScope(requested) ? requested : null;
  if (requested && !scope) return NextResponse.json({ error: "Invalid storage scope" }, { status: 400 });
  try { return NextResponse.json({ storage: scope ? getPocketStorageInfo(scope) : getCompanionStorageInfo() }); }
  catch (error) { return NextResponse.json({ error: String(error) }, { status: 500 }); }
}

export async function PUT(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(request)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const body = await parseJsonWithinLimit(request, 8 * 1024) as { directory?: unknown };
    if (typeof body.directory !== "string") {
      return NextResponse.json({ error: "Companion storage directory is required" }, { status: 400 });
    }
    const requested = new URL(request.url).searchParams.get("scope");
    const scope = isPocketStorageScope(requested) ? requested : null;
    if (requested && !scope) throw new Error("Invalid storage scope");
    return NextResponse.json({ storage: scope ? updatePocketStorageDirectory(scope, body.directory) : updateCompanionStorageDirectory(body.directory) });
  } catch (error) {
    if (error instanceof JsonBodyTooLargeError) return NextResponse.json({ error: "Request body is too large" }, { status: 413 });
    if (error instanceof InvalidJsonBodyError) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
