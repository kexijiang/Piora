import { requireRemotePrincipal, assertRemotePrincipalCurrent } from "@/lib/remote-control-auth";
import { remoteErrorResponse } from "@/lib/remote-control-response";
import { getSessionMessageRouter } from "@/lib/session-message-router";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const principal = requireRemotePrincipal(request, "session.abort");
    const { id } = await params;
    const router = getSessionMessageRouter();
    const command = await router.getCommand(id);
    assertRemotePrincipalCurrent(principal, "session.abort", command.targetSessionId);
    const receipt = await router.cancelCommand(id, principal);
    return Response.json(receipt, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return remoteErrorResponse(error);
  }
}
