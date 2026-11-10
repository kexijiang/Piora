import { parseJsonWithinLimit } from "@/lib/bounded-json";
import { localRoomUserAuthor } from "@/lib/room-local-user";
import { getTeamCoordinatorService } from "@/lib/team-coordinator-service";
import { teamApiError } from "@/lib/team-api";
import { TeamError } from "@/lib/team-errors";
import { getTeamRunStore } from "@/lib/team-run-store";
import { TEAM_DEFAULTS } from "@/lib/team-types";
import { requireRoomMemberBySession } from "@/lib/team-agent-api";
import { appendRoomMessage } from "@/lib/room-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { room } = requireRoomMemberBySession(id, new URL(request.url).searchParams.get("sessionId"));
    await getTeamRunStore().migrateLegacyRoomTasks(id, room.coordination.coordinatorMemberId);
    return Response.json({ runs: getTeamRunStore().listTeamRuns(id, { limit: 50 }) });
  } catch (error) { return teamApiError(error); }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await parseJsonWithinLimit(request, 2 * 1024 * 1024) as { objective?: unknown; sessionId?: unknown; idempotencyKey?: unknown };
    if (typeof body.objective !== "string" || typeof body.sessionId !== "string") throw new TeamError("TEAM_INVALID_INPUT", "objective and sessionId are required.");
    if (Buffer.byteLength(body.objective, "utf8") > TEAM_DEFAULTS.maxInputBytes) throw new TeamError("TEAM_INPUT_TOO_LARGE", "Team objective exceeds 256 KiB.");
    const { room } = requireRoomMemberBySession(id, body.sessionId);
    const author = localRoomUserAuthor();
    const state = await getTeamCoordinatorService().createRun({
      roomId: id,
      objective: body.objective,
      coordinatorMemberId: room.coordination.coordinatorMemberId,
      createdBy: { kind: "user", id: author.authorId },
      correlationId: typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined,
    });
    appendRoomMessage(id, {
      ...author,
      content: body.objective,
      correlationId: `team:${state.id}:objective`,
    });
    return Response.json({ run: state }, { status: 201 });
  } catch (error) { return teamApiError(error); }
}
