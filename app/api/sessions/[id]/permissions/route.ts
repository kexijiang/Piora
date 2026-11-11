import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { readToolPermission } from "@/lib/tool-permission-store";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getRpcSession(id) && !await resolveSessionPath(id)) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  return NextResponse.json(readToolPermission(id, getAgentDir()));
}
