import { getRemoteControlConnector } from "@/lib/remote-control-connector";
import { getSessionMessageRouter } from "@/lib/session-message-router";
import { getRemoteServerId } from "@/lib/remote-control-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const sessionId = new URL(request.url).searchParams.get("sessionId");
  return Response.json({ serverId: await getRemoteServerId(), connector: getRemoteControlConnector().getStatus(), ...(sessionId ? { state: await getSessionMessageRouter().getState(sessionId) } : {}) }, { headers: { "Cache-Control": "no-store" } });
}
