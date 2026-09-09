import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { getRpcSession, startRpcSession } from "./rpc-manager";
import { resolveSessionPath } from "./session-reader";
import { createTeamAgentProfile, validateTeamAgentProfile } from "./team-agent-templates";
import { addWorktree, canCreateDedicatedWorktree, removeWorktree } from "./worktree";
import { TeamError } from "./team-errors";
import type { CollaborationRoomV3, TeamAgentBinding, TeamAgentProfile } from "./team-types";

function slug(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 32) || "agent";
}

function sessionOptions(profile: TeamAgentProfile) {
  const toolNames = profile.toolPolicy.mode === "allowlist"
    ? [...new Set([...profile.toolPolicy.toolNames, "piora_room"])]
    : undefined;
  return {
    ...(toolNames ? { toolNames } : {}),
    ...(profile.modelPolicy.mode === "pinned" ? {
      allowModelFallback: false,
      initialModel: { provider: profile.modelPolicy.provider, modelId: profile.modelPolicy.modelId },
      thinkingLevel: profile.modelPolicy.thinkingLevel,
    } : {}),
  };
}

function roomBaseCwd(room: CollaborationRoomV3): string {
  const coordinator = room.members.find((member) => member.memberId === room.coordination.coordinatorMemberId);
  return resolve(room.projectRoot ?? coordinator?.binding.projectRoot ?? coordinator?.binding.cwd ?? room.workspace.path);
}

export async function resolveProvisionableTeamAgentProfile(
  room: CollaborationRoomV3,
  requestedProfile: TeamAgentProfile,
): Promise<TeamAgentProfile> {
  const profile = validateTeamAgentProfile(structuredClone(requestedProfile));
  if (
    profile.workspacePolicy.mode !== "dedicated_worktree"
    || await canCreateDedicatedWorktree(roomBaseCwd(room))
  ) {
    return profile;
  }

  // Non-Git folders and repositories with an unborn HEAD cannot host linked
  // worktrees. Keep managed Agent creation usable and persist the effective
  // policy so the settings UI never claims isolation that was not created.
  return createTeamAgentProfile(profile.role, {
    ...profile,
    workspacePolicy: {
      mode: "shared",
      integration: profile.role === "coordinator"
        ? "coordinator_integrates"
        : profile.workspacePolicy.integration,
    },
  });
}

export async function provisionTeamAgentSession(
  room: CollaborationRoomV3,
  profile: TeamAgentProfile,
  memberId = randomUUID(),
): Promise<TeamAgentBinding> {
  let cwd = roomBaseCwd(room);
  let worktree: { path: string; branch: string } | undefined;
  let sessionId: string | undefined;
  try {
    if (profile.workspacePolicy.mode === "dedicated_worktree") {
      const branch = `codex/team-${room.id.slice(0, 8)}-${slug(profile.name)}-${memberId.slice(0, 8)}`;
      worktree = await addWorktree(cwd, branch);
      cwd = worktree.path;
    } else if (profile.workspacePolicy.mode === "read_only") {
      cwd = room.workspace.path;
    }
    const started = await startRpcSession(`team-provision-${memberId}`, "", cwd, sessionOptions(profile));
    sessionId = started.realSessionId;
    await started.session.waitUntilReady();
    if (profile.toolPolicy.mode === "allowlist") await started.session.send({ type: "set_team_tools", toolNames: profile.toolPolicy.toolNames });
    await started.session.send({ type: "set_session_name", name: `${room.name} · ${profile.name}` });
    started.session.persistSessionFile();
    return {
      sessionId,
      cwd,
      projectRoot: room.projectRoot ?? roomBaseCwd(room),
      ...(worktree ? { worktreeBranch: worktree.branch } : {}),
      managedByPiora: true,
      boundAt: Date.now(),
      status: "ready",
    };
  } catch (error) {
    if (sessionId) {
      getRpcSession(sessionId)?.destroy();
      const file = await resolveSessionPath(sessionId).catch(() => null);
      if (file && existsSync(file)) unlinkSync(file);
    }
    if (worktree) await removeWorktree(roomBaseCwd(room), worktree.path, false).catch(() => undefined);
    throw new TeamError("TEAM_WORKSPACE_CONFLICT", error instanceof Error ? error.message : "Managed Team Agent provisioning failed.");
  }
}

export async function rollbackProvisionedTeamAgentSession(room: CollaborationRoomV3, binding: TeamAgentBinding): Promise<void> {
  if (!binding.managedByPiora) return;
  const live = getRpcSession(binding.sessionId);
  live?.destroy();
  const file = await resolveSessionPath(binding.sessionId).catch(() => null);
  if (file && existsSync(file)) unlinkSync(file);
  if (binding.worktreeBranch && binding.cwd) {
    await removeWorktree(roomBaseCwd(room), binding.cwd, false).catch(() => undefined);
  }
}

export async function reconfigureTeamAgentSession(
  room: CollaborationRoomV3,
  memberId: string,
  expectedProfileRevision: number,
): Promise<TeamAgentBinding> {
  const member = room.members.find((candidate) => candidate.memberId === memberId);
  if (!member) throw new TeamError("TEAM_MEMBER_NOT_FOUND", "Team Agent was not found.");
  if (!member.binding.managedByPiora) throw new TeamError("TEAM_INVALID_INPUT", "A reused Session must be reconfigured explicitly outside managed provisioning.");
  if (member.profile.revision !== expectedProfileRevision) throw new TeamError("TEAM_REVISION_CONFLICT", "Agent profile changed before reconfiguration.");
  const live = getRpcSession(member.binding.sessionId);
  if (live?.isRunning()) throw new TeamError("TEAM_REVISION_CONFLICT", "Agent Session is busy; retry reconfiguration when it is idle.");
  live?.destroy();
  const sessionFile = await resolveSessionPath(member.binding.sessionId);
  if (!sessionFile) throw new TeamError("TEAM_MEMBER_NOT_FOUND", "Managed Agent Session file is missing.");
  const started = await startRpcSession(member.binding.sessionId, sessionFile, member.binding.cwd ?? roomBaseCwd(room), sessionOptions(member.profile));
  await started.session.waitUntilReady();
  if (member.profile.modelPolicy.mode === "pinned") {
    await started.session.send({ type: "set_model", provider: member.profile.modelPolicy.provider, modelId: member.profile.modelPolicy.modelId });
    await started.session.send({ type: "set_thinking_level", level: member.profile.modelPolicy.thinkingLevel });
  }
  if (member.profile.toolPolicy.mode === "allowlist") {
    await started.session.send({ type: "set_team_tools", toolNames: member.profile.toolPolicy.toolNames });
  }
  await started.session.send({ type: "set_session_name", name: `${room.name} · ${member.profile.name}` });
  return { ...member.binding, status: "ready", boundAt: Date.now() };
}

export async function disposeManagedTeamAgentSession(room: CollaborationRoomV3, memberId: string): Promise<void> {
  const member = room.members.find((candidate) => candidate.memberId === memberId);
  if (!member?.binding.managedByPiora) return;
  const live = getRpcSession(member.binding.sessionId);
  if (live?.isRunning()) throw new TeamError("TEAM_REVISION_CONFLICT", "Managed Agent Session is busy.");
  live?.destroy();
  if (member.binding.worktreeBranch && member.binding.cwd) {
    await removeWorktree(roomBaseCwd(room), member.binding.cwd, false);
  }
}
