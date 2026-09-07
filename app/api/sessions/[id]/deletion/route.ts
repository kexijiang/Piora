import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";
import { collectSessionSubtree } from "@/lib/session-mutation";
import { getRpcSession } from "@/lib/rpc-manager";
import { getAgentRuntimeProfile } from "@/lib/agent-runtime-profile";
import { isSessionVisibleInAgentRuntimeProfile, readAgentProfileStore } from "@/lib/agent-profile-store";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSessionVisibleInAgentRuntimeProfile(id, getAgentRuntimeProfile(), readAgentProfileStore())) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  const sessions = collectSessionSubtree(await listAllSessions(), id);
  if (!sessions.length) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  return NextResponse.json({ sessionIds: sessions.map((session) => session.id), count: sessions.length, running: sessions.filter((session) => getRpcSession(session.id)?.isRunning()).length }, { headers: { "Cache-Control": "no-store" } });
}
