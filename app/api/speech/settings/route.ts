import { NextResponse } from "next/server";
import { InvalidJsonBodyError, JsonBodyTooLargeError, parseJsonWithinLimit } from "@/lib/bounded-json";
import { getSpeechStatus, updateSpeechSettings } from "@/lib/speech-pack-manager";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return json({ error: "Untrusted API request" }, 403);
  return json(await getSpeechStatus());
}

export async function PATCH(request: Request) {
  if (!isApiRequestAllowed(request)) return json({ error: "Untrusted API request" }, 403);
  if (!hasJsonContentType(request)) return json({ error: "Expected application/json" }, 415);
  try {
    const body = await parseJsonWithinLimit(request, 8 * 1024) as Record<string, unknown>;
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      return json({ error: "enabled must be a boolean" }, 400);
    }
    if (body.packDirectory !== undefined && body.packDirectory !== null && typeof body.packDirectory !== "string") {
      return json({ error: "packDirectory must be an absolute path or null" }, 400);
    }
    const { resetLocalSpeechRuntime, warmLocalSpeechRuntime } = await import("@/lib/speech-runtime");
    resetLocalSpeechRuntime();
    const status = await updateSpeechSettings({
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
      ...(body.packDirectory === null || typeof body.packDirectory === "string"
        ? { packDirectory: body.packDirectory }
        : {}),
    });
    if (status.available) void warmLocalSpeechRuntime().catch(() => {});
    return json(status);
  } catch (error) {
    if (error instanceof JsonBodyTooLargeError) return json({ error: "Request body is too large" }, 413);
    if (error instanceof InvalidJsonBodyError) return json({ error: "Invalid JSON body" }, 400);
    return json({ error: error instanceof Error ? error.message : "Unable to update speech settings" }, 400);
  }
}
