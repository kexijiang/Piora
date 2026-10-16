import { readBrowserUserWait, resolveBrowserUserWait } from "@/lib/browser-user-wait";
import { getRpcSession } from "@/lib/rpc-manager";
import { isValidSessionId } from "@/lib/session-file-references-core";
import { resolveSessionPath } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

async function requireSession(id: string): Promise<Response | null> {
  if (!isValidSessionId(id)) return Response.json({ error: "Invalid session id" }, { status: 400 });
  if (!getRpcSession(id)?.isAlive() && !await resolveSessionPath(id)) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }
  return null;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const invalid = await requireSession(id);
  if (invalid) return invalid;
  return Response.json({ wait: readBrowserUserWait(id) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidSessionId(id)) return Response.json({ error: "Invalid session id" }, { status: 400 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const decision = body && typeof body === "object" ? (body as { decision?: unknown }).decision : undefined;
  if (decision !== "continue" && decision !== "cancel") {
    return Response.json({ error: "decision must be continue or cancel" }, { status: 400 });
  }
  const invalid = await requireSession(id);
  if (invalid) return invalid;
  if (!resolveBrowserUserWait(id, decision)) {
    return Response.json({ error: "No browser wait is active" }, { status: 404 });
  }
  return Response.json({ ok: true, status: decision === "continue" ? "continued" : "cancelled" });
}
