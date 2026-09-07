import { NextResponse } from "next/server";
import { invalidateSessionListCache } from "@/lib/session-reader";
import { restoreSession } from "@/lib/session-trash";

// POST /api/sessions/[id]/restore
// Moves the session (and its whole subtree) back from the trash. Used by the
// Undo control in the sidebar and the persistent recycle bin.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const restored = restoreSession(id);
    if (!restored) {
      return NextResponse.json({ error: "Session no longer recoverable" }, { status: 404 });
    }
    invalidateSessionListCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
