import { NextResponse } from "next/server";
import { getAgentRuntimeProfile } from "@/lib/agent-runtime-profile";
import { isSessionVisibleInAgentRuntimeProfile, readAgentProfileStore } from "@/lib/agent-profile-store";
import { searchConversationSessions } from "@/lib/conversation-search";
import { readSessionFlags } from "@/lib/session-flags";
import { listAllSessions } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const runtimeProfile = getAgentRuntimeProfile();
    const profileStore = readAgentProfileStore();
    const sessions = (await listAllSessions()).filter((session) => (
      isSessionVisibleInAgentRuntimeProfile(session.id, runtimeProfile, profileStore)
    ));
    const response = await searchConversationSessions(sessions, readSessionFlags(), {
      query: params.get("q") ?? "",
      project: params.get("project"),
      archive: params.get("archive") as "active" | "archived" | "all" | null ?? undefined,
      limit: Number(params.get("limit") ?? 50),
    }, request.signal);
    return NextResponse.json(response, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
