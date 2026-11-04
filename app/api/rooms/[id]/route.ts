import { listRoomUiRequests } from "@/lib/room-activity-stream";
import { ensureRoomSessionIsolation } from "@/lib/room-session-isolation";
import { NextResponse } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import {
  addRoomMember,
  appendPrivateNote,
  appendRoomMessage,
  claimRoomTask,
  configureRoomCoordination,
  createRoomTask,
  deleteRoom,
  finishRoomTask,
  getRoom,
  findRoomMessage,
  heartbeatRoomTask,
  listPrivateNotes,
  listRoomMessages,
  listRoomTasks,
  listRoomArtifacts,
  listRoomAudit,
  publishRoomArtifact,
  removeRoomMember,
  updateRoomMember,
  updateRoomProfile,
  updateRoomWorkspace,
} from "@/lib/room-store";
import { dispatchRoomChat } from "@/lib/room-chat";
import { resolveExplicitRoomChatTargets, resolveRoomChatTargets } from "@/lib/room-chat-routing";
import { submitRoomMessage } from "@/lib/room-submissions";
import { getSessionMessageRouter } from "@/lib/session-message-router";
import { dispatchReadyRoomTasks } from "@/lib/room-coordinator";
import { getTeamCoordinatorService } from "@/lib/team-coordinator-service";
import { getTeamRunStore } from "@/lib/team-run-store";
import type { RoomArtifactKind, RoomMemberRole, RoomTask } from "@/lib/room-types";
import { projectRoomTaskRun } from "@/lib/task-run";
import { listAllSessions } from "@/lib/session-reader";
import type { SessionInfo } from "@/lib/types";
import { resolveProject } from "@/lib/worktree";

function isolatedRoom(room: ReturnType<typeof getRoom>) {
  return ensureRoomSessionIsolation(room.id);
}

export const dynamic = "force-dynamic";

async function resolveBinding(sessionId: string): Promise<SessionInfo> {
  const session = (await listAllSessions()).find((candidate) => candidate.id === sessionId);
  if (!session) throw new Error("The selected Session no longer exists.");
  return session;
}

function requireCoordinator(roomId: string, sessionId: string): void {
  const room = getRoom(roomId);
  const member = room.members.find((candidate) => candidate.sessionId === sessionId);
  if (!member || (member.role !== "coordinator" && room.coordination.coordinatorSessionId !== sessionId)) {
    throw new Error("Only the room coordinator can perform this action.");
  }
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const status = /only the room coordinator|not a member|coordinator-managed/i.test(message)
    ? 403
    : /not found|no longer exists/i.test(message)
      ? 404
      : /already|active task|finish or release|concurrency limit/i.test(message)
        ? 409
        : 400;
  return NextResponse.json({ error: message }, { status });
}

