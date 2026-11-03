import { parseJsonWithinLimit } from "@/lib/bounded-json";
import { requireRoomMemberBySession } from "@/lib/team-agent-api";
import { teamApiError } from "@/lib/team-api";
import { TeamError } from "@/lib/team-errors";
import { listRoomMessages } from "@/lib/room-store";
import { drainRoomSubmissions, listRoomSubmissions, submitRoomMessage, type RoomSubmissionInput } from "@/lib/room-submissions";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const query = new URL(request.url).searchParams;
    requireRoomMemberBySession(id, query.get("sessionId"));
    // Classification can wait on several providers. Keep history/recovery
    // readable while its durable submission is being processed.
    void drainRoomSubmissions(id).catch(() => {});
    const messages = listRoomMessages(id, { afterSeq: Number(query.get("afterSeq")) || 0, beforeSeq: query.has("beforeSeq") ? Number(query.get("beforeSeq")) : undefined, limit: 500 });
    return Response.json({ messages, submissions: listRoomSubmissions(id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return teamApiError(error); }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await parseJsonWithinLimit(request, 512 * 1024) as RoomSubmissionInput;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TeamError("TEAM_INVALID_INPUT", "消息格式无效。");
    requireRoomMemberBySession(id, body.sessionId);
    const { message, submission } = await submitRoomMessage(id, body, undefined, true);
    const { input: _input, requestHash: _hash, ...receipt } = submission as typeof submission & { input?: unknown; requestHash?: string };
    void _input; void _hash;
    return Response.json({ message, submission: receipt }, { status: 201 });
  } catch (error) { return teamApiError(error); }
}
