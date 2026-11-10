import { listAllSessions } from "@/lib/session-reader";
import { ensureRoomSessionIsolation } from "@/lib/room-session-isolation";
import { resolveProject } from "@/lib/worktree";
import type { TeamAgentBinding } from "@/lib/team-types";
import { parseJsonWithinLimit } from "@/lib/bounded-json";
import { requireRoomCoordinatorBySession } from "@/lib/team-agent-api";
import { disposeManagedTeamAgentSession } from "@/lib/team-agent-provisioner";
import { teamApiError } from "@/lib/team-api";
import { removeRoomMember, updateRoomAgentProfile } from "@/lib/room-store";
import { TeamError } from "@/lib/team-errors";
import type { TeamAgentProfile } from "@/lib/team-types";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; memberId: string }> }) {
  try {
    const { id, memberId } = await params;
    const body = await parseJsonWithinLimit(request, 256 * 1024) as { sessionId?: unknown; expectedRevision?: unknown; patch?: unknown; targetSessionId?: unknown };
    const { room: currentRoom, member } = requireRoomCoordinatorBySession(id, body.sessionId);
    if (!Number.isInteger(body.expectedRevision) || !body.patch || typeof body.patch !== "object") {
      throw new TeamError("TEAM_INVALID_INPUT", "expectedRevision and profile patch are required.");
    }
    let binding: Pick<TeamAgentBinding, "sessionId" | "cwd" | "projectRoot" | "worktreeBranch"> | undefined;
    const current = currentRoom.members.find(candidate => candidate.memberId === memberId);
    if (body.targetSessionId !== undefined && body.targetSessionId !== current?.binding.sessionId) {
      if (typeof body.targetSessionId !== "string" || !body.targetSessionId) throw new TeamError("TEAM_INVALID_INPUT", "Invalid target session.");
      const session = (await listAllSessions()).find(candidate => candidate.id === body.targetSessionId);
      if (!session) throw new TeamError("TEAM_INVALID_INPUT", "The selected session no longer exists.");
      const project = await resolveProject(session.cwd);
      binding = { sessionId: session.id, cwd: session.cwd, projectRoot: project.projectRoot, worktreeBranch: project.isWorktree ? project.branch ?? undefined : undefined };
    }
    updateRoomAgentProfile(id, member.binding.sessionId, memberId, body.expectedRevision as number, body.patch as Partial<TeamAgentProfile>, binding);
    const room = ensureRoomSessionIsolation(id);
    return Response.json({ room, agent: room.members.find((candidate) => candidate.memberId === memberId) });
  } catch (error) { return teamApiError(error); }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string; memberId: string }> }) {
  try {
    const { id, memberId } = await params;
    const body = await parseJsonWithinLimit(request, 32 * 1024) as { sessionId?: unknown; disposeManaged?: unknown };
    const { room, member: requester } = requireRoomCoordinatorBySession(id, body.sessionId);
    const target = room.members.find((candidate) => candidate.memberId === memberId);
    if (!target) throw new TeamError("TEAM_MEMBER_NOT_FOUND", "Team Agent was not found.");
    if (body.disposeManaged === true) await disposeManagedTeamAgentSession(room, memberId);
    const saved = removeRoomMember(id, target.binding.sessionId, requester.binding.sessionId);
    return Response.json({ room: saved });
  } catch (error) { return teamApiError(error); }
}
