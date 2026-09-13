import { assertRemotePrincipalCurrent, requireRemotePrincipal } from "@/lib/remote-control-auth";
import { remoteErrorResponse } from "@/lib/remote-control-response";
import { getSessionMessageRouter } from "@/lib/session-message-router";
import { createRemoteEventsStream } from "@/lib/remote-events-stream";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const principal = requireRemotePrincipal(request, "session.events.read", id);
    const queryCursor = Number(new URL(request.url).searchParams.get("after") ?? "0");
    const headerCursor = Number(request.headers.get("last-event-id") ?? "0");
    const after = Math.max(0, Number.isFinite(queryCursor) ? queryCursor : 0, Number.isFinite(headerCursor) ? headerCursor : 0);
    const router = getSessionMessageRouter();
    const stream = createRemoteEventsStream({
      sessionId: id, after, router, signal: request.signal,
      authorize: () => assertRemotePrincipalCurrent(principal, "session.events.read", id),
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
  } catch (error) {
    return remoteErrorResponse(error);
  }
}
