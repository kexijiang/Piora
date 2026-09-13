import { requireRemotePrincipal, assertRemotePrincipalCurrent } from "@/lib/remote-control-auth";
import { remoteErrorResponse } from "@/lib/remote-control-response";
import { resolveOrStartRpcSession } from "@/lib/session-runtime-resolver";
import { createRemoteContentStream } from "@/lib/remote-content-stream";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const principal = requireRemotePrincipal(request, "session.history.read", id);
    requireRemotePrincipal(request, "session.events.read", id);
    const { session } = await resolveOrStartRpcSession(id);
    const stream = createRemoteContentStream({
      signal: request.signal,
      alive: () => session.isAlive(),
      authorize: () => {
        assertRemotePrincipalCurrent(principal, "session.history.read", id);
        assertRemotePrincipalCurrent(principal, "session.events.read", id);
      },
      snapshot: () => session.getRemoteContentSnapshot(),
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no", Connection: "keep-alive" } });
  } catch (error) { return remoteErrorResponse(error); }
}
