import { NextResponse } from "next/server";
import { addRoomMember, createRoom, listRooms } from "@/lib/room-store";
import type { RoomMemberRole } from "@/lib/room-types";
import { resolveProject } from "@/lib/worktree";
import { createManagedRoom, type ManagedRoomInput } from "@/lib/room-creation";
import { listRoomMessages } from "@/lib/room-store";
import { getTeamRunStore } from "@/lib/team-run-store";
import { teamApiError } from "@/lib/team-api";
import { parseJsonWithinLimit } from "@/lib/bounded-json";
import { ensureRoomSessionIsolation } from "@/lib/room-session-isolation";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const sessionId = new URL(request.url).searchParams.get("sessionId") ?? undefined;
    const rooms = listRooms(sessionId).map((snapshot) => {
      const room = ensureRoomSessionIsolation(snapshot.id);
      const lastMessage = listRoomMessages(room.id, { limit: 20 }).filter((message) => message.author.kind !== "system" || message.kind === "question").at(-1);
      const activeRun = getTeamRunStore().listTeamRuns(room.id, { includeTerminal: false, limit: 1 })[0];
      return { ...room, summary: { lastMessage: lastMessage ? { content: lastMessage.content.slice(0, 100), author: lastMessage.author.name ?? "成员", seq: lastMessage.seq } : undefined,
        phase: activeRun?.phase, pending: room.members.some((member) => member.binding.status === "provisioning") } };
    });
    return NextResponse.json({ rooms }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return teamApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await parseJsonWithinLimit(request, 256 * 1024) as Partial<ManagedRoomInput> & {
      name?: string;
      description?: string;
      projectRoot?: string;
      sessionId?: string;
      sessionName?: string;
      cwd?: string;
      role?: RoomMemberRole;
      members?: Array<{
        sessionId: string;
        sessionName?: string;
        cwd?: string;
        projectRoot?: string;
        role?: RoomMemberRole;
        instructions?: string;
      }>;
    };
    if (body.template) {
      return NextResponse.json({ room: await createManagedRoom(body as ManagedRoomInput) }, { status: 201 });
    }
    if (!body.name || !body.sessionId) {
      return NextResponse.json({ error: "name and sessionId are required" }, { status: 400 });
    }
    const project = body.cwd ? await resolveProject(body.cwd) : undefined;
    const room = createRoom({
      name: body.name,
      description: body.description,
      projectRoot: project?.projectRoot ?? body.projectRoot,
      creator: {
        sessionId: body.sessionId,
        name: body.sessionName,
        cwd: body.cwd,
        projectRoot: project?.projectRoot ?? body.projectRoot,
        worktreeBranch: project?.isWorktree ? project.branch ?? undefined : undefined,
        role: body.role ?? "coordinator",
        instructions: "Coordinate the team, clarify decisions, and keep shared work aligned.",
      },
    });
    for (const member of body.members ?? []) {
      if (!member.sessionId || member.sessionId === body.sessionId) continue;
      const memberProject = member.cwd ? await resolveProject(member.cwd) : undefined;
      addRoomMember(room.id, {
        sessionId: member.sessionId,
        name: member.sessionName,
        cwd: member.cwd,
        projectRoot: memberProject?.projectRoot ?? member.projectRoot,
        worktreeBranch: memberProject?.isWorktree ? memberProject.branch ?? undefined : undefined,
        role: member.role ?? "participant",
        instructions: member.instructions,
      });
    }
    return NextResponse.json({ room: ensureRoomSessionIsolation(room.id) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
