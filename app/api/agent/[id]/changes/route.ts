import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { readPromptFileChanges } from "@/lib/prompt-file-changes";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getRpcSession(id)?.isAlive() && !await resolveSessionPath(id)) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  return NextResponse.json(await readPromptFileChanges(id));
}
