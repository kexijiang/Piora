import { getRemoteServerId } from "@/lib/remote-control-store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json({ protocol: "piora.remote.v1", serverId: await getRemoteServerId() }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Remote identity unavailable", code: "REMOTE_IDENTITY_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
