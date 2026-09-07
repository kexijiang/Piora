import { NextResponse } from "next/server";
import { parseJsonWithinLimit, JsonBodyTooLargeError } from "@/lib/bounded-json";
import { listAllSessions } from "@/lib/session-reader";
import { collectSessionSubtrees } from "@/lib/session-mutation";
import { createUserAncestorResolver } from "@/lib/session-ancestors";
import { getRpcSession } from "@/lib/rpc-manager";
import { readSessionFlags } from "@/lib/session-flags";
import { getAgentRuntimeProfile } from "@/lib/agent-runtime-profile";
import { isSessionVisibleInAgentRuntimeProfile, readAgentProfileStore } from "@/lib/agent-profile-store";

/** Preview only: no session or runtime is changed. */
export async function POST(request: Request) {
  try {
    const body = await parseJsonWithinLimit(request, 512 * 1024) as { ids?: unknown };
    if (!Array.isArray(body?.ids) || !body.ids.length || body.ids.length > 10_000
      || !body.ids.every((id) => typeof id === "string" && /^[a-zA-Z0-9_-]+$/.test(id))) {
      return NextResponse.json({ error: "Expected 1–10000 conversation ids" }, { status: 400 });
    }
    const ids = new Set<string>(body.ids);
    const profile = getAgentRuntimeProfile();
    const store = readAgentProfileStore();
    const all = await listAllSessions();
    const selected = all.filter((session) => ids.has(session.id));
    if (ids.size !== selected.length || selected.some((session) => !isSessionVisibleInAgentRuntimeProfile(session.id, profile, store))) {
      return NextResponse.json({ error: "Conversation no longer available. Refresh and try again." }, { status: 404 });
    }
    const affected = collectSessionSubtrees(all, [...ids]);
    const flags = readSessionFlags();
    const nearestSelected = createUserAncestorResolver(new Map(all.map((session) => [session.id, session.parentSessionId ?? null])), ids);
    const roots = selected.filter((session) => !session.parentSessionId || !nearestSelected(session.parentSessionId));
    // Ancestors first keeps each recoverable subtree in one manifest. Remaining
    // ids cover malformed cycles and are skipped by the client if already moved.
    return NextResponse.json({ rootIds: [...new Set([...roots, ...selected].map((session) => session.id))], sessionIds: affected.map((session) => session.id), count: affected.length,
      running: affected.filter((session) => getRpcSession(session.id)?.isRunning()).length,
      unarchived: affected.filter((session) => !flags[session.id]?.archived).length }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: error instanceof JsonBodyTooLargeError ? 413 : 400 });
  }
}
