import { NextResponse } from "next/server";
import { InvalidJsonBodyError, JsonBodyTooLargeError, parseJsonWithinLimit } from "@/lib/bounded-json";
import { hasJsonContentType } from "@/lib/request-security";
import { getTerminalSession, TerminalSessionError, validateTerminalCwd } from "@/lib/terminal-session";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 72 * 1024;

function errorResponse(error: unknown): NextResponse {
  if (error instanceof JsonBodyTooLargeError) return NextResponse.json({ error: error.message }, { status: 413 });
  if (error instanceof InvalidJsonBodyError) return NextResponse.json({ error: error.message }, { status: 400 });
  if (error instanceof TerminalSessionError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
}

export async function POST(request: Request) {
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await parseJsonWithinLimit(request, MAX_BODY_BYTES);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TerminalSessionError("Request body must be an object");
    const record = body as Record<string, unknown>;
    const cwd = await validateTerminalCwd(record.cwd);
    const terminal = getTerminalSession(cwd);
    switch (record.action) {
      case "input": terminal.input(record.data, record.replay === true); return NextResponse.json({ success: true });
      case "resize": terminal.resize(record.cols, record.rows); return NextResponse.json({ success: true });
      case "start": return NextResponse.json(terminal.start());
      case "run": return NextResponse.json(terminal.run(record.command));
      case "clear": return NextResponse.json(terminal.clear());
      case "restart": return NextResponse.json(terminal.restart());
      case "stop": return NextResponse.json(terminal.stop());
      default: throw new TerminalSessionError("Unsupported terminal action");
    }
  } catch (error) {
    return errorResponse(error);
  }
}
