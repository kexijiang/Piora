import type { SessionEntry } from "@/lib/types";
import { requireRemotePrincipal } from "@/lib/remote-control-auth";
import { remoteErrorResponse } from "@/lib/remote-control-response";
import { buildSessionContext } from "@/lib/session-reader";
import { resolveOrStartRpcSession } from "@/lib/session-runtime-resolver";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    requireRemotePrincipal(request, "session.history.read", id);
    const { session } = await resolveOrStartRpcSession(id);
    const manager = session.inner.sessionManager;
    const context = buildSessionContext(
      manager.getEntries() as unknown as SessionEntry[],
      manager.getLeafId(),
      { deferToolResultImages: new URL(request.url).searchParams.get("includeMedia") !== "true" },
    );
    return Response.json({
      sessionId: id,
      remotePolicy: session.remotePolicy,
      leafId: manager.getLeafId(),
      messages: context.messages,
      entryIds: context.entryIds,
      model: context.model,
      thinkingLevel: context.thinkingLevel,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return remoteErrorResponse(error);
  }
}
