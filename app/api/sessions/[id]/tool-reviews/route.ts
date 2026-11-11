import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import { inactiveToolReviews } from "@/lib/tool-review-store";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  const { id } = await params;
  if (!/^[\w-]{1,128}$/.test(id)) return NextResponse.json({ error: "Invalid session id" }, { status: 400 });
  const session = getRpcSession(id);
  if (!session?.isAlive() && !await resolveSessionPath(id)) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  const reviews = session?.isAlive() ? ((await session.send({ type: "get_state" })) as { toolReviews: unknown }).toolReviews : inactiveToolReviews(getAgentDir(), id);
  return NextResponse.json({ reviews }, { headers: { "Cache-Control": "no-store" } });
}
