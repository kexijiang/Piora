import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { addManagedRoomMember, configureRoomCoordination, createRoom, getRoom, getRoomsRoot, updateRoomAgentBinding } from "./room-store";
import { createRoomChatProfile, createTeamAgentProfile } from "./team-agent-templates";
import { provisionTeamAgentSession, resolveProvisionableTeamAgentProfile } from "./team-agent-provisioner";
import { allowFileRoot } from "./file-access";
import { resolveProject } from "./worktree";
import { TeamError } from "./team-errors";
import type { TeamAgentRole } from "./team-types";

export const ROOM_TEAM_TEMPLATE = [
  { name: "阿策", role: "coordinator", description: "组织分工与汇总" },
  { name: "小研", role: "worker", description: "完成任务与验证" },
  { name: "小审", role: "reviewer", description: "检查结果与遗漏" },
] as const;

export interface ManagedRoomInput {
  clientCreationId: string;
  name?: string;
  description?: string;
  cwd: string;
  template: "project" | "custom";
  agents?: Array<{ name: string; role?: TeamAgentRole; roleDescription?: string }>;
}

/** The creation receipt survives reloads and partially provisioned teams. */
export async function createManagedRoom(input: ManagedRoomInput, dependencies = {
  provision: provisionTeamAgentSession, resolveProfile: resolveProvisionableTeamAgentProfile,
}) {
  if (!input || !["project", "custom"].includes(input.template)) throw new TeamError("TEAM_INVALID_INPUT", "请选择有效的团队模板。");
  if ((input.name !== undefined && typeof input.name !== "string") || (input.description !== undefined && typeof input.description !== "string")) throw new TeamError("TEAM_INVALID_INPUT", "群名称或说明无效。");
  if (typeof input.clientCreationId !== "string" || !/^[\w-]{8,160}$/u.test(input.clientCreationId)) throw new TeamError("TEAM_INVALID_INPUT", "创建标识无效。");
  if (typeof input.cwd !== "string" || !existsSync(input.cwd) || !statSync(input.cwd).isDirectory()) throw new TeamError("TEAM_INVALID_INPUT", "请选择存在的项目目录。");
  const cwd = realpathSync(resolve(input.cwd));
  const agents = input.template === "custom" ? input.agents : ROOM_TEAM_TEMPLATE;
  if (!Array.isArray(agents) || agents.some((agent) => !agent) || agents.length < 1 || agents.length > 12
    || agents.filter((agent) => agent.role === "coordinator").length > 1
    || agents.some((agent) => agent.role !== undefined && !["coordinator", "planner", "worker", "reviewer", "participant"].includes(agent.role))
    || agents.some((agent) => typeof agent.name !== "string" || !agent.name.trim() || agent.name.length > 120)) throw new TeamError("TEAM_INVALID_INPUT", "请填写 1–12 位成员的名称。");
  // Keep one internal administration identity without making users assign jobs.
  const coordinatorIndex = Math.max(0, agents.findIndex((agent) => agent.role === "coordinator"));
  const normalized = agents.map((agent, index) => input.template === "project"
    ? createTeamAgentProfile(agent.role!, { name: agent.name })
    : createRoomChatProfile({ name: agent.name, role: index === coordinatorIndex ? "coordinator" : agent.role ?? "participant",
      roleDescription: "roleDescription" in agent ? agent.roleDescription : "" }));
  const root = join(getRoomsRoot(), ".creation", createHash("sha256").update(input.clientCreationId).digest("hex"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(root, { realpath: false, stale: 120_000, retries: { retries: 100, minTimeout: 50, maxTimeout: 200 } });
  try {
    const receiptPath = join(root, "receipt.json");
    const fingerprint = createHash("sha256").update(JSON.stringify({ ...input, cwd })).digest("hex");
    type CreationReceipt = { roomId: string; fingerprint: string; memberIds: string[] };
    const saved = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, "utf8")) as CreationReceipt : undefined;
    if (saved && saved.fingerprint !== fingerprint) throw new TeamError("TEAM_REVISION_CONFLICT", "创建内容已改变，请重新创建群聊。");
    const receipt = saved ?? { roomId: randomUUID(), fingerprint, memberIds: normalized.map(() => randomUUID()) };
    // Journal identity before the first Room mutation, so a process crash can resume the same room.
    const temporary = `${receiptPath}.tmp`;
    writeFileSync(temporary, JSON.stringify(receipt), { mode: 0o600, flush: true });
    renameSync(temporary, receiptPath);
    const project = await resolveProject(cwd);
    const leaderIndex = normalized.findIndex((profile) => profile.role === "coordinator");
    const leader = normalized[leaderIndex];
    let room = existsSync(join(getRoomsRoot(), receipt.roomId, "room.json")) ? getRoom(receipt.roomId) : createRoom({
      roomId: receipt.roomId, name: input.name?.trim() || `${basename(cwd)} 协作群`, description: input.description,
      projectRoot: project.projectRoot, creator: { memberId: receipt.memberIds[leaderIndex], sessionId: `room-bootstrap-${receipt.memberIds[leaderIndex]}`,
        name: leader.name, role: "coordinator", profile: leader, cwd, projectRoot: project.projectRoot },
    });
    for (const [index, profile] of normalized.entries()) {
      const memberId = receipt.memberIds[index];
      const existing = room.members.find((member) => member.memberId === memberId);
      if (existing) {
        if (!existing.binding.managedByPiora) room = updateRoomAgentBinding(room.id, room.members.find((member) => member.memberId === room!.coordination.coordinatorMemberId)!.binding.sessionId, memberId, { managedByPiora: true, status: "provisioning" });
        continue;
      }
      room = addManagedRoomMember(room.id, { memberId, profile,
        binding: { sessionId: `room-bootstrap-${memberId}`, cwd, projectRoot: project.projectRoot, managedByPiora: true, boundAt: Date.now(), status: "provisioning" },
        requestedBy: room.members.find((member) => member.memberId === room!.coordination.coordinatorMemberId)!.binding.sessionId });
    }
    allowFileRoot(cwd);
    const order = [...room.members].sort((a, b) => Number(b.profile.role === "coordinator") - Number(a.profile.role === "coordinator"));
    for (const member of order) {
      if (member.binding.status === "ready") continue;
      const profile = await dependencies.resolveProfile(room, member.profile);
      const binding = await dependencies.provision(room, profile, member.memberId);
      const actor = room.members.find((candidate) => candidate.memberId === room!.coordination.coordinatorMemberId)!.binding.sessionId;
      // Persist an effective shared policy when this project cannot host worktrees.
      if (profile.workspacePolicy.mode !== member.profile.workspacePolicy.mode) {
        const { updateRoomAgentProfile } = await import("./room-store");
        room = updateRoomAgentProfile(room.id, actor, member.memberId, member.profile.revision, profile);
      }
      room = updateRoomAgentBinding(room.id, actor, member.memberId, binding);
    }
    const actor = room.members.find((member) => member.memberId === room!.coordination.coordinatorMemberId)!.binding.sessionId;
    return configureRoomCoordination(room.id, { mode: input.template === "project" ? "team" : "manual", coordinatorSessionId: actor, requestedBy: actor });
  } finally { await release(); }
}
