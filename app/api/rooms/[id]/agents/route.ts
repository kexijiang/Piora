import { randomUUID } from "node:crypto";
import { parseJsonWithinLimit } from "@/lib/bounded-json";
import { createRoomChatProfile, validateTeamAgentProfile } from "@/lib/team-agent-templates";
import { requireRoomCoordinatorBySession, requireRoomMemberBySession } from "@/lib/team-agent-api";
import { provisionTeamAgentSession, resolveProvisionableTeamAgentProfile, rollbackProvisionedTeamAgentSession } from "@/lib/team-agent-provisioner";
import { teamApiError } from "@/lib/team-api";
import { addManagedRoomMember, removeRoomMember } from "@/lib/room-store";
import type { CollaborationRoomV3, TeamAgentBinding, TeamAgentProfile, TeamAgentRole } from "@/lib/team-types";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { room } = requireRoomMemberBySession(id, new URL(request.url).searchParams.get("sessionId"));
    return Response.json({ agents: room.members });
  } catch (error) { return teamApiError(error); }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let provisioned: { room: CollaborationRoomV3; binding: TeamAgentBinding; requesterSessionId: string; memberAdded: boolean } | undefined;
  try {
    const { id } = await params;
    const body = await parseJsonWithinLimit(request, 256 * 1024) as { sessionId?: unknown; role?: unknown; name?: unknown; roleDescription?: unknown; profile?: unknown };
    const { room, member: requester } = requireRoomCoordinatorBySession(id, body.sessionId);
    const role = typeof body.role === "string" ? body.role as TeamAgentRole : undefined;
    const requestedProfile = body.profile
      ? validateTeamAgentProfile({ ...body.profile as TeamAgentProfile, ...(role ? { role } : {}) })
      : createRoomChatProfile({
        role: role ?? "participant",
        name: typeof body.name === "string" && body.name.trim() ? body.name : "新成员",
        roleDescription: typeof body.roleDescription === "string" ? body.roleDescription : undefined,
      });
    const profile = await resolveProvisionableTeamAgentProfile(room, requestedProfile);
    const memberId = randomUUID();
    const binding = await provisionTeamAgentSession(room, profile, memberId);
    provisioned = { room, binding, requesterSessionId: requester.binding.sessionId, memberAdded: false };
    const saved = addManagedRoomMember(id, {
      memberId,
      profile,
      binding,
      requestedBy: requester.binding.sessionId,
    });
    provisioned.memberAdded = true;
    if (profile.role === "coordinator") provisioned.requesterSessionId = binding.sessionId;
    provisioned = undefined;
    return Response.json({ room: saved, agent: saved.members.find((candidate) => candidate.memberId === memberId) }, { status: 201 });
  } catch (error) {
    if (provisioned) {
      if (provisioned.memberAdded) {
        try { removeRoomMember(provisioned.room.id, provisioned.binding.sessionId, provisioned.requesterSessionId); } catch { /* Preserve the original provisioning error. */ }
      }
      await rollbackProvisionedTeamAgentSession(provisioned.room, provisioned.binding);
    }
    return teamApiError(error);
  }
}
