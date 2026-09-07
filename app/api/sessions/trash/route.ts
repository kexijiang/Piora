import { NextResponse } from "next/server";
import { listTrashSessions } from "@/lib/session-trash";
import { getAgentRuntimeProfile } from "@/lib/agent-runtime-profile";
import { isSessionVisibleInAgentRuntimeProfile, readAgentProfileStore } from "@/lib/agent-profile-store";

export async function GET() {
  try {
    const profile = getAgentRuntimeProfile();
    const store = readAgentProfileStore();
    return NextResponse.json({ sessions: listTrashSessions().filter((session) => isSessionVisibleInAgentRuntimeProfile(session.id, profile, store)) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