function taskResponse(task: RoomTask) {
  return {
    task,
    taskRun: projectRoomTaskRun(task, listRoomArtifacts(task.roomId)),
  };
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const query = new URL(request.url).searchParams;
    const afterSeq = Number(query.get("afterSeq") ?? 0);
    const privateSessionId = query.get("privateSessionId");
    const room = ensureRoomSessionIsolation(id);
    if (privateSessionId) {
      const requesterSessionId = query.get("sessionId");
      const requester = room.members.find((member) => member.sessionId === requesterSessionId);
      if (!requester || (requester.sessionId !== privateSessionId && requester.role !== "coordinator" && room.coordination.coordinatorSessionId !== requester.sessionId)) {
        return NextResponse.json({ error: "Private room memory is available only to that Agent or the coordinator." }, { status: 403 });
      }
    }
    const tasks = listRoomTasks(id);
    const artifacts = listRoomArtifacts(id);
    return NextResponse.json({
      room,
      messages: listRoomMessages(id, { afterSeq: Number.isFinite(afterSeq) ? afterSeq : 0 }),
      tasks,
      taskRuns: tasks.map((task) => projectRoomTaskRun(task, artifacts)),
      artifacts,
      audit: listRoomAudit(id),
      uiRequests: listRoomUiRequests(id),
      ...(privateSessionId ? { privateNotes: listPrivateNotes(id, privateSessionId) } : {}),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json() as {
      action?: "join" | "add_member" | "update_member" | "leave" | "update_room" | "update_workspace" | "message" | "chat" | "private_note" | "configure" | "create_task" | "claim_task" | "heartbeat_task" | "finish_task" | "dispatch" | "publish_artifact";
      sessionId?: string;
      targetSessionId?: string;
      memberId?: string;
      sessionName?: string;
      instructions?: string;
      cwd?: string;
      projectRoot?: string;
      role?: RoomMemberRole;
      content?: string;
      replyTo?: string;
      correlationId?: string;
      forwardDepth?: number;
      autoRound?: number;
      maxAutoRounds?: number;
      authorKind?: "user" | "session";
      mode?: "manual" | "coordinator" | "team";
      maxConcurrency?: number;
      leaseDurationMs?: number;
      taskId?: string;
      title?: string;
      description?: string;
      assignedTo?: string;
      dedupeKey?: string;
      priority?: number;
      dependsOn?: string[];
      leaseToken?: string;
      taskStatus?: "completed" | "failed" | "blocked";
      artifactKind?: RoomArtifactKind;
      artifactName?: string;
      sourcePath?: string;
      targetSessionIds?: string[];
      workspaceMode?: "managed" | "custom";
      workspacePath?: string;
      workspaceLabel?: string;
    };
    if (!body.action || !body.sessionId) {
      return NextResponse.json({ error: "action and sessionId are required" }, { status: 400 });
    }
    if (body.action === "join") {
      const room = getRoom(id);
      const existing = room.members.find((member) => member.sessionId === body.sessionId);
      if (!existing) return NextResponse.json({ error: "Use the coordinator-managed Add Agent flow to join this room." }, { status: 403 });
      const session = await resolveBinding(body.sessionId);
      const project = await resolveProject(session.cwd);
      return NextResponse.json({ room: isolatedRoom(addRoomMember(id, {
        sessionId: body.sessionId,
        name: body.sessionName,
        cwd: session.cwd,
        projectRoot: project.projectRoot,
        worktreeBranch: project.isWorktree ? project.branch ?? undefined : undefined,
        role: existing.role,
        instructions: existing.instructions,
        requestedBy: body.sessionId,
      })) });
    }
    if (body.action === "add_member") {
      if (!body.targetSessionId) return NextResponse.json({ error: "targetSessionId is required" }, { status: 400 });
      requireCoordinator(id, body.sessionId);
      const session = await resolveBinding(body.targetSessionId);
      const project = await resolveProject(session.cwd);
      return NextResponse.json({ room: isolatedRoom(addRoomMember(id, {
        sessionId: body.targetSessionId,
        name: body.sessionName,
        instructions: body.instructions,
        cwd: session.cwd,
        projectRoot: project.projectRoot,
        worktreeBranch: project.isWorktree ? project.branch ?? undefined : undefined,
        role: body.role,
        requestedBy: body.sessionId,
      })) });
    }
    if (body.action === "update_member") {
      if (!body.memberId) return NextResponse.json({ error: "memberId is required" }, { status: 400 });
      requireCoordinator(id, body.sessionId);
      const current = getRoom(id).members.find((member) => member.memberId === body.memberId);
      if (!current) return NextResponse.json({ error: "Collaboration Agent was not found." }, { status: 404 });
      const targetSessionId = body.targetSessionId ?? current.sessionId;
      const session = await resolveBinding(targetSessionId);
      const project = await resolveProject(session.cwd);
      return NextResponse.json({ room: isolatedRoom(updateRoomMember(id, body.sessionId, body.memberId, {
        sessionId: targetSessionId,
        name: body.sessionName,
        instructions: body.instructions,
        role: body.role,
        cwd: session.cwd,
        projectRoot: project.projectRoot,
        worktreeBranch: project.isWorktree ? project.branch ?? undefined : undefined,
      })) });
    }
    if (body.action === "leave") {
      return NextResponse.json({ room: removeRoomMember(id, body.targetSessionId ?? body.sessionId, body.sessionId) });
    }
    if (body.action === "update_room") {
      if (!body.title) return NextResponse.json({ error: "title is required" }, { status: 400 });
      return NextResponse.json({ room: updateRoomProfile(id, body.sessionId, { name: body.title, description: body.description }) });
    }
    if (body.action === "update_workspace") {
      if (!body.workspaceMode) return NextResponse.json({ error: "workspaceMode is required" }, { status: 400 });
      return NextResponse.json({ room: updateRoomWorkspace(id, body.sessionId, {
        mode: body.workspaceMode,
        path: body.workspacePath,
        label: body.workspaceLabel,
        instructions: body.instructions,
      }) });
    }
    if (body.action === "configure") {
      return NextResponse.json({ room: configureRoomCoordination(id, {
        mode: body.mode ?? "manual",
        coordinatorSessionId: body.targetSessionId ?? body.sessionId,
        maxConcurrency: body.maxConcurrency,
        leaseDurationMs: body.leaseDurationMs,
        requestedBy: body.sessionId,
      }) });
    }
    if (body.action === "create_task") {
      if (!body.title || !body.description) return NextResponse.json({ error: "title and description are required" }, { status: 400 });
      return NextResponse.json(taskResponse(createRoomTask(id, {
        title: body.title,
        description: body.description,
        createdBy: body.sessionId,
        assignedTo: body.assignedTo,
        dedupeKey: body.dedupeKey,
        priority: body.priority,
        dependsOn: body.dependsOn,
      })));
    }
    if (body.action === "claim_task") {
      if (!body.taskId) return NextResponse.json({ error: "taskId is required" }, { status: 400 });
      return NextResponse.json(taskResponse(claimRoomTask(id, body.taskId, body.sessionId)));
    }
    if (body.action === "heartbeat_task") {
      if (!body.taskId || !body.leaseToken) return NextResponse.json({ error: "taskId and leaseToken are required" }, { status: 400 });
      return NextResponse.json(taskResponse(heartbeatRoomTask(id, body.taskId, body.sessionId, body.leaseToken)));
    }
    if (body.action === "finish_task") {
      if (!body.taskId || !body.leaseToken || !body.taskStatus || !body.content) {
        return NextResponse.json({ error: "taskId, leaseToken, taskStatus and content are required" }, { status: 400 });
      }
      return NextResponse.json(taskResponse(finishRoomTask(id, body.taskId, body.sessionId, body.leaseToken, { status: body.taskStatus, result: body.content })));
    }
    if (body.action === "dispatch") {
      requireCoordinator(id, body.sessionId);
      return NextResponse.json({ dispatch: await dispatchReadyRoomTasks(id) });
    }
    if (body.action === "publish_artifact") {
      if (!body.artifactKind || !body.artifactName || !body.content) {
        return NextResponse.json({ error: "artifactKind, artifactName and content are required" }, { status: 400 });
      }
      return NextResponse.json({ artifact: publishRoomArtifact(id, body.sessionId, {
        taskId: body.taskId,
        kind: body.artifactKind,
        name: body.artifactName,
        summary: body.content,
        sourcePath: body.sourcePath,
      }) });
    }
    if (!body.content) return NextResponse.json({ error: "content is required" }, { status: 400 });
    if (body.action === "private_note") {
      return NextResponse.json({ note: appendPrivateNote(id, body.sessionId, body.content) });
    }
    const room = getRoom(id);
    const member = room.members.find((item) => item.sessionId === body.sessionId);
    if (!member) return NextResponse.json({ error: "Session is not a room member" }, { status: 403 });
    if (body.action === "chat" && body.authorKind !== "session" && !body.replyTo && !resolveExplicitRoomChatTargets(room, body.content).length) {
      // Older clients use this endpoint. Share the durable election path instead
      // of silently retaining the old coordinator-only default.
      const clientPromptId = body.correlationId ? `legacy-${createHash("sha256").update(body.correlationId).digest("hex")}` : randomUUID();
      const { message, submission } = await submitRoomMessage(id, { sessionId: body.sessionId, clientPromptId, content: body.content });
      const commands = await Promise.all(submission.commandIds.map(commandId => getSessionMessageRouter().getCommand(commandId)));
      return NextResponse.json({ message, dispatch: {
        dispatched: commands.map(command => ({ sessionId: command.targetSessionId, behavior: "next_turn", commandId: command.commandId, status: command.status })),
        skipped: submission.status === "error" ? [{ sessionId: "*", reason: submission.error }] : [],
      } });
    }
    const message = appendRoomMessage(id, {
      authorKind: body.authorKind ?? "user",
      authorId: body.sessionId,
      authorName: body.sessionName ?? member.name,
      content: body.content,
      replyTo: body.replyTo,
      correlationId: body.correlationId,
      forwardDepth: body.forwardDepth ?? 0,
      autoRound: body.autoRound ?? 0,
      maxAutoRounds: body.maxAutoRounds ?? 6,
    });
    if (body.action === "chat") {
      const repliedMessage = body.replyTo ? findRoomMessage(id, body.replyTo) : undefined;
      const questionRunId = /^team:([^:]+):question:/u.exec(repliedMessage?.correlationId ?? "")?.[1];
      const waitingRun = body.authorKind !== "session" && room.coordination.mode === "team" && questionRunId
        ? getTeamRunStore().listTeamRuns(id, { limit: 100, includeTerminal: false }).find((run) => run.phase === "waiting_user" && run.id === questionRunId)
        : undefined;
      if (waitingRun) {
        const teamRun = await getTeamCoordinatorService().resumeRun(id, waitingRun.id, message.content, repliedMessage!.id);
        return NextResponse.json({ message, teamRun, dispatch: { dispatched: [], skipped: [] } });
      }
      const dispatch = await dispatchRoomChat(id, {
        messageId: message.id,
        content: message.content,
        authorName: message.author.name,
        authorSessionId: message.author.id,
        targetSessionIds: message.author.kind === "user"
          ? resolveRoomChatTargets(room, message.content)
          : body.targetSessionIds,
        replyTo: message.replyTo,
        correlationId: message.correlationId ?? message.id,
        forwardDepth: message.forwardDepth,
        autoRound: message.autoRound,
        maxAutoRounds: message.maxAutoRounds,
      });
      return NextResponse.json({ message, dispatch });
    }
    return NextResponse.json({ message });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const sessionId = new URL(request.url).searchParams.get("sessionId");
    if (!sessionId) return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
    deleteRoom(id, sessionId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return errorResponse(error);
  }
}
