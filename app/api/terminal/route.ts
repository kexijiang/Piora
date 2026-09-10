import { NextResponse } from "next/server";
import { InvalidJsonBodyError, JsonBodyTooLargeError, parseJsonWithinLimit } from "@/lib/bounded-json";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { TerminalSessionError, isTerminalSessionError } from "@/lib/terminal-session";
import { isShellError } from "@/lib/shell/errors";
import { getLegacyTerminal, legacyTerminalAction } from "@/lib/shell/legacy";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 72 * 1024;

function errorResponse(error: unknown): NextResponse {
  if (error instanceof JsonBodyTooLargeError) return NextResponse.json({ error: error.message }, { status: 413 });
  if (error instanceof InvalidJsonBodyError) return NextResponse.json({ error: error.message }, { status: 400 });
  if (isTerminalSessionError(error) || isShellError(error)) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
}

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await parseJsonWithinLimit(request, MAX_BODY_BYTES);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TerminalSessionError("Request body must be an object");
    const record = body as Record<string, unknown>;
    const terminal = await getLegacyTerminal(record.cwd);
    return NextResponse.json(await legacyTerminalAction(terminal, record));
  } catch (error) {
    return errorResponse(error);
  }
}
