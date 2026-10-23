import { APP_DISPLAY_NAME } from "./branding";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { createTeamAgentProfile, validateTeamAgentProfile } from "./team-agent-templates";
import { TEAM_DEFAULTS, type TeamAgentBinding, type TeamAgentProfile, type TeamAgentRole } from "./team-types";
import type {
  CollaborationRoom,
  PrivateRoomNote,
  RoomMember,
  RoomMessage,
  RoomMessageAuthorKind,
  RoomMemberRole,
  RoomEvent,
  RoomPresence,
  RoomTask,
  RoomArtifact,
  RoomArtifactKind,
  RoomAuditEntry,
} from "./room-types";
import { ROOM_SCHEMA_VERSION } from "./room-types";

const ROOM_ID_PATTERN = /^[0-9a-f-]{36}$/i;
const MAX_MESSAGE_BYTES = TEAM_DEFAULTS.maxInputBytes;
const MAX_ROOM_NAME_LENGTH = 120;

type RoomListener = (message: RoomMessage) => void;
type RoomEventListener = (event: RoomEvent) => void;

declare global {
  var __pioraRoomListeners: Map<string, Set<RoomListener>> | undefined;
  var __pioraRoomEventListeners: Map<string, Set<RoomEventListener>> | undefined;
}

function roomEventListeners(): Map<string, Set<RoomEventListener>> {
  return globalThis.__pioraRoomEventListeners ??= new Map();
}

function emitRoomEvent(event: RoomEvent): void {
  for (const listener of roomEventListeners().get(event.roomId) ?? []) listener(event);
}

function roomListeners(): Map<string, Set<RoomListener>> {
  return globalThis.__pioraRoomListeners ??= new Map();
}

export function getRoomsRoot(): string {
  const root = process.env.PIORA_ROOMS_ROOT
    ? resolve(process.env.PIORA_ROOMS_ROOT)
    : resolve(getAgentDir(), "piora", "rooms");
  mkdirSync(root, { recursive: true });
  return root;
}

function assertRoomId(roomId: string): string {
  if (!ROOM_ID_PATTERN.test(roomId)) throw new Error("Invalid collaboration room id.");
  return roomId;
}

function roomPaths(roomId: string) {
  const root = join(getRoomsRoot(), assertRoomId(roomId));
  return {
    root,
    metadata: join(root, "room.json"),
    shared: join(root, "shared"),
    messages: join(root, "shared", "messages.jsonl"),
    messageBlobs: join(root, "shared", "message-blobs"),
    artifacts: join(root, "shared", "artifacts"),
    privateRoot: join(root, "private"),
    tasks: join(root, "shared", "tasks"),
    legacyTasks: join(root, "shared", "legacy-tasks"),
    runs: join(root, "shared", "runs"),
    audit: join(root, "shared", "audit.jsonl"),
    workspace: join(root, "workspace"),
  };
}

function safeMemberDirectory(memberId: string): string {
  const encoded = Buffer.from(memberId, "utf8").toString("base64url");
  if (!encoded) throw new Error("A member id is required.");
  return encoded;
}

function cleanText(value: string, maxLength: number): string {
  const cleaned = value.trim().slice(0, maxLength);
  if (!cleaned) throw new Error("A non-empty value is required.");
  return cleaned;
}

function requireUtf8Text(value: string, label: string, maxBytes: number): string {
  if (!value.trim()) throw new Error(`${label} must not be empty.`);
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    const error = new Error(`${label} exceeds ${maxBytes} UTF-8 bytes.`) as Error & { code?: string; status?: number };
    error.code = "TEAM_INPUT_TOO_LARGE";
    error.status = 413;
    throw error;
  }
  return value;
}

function attachMemberAliases(member: RoomMember): RoomMember {
  const aliases: PropertyDescriptorMap = {
    sessionId: { configurable: true, get: () => member.binding.sessionId, set: (value: string) => { member.binding.sessionId = value; } },
    name: { configurable: true, get: () => member.profile.name, set: (value?: string) => { if (value !== undefined) member.profile.name = value; } },
    instructions: { configurable: true, get: () => member.profile.roleDescription, set: (value?: string) => { member.profile.roleDescription = value ?? ""; } },
    role: { configurable: true, get: () => member.profile.role, set: (value: TeamAgentRole) => { member.profile.role = value; } },
    cwd: { configurable: true, get: () => member.binding.cwd, set: (value?: string) => { member.binding.cwd = value; } },
    projectRoot: { configurable: true, get: () => member.binding.projectRoot, set: (value?: string) => { member.binding.projectRoot = value; } },
    worktreeBranch: { configurable: true, get: () => member.binding.worktreeBranch, set: (value?: string) => { member.binding.worktreeBranch = value; } },
  };
  Object.defineProperties(member, aliases);
  return member;
}

function attachRoomAliases(room: CollaborationRoom): CollaborationRoom {
  room.members = room.members.map(attachMemberAliases);
  Object.defineProperty(room.coordination, "coordinatorSessionId", {
    configurable: true,
    get: () => room.members.find((member) => member.memberId === room.coordination.coordinatorMemberId)?.binding.sessionId,
    set: (sessionId?: string) => {
      const member = room.members.find((candidate) => candidate.binding.sessionId === sessionId);
      if (member) room.coordination.coordinatorMemberId = member.memberId;
    },
  });
  return room;
}

export function withRoomLockSync<T>(roomId: string, operation: () => T): T {
  const paths = roomPaths(roomId);
  mkdirSync(paths.root, { recursive: true });
  let release: (() => void) | undefined;
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 100 && !release; attempt += 1) {
    try {
      release = lockfile.lockSync(paths.root, { realpath: false, stale: 30_000, update: 1_000 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || attempt === 99) throw error;
      Atomics.wait(waitBuffer, 0, 0, Math.min(50, 4 + attempt));
    }
  }
  if (!release) throw new Error("无法获取协作空间元数据锁。");
  try {
    return operation();
  } finally {
    release();
  }
}

function writeRoom(room: CollaborationRoom): void {
  const paths = roomPaths(room.id);
  mkdirSync(paths.root, { recursive: true });
  const temporary = `${paths.metadata}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(room, null, 2)}\n`, "utf8");
  renameSync(temporary, paths.metadata);
}

function appendRoomAudit(roomId: string, actorSessionId: string, action: RoomAuditEntry["action"], summary: string): RoomAuditEntry {
  const paths = roomPaths(roomId);
  mkdirSync(paths.shared, { recursive: true });
  const audit: RoomAuditEntry = { id: randomUUID(), roomId, actorSessionId, action, summary: cleanText(summary, 1_000), createdAt: Date.now() };
  appendFileSync(paths.audit, `${JSON.stringify(audit)}\n`, "utf8");
  emitRoomEvent({ type: "audit", roomId, audit });
  return audit;
}

export function listRoomAudit(roomId: string, limit = 100): RoomAuditEntry[] {
  const paths = roomPaths(roomId);
  getRoom(roomId);
  if (!existsSync(paths.audit)) return [];
  return readFileSync(paths.audit, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as RoomAuditEntry]; } catch { return []; }
  }).slice(-Math.max(1, Math.min(500, limit)));
}

interface LegacyRoomMember {
  memberId?: string;
  sessionId: string;
  name?: string;
  instructions?: string;
  cwd?: string;
  projectRoot?: string;
  worktreeBranch?: string;
  role?: RoomMemberRole;
  joinedAt?: number;
}

function migrateLegacyMember(member: LegacyRoomMember, now: number): RoomMember {
  const role = member.role ?? "participant";
  const profile = createTeamAgentProfile(role, {
    name: member.name?.trim() || member.sessionId.slice(0, 8),
    roleDescription: member.instructions ?? "",
  });
  return attachMemberAliases({
    memberId: member.memberId || member.sessionId,
    profile,
    binding: {
      sessionId: member.sessionId,
      ...(member.cwd ? { cwd: resolve(member.cwd) } : {}),
      ...(member.projectRoot ? { projectRoot: resolve(member.projectRoot) } : {}),
      ...(member.worktreeBranch ? { worktreeBranch: member.worktreeBranch } : {}),
      managedByPiora: false,
      boundAt: member.joinedAt ?? now,
      status: "ready",
    },
    joinedAt: member.joinedAt ?? now,
  } as RoomMember);
}

function parseRoom(value: unknown): CollaborationRoom | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (![1, 2, ROOM_SCHEMA_VERSION].includes(source.schemaVersion as number) || typeof source.id !== "string" || !ROOM_ID_PATTERN.test(source.id)) return null;
  const raw = source as unknown as Record<string, unknown> & { members: unknown[] };
  if (typeof raw.name !== "string" || typeof raw.createdAt !== "number" || typeof raw.updatedAt !== "number") return null;
  if (typeof raw.nextSeq !== "number" || !Array.isArray(raw.members) || !raw.paths) return null;
  const paths = roomPaths(source.id);
  const legacy = source.schemaVersion !== ROOM_SCHEMA_VERSION;
  const members = legacy
    ? raw.members.flatMap((item) => item && typeof (item as LegacyRoomMember).sessionId === "string" ? [migrateLegacyMember(item as LegacyRoomMember, raw.updatedAt as number)] : [])
    : raw.members.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const member = item as RoomMember;
        if (!member.memberId || !member.profile || !member.binding?.sessionId) return [];
        try {
          member.profile = validateTeamAgentProfile(member.profile);
          return [attachMemberAliases(member)];
        } catch {
          return [];
        }
      });
  if (members.length === 0) return null;
  const oldCoordination = (raw.coordination ?? {}) as Record<string, unknown>;
  const coordinator = members.find((member) => member.binding.sessionId === oldCoordination.coordinatorSessionId)
    ?? members.find((member) => member.profile.role === "coordinator")
    ?? members[0]!;
  coordinator.profile.role = "coordinator";
  for (const member of members) if (member.memberId !== coordinator.memberId && member.profile.role === "coordinator") member.profile.role = "participant";
  const room = {
    ...raw,
    schemaVersion: ROOM_SCHEMA_VERSION,
    description: typeof raw.description === "string" ? raw.description : "",
    members,
    coordination: legacy ? {
      mode: oldCoordination.mode === "coordinator" ? "team" : "manual",
      coordinatorMemberId: coordinator.memberId,
      defaultReviewerMemberIds: members.filter((member) => member.profile.role === "reviewer").map((member) => member.memberId),
      maxConcurrency: Math.max(1, Math.min(16, Number(oldCoordination.maxConcurrency) || TEAM_DEFAULTS.maxConcurrency)),
      leaseDurationMs: Math.max(30_000, Number(oldCoordination.leaseDurationMs) || TEAM_DEFAULTS.leaseDurationMs),
      maxRunSteps: TEAM_DEFAULTS.maxRunSteps,
      maxTaskAttempts: TEAM_DEFAULTS.maxTaskAttempts,
      requireReviewForCodeChanges: TEAM_DEFAULTS.requireReviewForCodeChanges,
    } : oldCoordination,
  } as unknown as CollaborationRoom;
  room.workspace = room.workspace && typeof room.workspace.path === "string"
    ? {
        mode: room.workspace.mode === "custom" ? "custom" : "managed",
        path: resolve(room.workspace.path),
        label: typeof room.workspace.label === "string" && room.workspace.label.trim() ? room.workspace.label : "共享工作区",
        instructions: typeof room.workspace.instructions === "string" ? room.workspace.instructions : "",
        defaultAgentWorkspace: room.workspace.defaultAgentWorkspace === "shared" ? "shared" : "dedicated_worktree",
      }
    : { mode: "managed", path: paths.workspace, label: "共享工作区", instructions: "", defaultAgentWorkspace: "dedicated_worktree" };
  room.paths = { root: paths.root, shared: paths.shared, privateRoot: paths.privateRoot };
  room.coordination.mode = room.coordination.mode === "team" ? "team" : "manual";
  room.coordination.coordinatorMemberId ||= coordinator.memberId;
  room.coordination.defaultReviewerMemberIds ??= members.filter((member) => member.profile.role === "reviewer").map((member) => member.memberId);
  room.coordination.maxConcurrency = Math.max(1, Math.min(16, room.coordination.maxConcurrency || TEAM_DEFAULTS.maxConcurrency));
  room.coordination.leaseDurationMs = Math.max(30_000, room.coordination.leaseDurationMs || TEAM_DEFAULTS.leaseDurationMs);
  room.coordination.maxRunSteps ||= TEAM_DEFAULTS.maxRunSteps;
  room.coordination.maxTaskAttempts ||= TEAM_DEFAULTS.maxTaskAttempts;
  room.coordination.requireReviewForCodeChanges ??= TEAM_DEFAULTS.requireReviewForCodeChanges;
  mkdirSync(room.workspace.path, { recursive: true });
  return attachRoomAliases(room);
}

export function getRoom(roomId: string): CollaborationRoom {
  const path = roomPaths(roomId).metadata;
  if (!existsSync(path)) throw new Error("Collaboration room not found.");
  const source = JSON.parse(readFileSync(path, "utf8")) as { schemaVersion?: unknown };
  const sourceVersion = source.schemaVersion;
  const room = parseRoom(source);
  if (!room) throw new Error("Collaboration room metadata is invalid.");
  if (sourceVersion !== ROOM_SCHEMA_VERSION) {
    withRoomLockSync(roomId, () => {
      const paths = roomPaths(roomId);
      const backup = `${paths.metadata}.v2.backup`;
      if (!existsSync(backup)) writeFileSync(backup, readFileSync(paths.metadata));
      if (existsSync(paths.tasks) && !existsSync(paths.legacyTasks)) renameSync(paths.tasks, paths.legacyTasks);
      writeRoom(room);
    });
  }
  return room;
}

export function listRooms(sessionId?: string): CollaborationRoom[] {
  const root = getRoomsRoot();
  const rooms: CollaborationRoom[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !ROOM_ID_PATTERN.test(entry.name)) continue;
    try {
      const room = getRoom(entry.name);
      if (!sessionId || room.members.some((member) => member.binding.sessionId === sessionId)) rooms.push(room);
    } catch {
      // A partial/corrupt directory is ignored instead of breaking all rooms.
    }
  }
  return rooms.sort((left, right) => right.updatedAt - left.updatedAt);
}

export function createRoom(input: {
  roomId?: string;
  name: string;
  description?: string;
  projectRoot?: string;
  creator: {
    memberId?: string;
    sessionId: string;
    name?: string;
    instructions?: string;
    cwd?: string;
    projectRoot?: string;
    worktreeBranch?: string;
    role?: RoomMemberRole;
    profile?: Partial<TeamAgentProfile>;
  };
}): CollaborationRoom {
  const id = input.roomId ?? randomUUID();
  const now = Date.now();
  const paths = roomPaths(id);
  if (existsSync(paths.metadata)) throw new Error("Room already exists.");
  mkdirSync(paths.artifacts, { recursive: true });
  mkdirSync(paths.privateRoot, { recursive: true });
  mkdirSync(paths.workspace, { recursive: true });
  const role = input.creator.role ?? "coordinator";
  const creator = attachMemberAliases({
    memberId: input.creator.memberId ?? randomUUID(),
    profile: createTeamAgentProfile(role, {
      ...input.creator.profile,
      name: input.creator.name ?? input.creator.profile?.name ?? input.creator.sessionId.slice(0, 8),
      roleDescription: input.creator.instructions ?? input.creator.profile?.roleDescription ?? "",
    }),
    binding: {
      sessionId: input.creator.sessionId,
      ...(input.creator.cwd ? { cwd: resolve(input.creator.cwd) } : {}),
      ...(input.creator.projectRoot ? { projectRoot: resolve(input.creator.projectRoot) } : {}),
      ...(input.creator.worktreeBranch ? { worktreeBranch: input.creator.worktreeBranch } : {}),
      managedByPiora: false,
      boundAt: now,
      status: "ready",
    },
    joinedAt: now,
  } as RoomMember);
  const room = attachRoomAliases({
    schemaVersion: ROOM_SCHEMA_VERSION,
    id,
    name: cleanText(input.name, MAX_ROOM_NAME_LENGTH),
    description: input.description?.trim().slice(0, 2_000) ?? "",
    ...(input.projectRoot ? { projectRoot: resolve(input.projectRoot) } : {}),
    createdAt: now,
    updatedAt: now,
    nextSeq: 1,
    members: [creator],
    coordination: {
      mode: "manual",
      coordinatorMemberId: creator.memberId,
      defaultReviewerMemberIds: [],
      maxConcurrency: TEAM_DEFAULTS.maxConcurrency,
      leaseDurationMs: TEAM_DEFAULTS.leaseDurationMs,
      maxRunSteps: TEAM_DEFAULTS.maxRunSteps,
      maxTaskAttempts: TEAM_DEFAULTS.maxTaskAttempts,
      requireReviewForCodeChanges: TEAM_DEFAULTS.requireReviewForCodeChanges,
    },
    workspace: { mode: "managed", path: paths.workspace, label: "共享工作区", instructions: "", defaultAgentWorkspace: "dedicated_worktree" },
    paths: { root: paths.root, shared: paths.shared, privateRoot: paths.privateRoot },
  } as CollaborationRoom);
  mkdirSync(join(paths.privateRoot, safeMemberDirectory(creator.memberId)), { recursive: true });
  writeRoom(room);
  appendRoomAudit(id, creator.sessionId, "room.created", `创建协作空间「${room.name}」。`);
  emitRoomEvent({ type: "room", roomId: room.id, room });
  appendRoomMessage(id, {
    authorKind: "system",
    authorId: "piora",
    authorName: `${APP_DISPLAY_NAME}`,
    content: `${input.creator.name || input.creator.sessionId} 创建了协作空间。`,
  });
  return getRoom(id);
}

export function addRoomMember(roomId: string, input: {
  memberId?: string;
  sessionId: string;
  name?: string;
  instructions?: string;
  cwd?: string;
  projectRoot?: string;
  worktreeBranch?: string;
  role?: RoomMemberRole;
  requestedBy?: string;
}): CollaborationRoom {
  const room = getRoom(roomId);
  const existing = room.members.find((member) => member.sessionId === input.sessionId);
  if (existing) {
    existing.name = input.name ?? existing.name;
    existing.cwd = input.cwd ?? existing.cwd;
    existing.projectRoot = input.projectRoot ?? existing.projectRoot;
    existing.worktreeBranch = input.worktreeBranch ?? existing.worktreeBranch;
    existing.role = input.role ?? existing.role;
    existing.instructions = input.instructions ?? existing.instructions;
  } else {
    const role = input.role ?? "participant";
    room.members.push(attachMemberAliases({
      memberId: input.memberId ?? randomUUID(),
      profile: createTeamAgentProfile(role, {
        name: input.name?.trim() || input.sessionId.slice(0, 8),
        roleDescription: input.instructions ?? "",
      }),
      binding: {
        sessionId: input.sessionId,
        ...(input.cwd ? { cwd: resolve(input.cwd) } : {}),
        ...(input.projectRoot ? { projectRoot: resolve(input.projectRoot) } : {}),
        ...(input.worktreeBranch ? { worktreeBranch: input.worktreeBranch } : {}),
        managedByPiora: false,
        boundAt: Date.now(),
        status: "ready",
      },
      joinedAt: Date.now(),
    } as RoomMember));
  }
  room.updatedAt = Date.now();
  const saved = room.members.find((member) => member.sessionId === input.sessionId)!;
  if (saved.role === "coordinator") {
    for (const member of room.members) if (member.memberId !== saved.memberId && member.role === "coordinator") member.role = "participant";
    room.coordination.coordinatorMemberId = saved.memberId;
  }
  room.coordination.defaultReviewerMemberIds = room.members.filter((member) => member.role === "reviewer").map((member) => member.memberId);
  mkdirSync(join(room.paths.privateRoot, safeMemberDirectory(saved.memberId)), { recursive: true });
  writeRoom(room);
  appendRoomAudit(roomId, input.requestedBy ?? input.sessionId, existing ? "member.updated" : "member.added", existing
    ? `更新智能体「${saved.name || saved.sessionId}」的资料。`
    : `智能体「${saved.name || saved.sessionId}」加入协作空间。`);
  emitRoomEvent({ type: "room", roomId: room.id, room });
  if (!existing) {
    appendRoomMessage(roomId, {
      authorKind: "system",
      authorId: "piora",
      authorName: `${APP_DISPLAY_NAME}`,
      content: `${input.name || input.sessionId} 加入了协作空间。`,
    });
  }
  return getRoom(roomId);
}

export function addManagedRoomMember(roomId: string, input: {
  memberId: string;
  profile: TeamAgentProfile;
  binding: TeamAgentBinding;
  requestedBy: string;
}): CollaborationRoom {
  let saved!: CollaborationRoom;
  withRoomLockSync(roomId, () => {
    const room = getRoom(roomId);
    requireCoordinator(room, input.requestedBy);
    if (room.members.some((member) => member.memberId === input.memberId)) {
      throw new Error("该智能体已存在于协作空间中。");
    }
    if (room.members.some((member) => member.binding.sessionId === input.binding.sessionId)) {
      throw new Error("该会话已绑定到协作空间中的其他智能体。");
    }
    const profile = validateTeamAgentProfile(structuredClone(input.profile));
    const binding = structuredClone(input.binding);
    if (!binding.sessionId || !binding.managedByPiora) {
      throw new Error(`托管智能体必须绑定到由 ${APP_DISPLAY_NAME} 创建的会话。`);
    }
    if (binding.cwd) binding.cwd = resolve(binding.cwd);
    if (binding.projectRoot) binding.projectRoot = resolve(binding.projectRoot);
    const member = attachMemberAliases({
      memberId: input.memberId,
      profile,
      binding,
      joinedAt: Date.now(),
    } as RoomMember);
    room.members.push(member);
    if (profile.role === "coordinator") {
      for (const candidate of room.members) {
        if (candidate.memberId !== member.memberId && candidate.profile.role === "coordinator") {
          candidate.profile.role = "participant";
        }
      }
      room.coordination.coordinatorMemberId = member.memberId;
    }
    room.coordination.defaultReviewerMemberIds = room.members
      .filter((candidate) => candidate.profile.role === "reviewer")
      .map((candidate) => candidate.memberId);
    room.updatedAt = Date.now();
    mkdirSync(join(room.paths.privateRoot, safeMemberDirectory(member.memberId)), { recursive: true });
    writeRoom(room);
    saved = room;
  });
  appendRoomAudit(roomId, input.requestedBy, "member.added", `托管智能体「${input.profile.name}」加入协作空间。`);
  emitRoomEvent({ type: "room", roomId, room: saved });
  appendRoomMessage(roomId, {
    authorKind: "system",
    authorId: "piora",
    authorName: `${APP_DISPLAY_NAME}`,
    content: `${input.profile.name} 加入了协作空间。`,
  });
  return getRoom(roomId);
}

export function removeRoomMember(roomId: string, sessionId: string, requestedBy?: string): CollaborationRoom {
  const room = getRoom(roomId);
  if (requestedBy) {
    const requester = requireMember(room, requestedBy);
    if (requestedBy !== sessionId && requester.role !== "coordinator" && room.coordination.coordinatorSessionId !== requestedBy) {
      throw new Error("只有协调者可以移出其他智能体。");
    }
  }
  const member = room.members.find((item) => item.sessionId === sessionId);
  if (!member) return room;
  if (room.members.length === 1) throw new Error("协作空间至少需要保留一个智能体。");
  const activeTask = listRoomTasks(roomId).find((task) => task.assignedTo === sessionId && (task.status === "leased" || task.status === "running"));
  if (activeTask) throw new Error("请先完成或释放该智能体的运行中任务，再将其移出。");
  for (const task of listRoomTasks(roomId)) {
    if (task.assignedTo === sessionId && task.status === "pending") {
      task.assignedTo = undefined;
      task.updatedAt = Date.now();
      writeTask(task);
    }
  }
  room.members = room.members.filter((item) => item.sessionId !== sessionId);
  room.coordination.defaultReviewerMemberIds = room.members.filter((candidate) => candidate.role === "reviewer").map((candidate) => candidate.memberId);
  if (room.coordination.coordinatorSessionId === sessionId || member.role === "coordinator") {
    const replacement = room.members[0];
    replacement.role = "coordinator";
    room.coordination.coordinatorMemberId = replacement.memberId;
  }
  room.updatedAt = Date.now();
  writeRoom(room);
  appendRoomAudit(roomId, requestedBy ?? sessionId, "member.removed", `将智能体「${member.name || member.sessionId}」移出协作空间。`);
  emitRoomEvent({ type: "room", roomId: room.id, room });
  appendRoomMessage(roomId, {
    authorKind: "system",
    authorId: "piora",
    authorName: `${APP_DISPLAY_NAME}`,
    content: `${member.name || member.sessionId} 已离开协作空间。`,
  });
  return getRoom(roomId);
}

export function deleteRoom(roomId: string, requestedBy: string): void {
  const room = getRoom(roomId);
  const member = requireMember(room, requestedBy);
  if (member.role !== "coordinator" && room.coordination.coordinatorSessionId !== requestedBy) {
    throw new Error("Only the room coordinator can delete this collaboration room.");
  }
  emitRoomEvent({ type: "room", roomId, room });
  const paths = roomPaths(roomId);
  rmSync(paths.root, { recursive: true, force: false });
  roomListeners().delete(roomId);
  roomEventListeners().delete(roomId);
}

function requireMember(room: CollaborationRoom, sessionId: string): RoomMember {
  const member = room.members.find((item) => item.sessionId === sessionId);
  if (!member) throw new Error("This session is not a member of the collaboration room.");
  return member;
}

function requireCoordinator(room: CollaborationRoom, sessionId: string): RoomMember {
  const member = requireMember(room, sessionId);
  if (member.role !== "coordinator" && room.coordination.coordinatorSessionId !== sessionId) {
    throw new Error("Only the room coordinator can change collaboration settings.");
  }
  return member;
}

export function getPrivateRoomDirectory(roomId: string, sessionId: string): string {
  const room = getRoom(roomId);
  const member = requireMember(room, sessionId);
  return join(room.paths.privateRoot, safeMemberDirectory(member.memberId));
}

export function updateRoomProfile(roomId: string, requestedBy: string, input: { name: string; description?: string }): CollaborationRoom {
  const room = getRoom(roomId);
  requireCoordinator(room, requestedBy);
  const previousName = room.name;
  room.name = cleanText(input.name, MAX_ROOM_NAME_LENGTH);
  room.description = input.description?.trim().slice(0, 2_000) ?? "";
  room.updatedAt = Date.now();
  writeRoom(room);
  appendRoomAudit(roomId, requestedBy, "room.updated", `更新协作空间资料：「${room.name}」。`);
  emitRoomEvent({ type: "room", roomId, room });
  if (previousName !== room.name) {
    appendRoomMessage(roomId, { authorKind: "system", authorId: "piora", authorName: `${APP_DISPLAY_NAME}`, content: `协作空间已从「${previousName}」更名为「${room.name}」。` });
  }
  return getRoom(roomId);
}

function isInside(parent: string, target: string): boolean {
  const path = relative(resolve(parent), resolve(target));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export function updateRoomWorkspace(roomId: string, requestedBy: string, input: {
  mode: "managed" | "custom";
  path?: string;
  label?: string;
  instructions?: string;
}): CollaborationRoom {
  const room = getRoom(roomId);
  requireCoordinator(room, requestedBy);
  const paths = roomPaths(roomId);
  const workspacePath = input.mode === "managed" ? paths.workspace : resolve(cleanText(input.path ?? "", 2_000));
  const memberRoots = room.members.flatMap((member) => [member.projectRoot, member.cwd]).filter((root): root is string => Boolean(root));
  if (input.mode === "custom" && !memberRoots.some((root) => isInside(root, workspacePath))) {
    throw new Error("The shared workspace must stay inside one of the room members' projects.");
  }
  mkdirSync(workspacePath, { recursive: true });
  room.workspace = {
    mode: input.mode,
    path: workspacePath,
    label: input.label?.trim().slice(0, 120) || "共享工作区",
    instructions: input.instructions?.trim().slice(0, 4_000) ?? "",
    defaultAgentWorkspace: room.workspace.defaultAgentWorkspace ?? "dedicated_worktree",
  };
  room.updatedAt = Date.now();
  writeRoom(room);
  appendRoomAudit(roomId, requestedBy, "workspace.updated", `将共享工作区修改为 ${workspacePath}。`);
  emitRoomEvent({ type: "room", roomId, room });
  appendRoomMessage(roomId, { authorKind: "system", authorId: "piora", authorName: `${APP_DISPLAY_NAME}`, content: `共享工作区已修改为 ${workspacePath}。` });
  return getRoom(roomId);
}

export function updateRoomMember(roomId: string, requestedBy: string, memberId: string, input: {
  sessionId?: string;
  name?: string;
  instructions?: string;
  role?: RoomMemberRole;
  cwd?: string;
  projectRoot?: string;
  worktreeBranch?: string;
}): CollaborationRoom {
  const room = getRoom(roomId);
  requireCoordinator(room, requestedBy);
  const member = room.members.find((candidate) => candidate.memberId === memberId);
  if (!member) throw new Error("未找到协作智能体。");
  const previousSessionId = member.sessionId;
  const nextSessionId = input.sessionId ?? previousSessionId;
  if (room.coordination.coordinatorSessionId === previousSessionId && input.role && input.role !== "coordinator") {
    throw new Error("更改协调者角色前，请先将协调权转交给其他智能体。");
  }
  if (nextSessionId !== previousSessionId && room.members.some((candidate) => candidate.sessionId === nextSessionId)) {
    throw new Error("该会话已绑定到协作空间中的其他智能体。");
  }
  if (input.projectRoot && room.projectRoot && resolve(input.projectRoot) !== resolve(room.projectRoot)) {
    throw new Error("该会话属于其他项目，无法绑定到这个智能体。");
  }
  if (nextSessionId !== previousSessionId) {
    const activeTask = listRoomTasks(roomId).find((task) => task.assignedTo === previousSessionId && (task.status === "leased" || task.status === "running"));
    if (activeTask) throw new Error("更换会话前，请先完成或释放该智能体的运行中任务。");
    for (const task of listRoomTasks(roomId)) {
      if (task.assignedTo === previousSessionId && task.status === "pending") {
        task.assignedTo = nextSessionId;
        task.updatedAt = Date.now();
        writeTask(task);
      }
    }
    if (room.coordination.coordinatorSessionId === previousSessionId) room.coordination.coordinatorSessionId = nextSessionId;
    // Rebinding a managed member to an existing chat does not transfer ownership.
    member.binding.managedByPiora = false;
  }
  member.sessionId = nextSessionId;
  member.name = input.name?.trim().slice(0, 120) || member.name || nextSessionId.slice(0, 8);
  member.instructions = input.instructions?.trim().slice(0, 4_000) ?? member.instructions ?? "";
  member.role = input.role ?? member.role;
  member.profile.revision += 1;
  member.cwd = input.cwd ?? member.cwd;
  member.projectRoot = input.projectRoot ?? member.projectRoot;
  member.worktreeBranch = input.worktreeBranch;
  if (member.role === "coordinator") {
    for (const candidate of room.members) if (candidate.memberId !== member.memberId && candidate.role === "coordinator") candidate.role = "participant";
    room.coordination.coordinatorSessionId = member.sessionId;
  }
  room.coordination.defaultReviewerMemberIds = room.members.filter((candidate) => candidate.role === "reviewer").map((candidate) => candidate.memberId);
  room.updatedAt = Date.now();
  writeRoom(room);
  appendRoomAudit(roomId, requestedBy, "member.updated", `更新智能体「${member.name || member.sessionId}」的身份与职责。`);
  emitRoomEvent({ type: "room", roomId, room });
  appendRoomMessage(roomId, {
    authorKind: "system", authorId: "piora", authorName: `${APP_DISPLAY_NAME}`,
    content: nextSessionId === previousSessionId ? `${member.name} 的身份与职责已更新。` : `${member.name} 已换绑到会话 ${nextSessionId.slice(0, 8)}。`,
  });
  return getRoom(roomId);
}

export function updateRoomAgentProfile(
  roomId: string,
  requestedBy: string,
  memberId: string,
  expectedRevision: number,
  patch: Partial<Omit<TeamAgentProfile, "schemaVersion" | "revision">>,
): CollaborationRoom {
  let room!: CollaborationRoom;
  withRoomLockSync(roomId, () => {
    room = getRoom(roomId);
    requireCoordinator(room, requestedBy);
    const member = room.members.find((candidate) => candidate.memberId === memberId);
    if (!member) throw new Error("未找到协作智能体。");
    if (member.profile.revision !== expectedRevision) {
      const error = new Error("保存前智能体配置已发生变化，请刷新后重试。") as Error & { code?: string; status?: number };
      error.code = "TEAM_REVISION_CONFLICT";
      error.status = 409;
      throw error;
    }
    if (member.memberId === room.coordination.coordinatorMemberId && patch.role && patch.role !== "coordinator") {
      throw new Error("Transfer coordination before changing the coordinator role.");
    }
    member.profile = validateTeamAgentProfile({
      ...member.profile,
      ...structuredClone(patch),
      schemaVersion: 1,
      revision: member.profile.revision + 1,
    });
    if (member.binding.managedByPiora) member.binding.status = "needs_restart";
    attachMemberAliases(member);
    if (member.profile.role === "coordinator") {
      for (const candidate of room.members) {
        if (candidate.memberId !== member.memberId && candidate.profile.role === "coordinator") candidate.profile.role = "participant";
      }
      room.coordination.coordinatorMemberId = member.memberId;
    }
    room.coordination.defaultReviewerMemberIds = room.members
      .filter((candidate) => candidate.profile.role === "reviewer")
      .map((candidate) => candidate.memberId);
    room.updatedAt = Date.now();
    writeRoom(room);
  });
  const savedMember = room.members.find((candidate) => candidate.memberId === memberId)!;
  appendRoomAudit(roomId, requestedBy, "member.updated", `更新智能体「${savedMember.profile.name}」的配置。`);
  emitRoomEvent({ type: "room", roomId: room.id, room });
  return getRoom(roomId);
}

export function updateRoomAgentBinding(
  roomId: string,
  requestedBy: string,
  memberId: string,
  binding: Partial<RoomMember["binding"]> & { sessionId?: string },
): CollaborationRoom {
  let saved!: CollaborationRoom;
  withRoomLockSync(roomId, () => {
    const room = getRoom(roomId);
    requireCoordinator(room, requestedBy);
    const member = room.members.find((candidate) => candidate.memberId === memberId);
    if (!member) throw new Error("未找到协作智能体。");
    const sessionId = binding.sessionId ?? member.binding.sessionId;
    if (room.members.some((candidate) => candidate.memberId !== memberId && candidate.binding.sessionId === sessionId)) {
      throw new Error("该会话已绑定到协作空间中的其他智能体。");
    }
    member.binding = {
      ...member.binding,
      ...structuredClone(binding),
      sessionId,
      boundAt: binding.boundAt ?? Date.now(),
    };
    attachMemberAliases(member);
    room.updatedAt = Date.now();
    writeRoom(room);
    saved = room;
  });
  appendRoomAudit(roomId, requestedBy, "member.updated", `更新智能体「${saved.members.find((member) => member.memberId === memberId)?.profile.name ?? memberId}」的会话绑定。`);
  emitRoomEvent({ type: "room", roomId, room: saved });
  return getRoom(roomId);
}

export function listRoomMessages(roomId: string, options: { afterSeq?: number; beforeSeq?: number; limit?: number } = {}): RoomMessage[] {
  const path = roomPaths(roomId).messages;
  getRoom(roomId);
  if (!existsSync(path)) return [];
  const afterSeq = Math.max(0, options.afterSeq ?? 0);
  const limit = Math.max(1, Math.min(500, options.limit ?? 200));
  const messages = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const message = JSON.parse(line) as RoomMessage;
        message.payload ??= {
          byteLength: Buffer.byteLength(message.content, "utf8"),
          lineCount: message.content.split(/\r?\n/).length,
          sha256: createHash("sha256").update(message.content, "utf8").digest("hex"),
          truncated: false,
        };
        return [message];
      } catch { return []; }
    })
    .filter((message) => message.roomId === roomId && message.seq > afterSeq && (options.beforeSeq === undefined || message.seq < options.beforeSeq));
  return messages.slice(-limit);
}

export function appendRoomMessage(roomId: string, input: {
  authorKind: RoomMessageAuthorKind;
  authorId: string;
  authorName?: string;
  content: string;
  replyTo?: string;
  correlationId?: string;
  clientPromptId?: string;
  promptRunId?: string;
  threadRootId?: string;
  teamRunId?: string;
  taskId?: string;
  kind?: RoomMessage["kind"];
  targetMemberIds?: string[];
  attachments?: RoomMessage["attachments"];
  forwardDepth?: number;
  autoRound?: number;
  maxAutoRounds?: number;
}): RoomMessage {
  const fullContent = requireUtf8Text(input.content, "群聊消息", MAX_MESSAGE_BYTES);
  const correlationId = input.correlationId ? cleanText(input.correlationId, 240) : undefined;
  let message!: RoomMessage;
  let created = false;
  withRoomLockSync(roomId, () => {
    const room = getRoom(roomId);
    if (input.authorKind === "session") requireMember(room, input.authorId);
    const paths = roomPaths(roomId);
    const parent = input.replyTo ? findRoomMessage(roomId, input.replyTo) : undefined;
    if (correlationId && existsSync(paths.messages)) {
      for (const line of readFileSync(paths.messages, "utf8").split(/\r?\n/)) {
        if (!line) continue;
        try {
          const existing = JSON.parse(line) as RoomMessage;
          if (existing.roomId === roomId && existing.correlationId === correlationId) {
            message = existing;
            return;
          }
        } catch { /* Preserve legacy log tolerance. */ }
      }
    }
    const id = randomUUID();
    const byteLength = Buffer.byteLength(fullContent, "utf8");
    const lineCount = fullContent.split(/\r?\n/).length;
    const truncated = byteLength > TEAM_DEFAULTS.messageBlobThresholdBytes;
    const preview = truncated
      ? fullContent.split(/\r?\n/).slice(0, TEAM_DEFAULTS.previewLines).join("\n").slice(0, TEAM_DEFAULTS.collapseAfterChars)
      : fullContent;
    message = {
      id,
      roomId,
      seq: room.nextSeq,
      author: { kind: input.authorKind, id: input.authorId, ...(input.authorName ? { name: input.authorName } : {}) },
      content: preview,
      payload: {
        byteLength,
        lineCount,
        sha256: createHash("sha256").update(fullContent, "utf8").digest("hex"),
        truncated,
        ...(truncated ? { payloadRef: id } : {}),
      },
      createdAt: Date.now(),
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      ...(correlationId ? { correlationId } : {}),
      ...(input.clientPromptId ? { clientPromptId: input.clientPromptId } : {}),
      ...(input.promptRunId ? { promptRunId: input.promptRunId } : {}),
      ...((input.threadRootId ?? parent?.threadRootId) ? { threadRootId: input.threadRootId ?? parent?.threadRootId } : {}),
      ...(input.teamRunId ? { teamRunId: input.teamRunId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.targetMemberIds?.length ? { targetMemberIds: input.targetMemberIds } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      // Nine is the exhausted sentinel: clamping at eight would keep the final
      // allowed round dispatchable forever after each subsequent reply.
      ...(input.forwardDepth !== undefined ? { forwardDepth: Math.max(0, Math.min(9, Math.floor(input.forwardDepth))) } : {}),
      ...(input.autoRound !== undefined ? { autoRound: Math.max(0, Math.min(9, Math.floor(input.autoRound))) } : {}),
      ...(input.maxAutoRounds !== undefined ? { maxAutoRounds: Math.max(0, Math.min(8, Math.floor(input.maxAutoRounds))) } : {}),
    };
    mkdirSync(paths.shared, { recursive: true });
    if (truncated) {
      mkdirSync(paths.messageBlobs, { recursive: true, mode: 0o700 });
      writeFileSync(join(paths.messageBlobs, `${id}.txt`), fullContent, { encoding: "utf8", mode: 0o600, flush: true });
    }
    appendFileSync(paths.messages, `${JSON.stringify(message)}\n`, { encoding: "utf8", mode: 0o600, flush: true });
    room.nextSeq += 1;
    room.updatedAt = message.createdAt;
    writeRoom(room);
    created = true;
  });
  if (!created) return message;
  for (const listener of roomListeners().get(roomId) ?? []) listener(message);
  emitRoomEvent({ type: "message", roomId, message });
  return message;
}

export function readRoomMessageFullContent(roomId: string, messageOrId: RoomMessage | string): string {
  const message = typeof messageOrId === "string"
    ? findRoomMessage(roomId, messageOrId)
    : messageOrId;
  if (!message || message.roomId !== roomId) throw new Error("未找到群聊消息。");
  if (!message.payload.truncated) return message.content;
  if (message.payload.payloadRef !== message.id) throw new Error("群聊消息内容引用无效。");
  const path = join(roomPaths(roomId).messageBlobs, `${message.id}.txt`);
  if (!existsSync(path)) throw new Error("群聊消息内容缺失。");
  const content = readFileSync(path, "utf8");
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  if (hash !== message.payload.sha256 || Buffer.byteLength(content, "utf8") !== message.payload.byteLength) {
    throw new Error("群聊消息内容完整性校验失败。");
  }
  return content;
}

export function findRoomMessage(roomId: string, messageId: string): RoomMessage | undefined {
  const path = roomPaths(roomId).messages;
  getRoom(roomId);
  if (!existsSync(path)) return undefined;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line) continue;
    try {
      const message = JSON.parse(line) as RoomMessage;
      if (message.roomId === roomId && message.id === messageId) return message;
    } catch { /* Preserve the legacy Room log reader's tolerance. */ }
  }
  return undefined;
}

export function findRoomMessageByCorrelationId(roomId: string, correlationId: string): RoomMessage | undefined {
  const path = roomPaths(roomId).messages;
  getRoom(roomId);
  if (!existsSync(path)) return undefined;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line) continue;
    try {
      const message = JSON.parse(line) as RoomMessage;
      if (message.roomId === roomId && message.correlationId === correlationId) return message;
    } catch { /* Preserve the legacy Room log reader's tolerance. */ }
  }
  return undefined;
}

export function emitRoomPresence(roomId: string, presence: Omit<RoomPresence, "updatedAt"> & { updatedAt?: number }): void {
  getRoom(roomId);
  emitRoomEvent({
    type: "presence",
    roomId,
    presence: { ...presence, updatedAt: presence.updatedAt ?? Date.now() },
  });
}

export function configureRoomCoordination(roomId: string, input: {
  mode: "manual" | "coordinator" | "team";
  coordinatorSessionId?: string;
  maxConcurrency?: number;
  leaseDurationMs?: number;
  requestedBy?: string;
}): CollaborationRoom {
  const room = getRoom(roomId);
  if (input.requestedBy) requireCoordinator(room, input.requestedBy);
  if (input.coordinatorSessionId) requireMember(room, input.coordinatorSessionId);
  const coordinator = input.coordinatorSessionId
    ? room.members.find((member) => member.sessionId === input.coordinatorSessionId)
    : room.members.find((member) => member.memberId === room.coordination.coordinatorMemberId);
  room.coordination = {
    ...room.coordination,
    mode: input.mode === "manual" ? "manual" : "team",
    coordinatorMemberId: coordinator?.memberId ?? room.coordination.coordinatorMemberId,
    maxConcurrency: Math.max(1, Math.min(16, Math.floor(input.maxConcurrency ?? room.coordination?.maxConcurrency ?? 2))),
    leaseDurationMs: Math.max(30_000, Math.min(60 * 60_000, Math.floor(input.leaseDurationMs ?? room.coordination?.leaseDurationMs ?? 5 * 60_000))),
  };
  attachRoomAliases(room);
  if (input.coordinatorSessionId) {
    for (const member of room.members) {
      if (member.sessionId === input.coordinatorSessionId) member.role = "coordinator";
      else if (member.role === "coordinator") member.role = "participant";
    }
  }
  room.updatedAt = Date.now();
  writeRoom(room);
  appendRoomAudit(roomId, input.requestedBy ?? input.coordinatorSessionId ?? "piora", "coordination.updated", `编排模式已设为${room.coordination.mode === "team" ? "协调者编排" : "手动协作"}，最大并发 ${room.coordination.maxConcurrency}。`);
  emitRoomEvent({ type: "room", roomId, room });
  return room;
}

function taskPath(roomId: string, taskId: string): string {
  if (!ROOM_ID_PATTERN.test(taskId)) throw new Error("Invalid room task id.");
  return join(roomPaths(roomId).tasks, `${taskId}.json`);
}

function writeTask(task: RoomTask): void {
  const path = taskPath(task.roomId, task.id);
  mkdirSync(roomPaths(task.roomId).tasks, { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(task, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
  emitRoomEvent({ type: "task", roomId: task.roomId, task });
}

export function getRoomTask(roomId: string, taskId: string): RoomTask {
  getRoom(roomId);
  const path = taskPath(roomId, taskId);
  if (!existsSync(path)) throw new Error("未找到协作任务。");
  return JSON.parse(readFileSync(path, "utf8")) as RoomTask;
}

function recycleExpiredTask(task: RoomTask, now = Date.now()): RoomTask {
  if ((task.status !== "leased" && task.status !== "running") || !task.lease || task.lease.expiresAt > now) return task;
  task.lease = undefined;
  task.assignedTo = undefined;
  task.updatedAt = now;
  if (task.attempt >= task.maxAttempts) {
    task.status = "failed";
    task.error = "Task lease expired after the maximum number of attempts.";
  } else {
    task.status = "pending";
    task.error = "Previous task lease expired and was released for retry.";
  }
  writeTask(task);
  return task;
}

export function listRoomTasks(roomId: string): RoomTask[] {
  const paths = roomPaths(roomId);
  getRoom(roomId);
  if (!existsSync(paths.tasks)) return [];
  const tasks = readdirSync(paths.tasks, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".json")) return [];
    try {
      return [recycleExpiredTask(JSON.parse(readFileSync(join(paths.tasks, entry.name), "utf8")) as RoomTask)];
    } catch {
      return [];
    }
  });
  return tasks.sort((left, right) => right.priority - left.priority || left.createdAt - right.createdAt);
}

export function createRoomTask(roomId: string, input: {
  title: string;
  description: string;
  createdBy: string;
  assignedTo?: string;
  dedupeKey?: string;
  priority?: number;
  dependsOn?: string[];
  maxAttempts?: number;
}): RoomTask {
  const room = getRoom(roomId);
  requireMember(room, input.createdBy);
  if (input.assignedTo) requireMember(room, input.assignedTo);
  const dedupeKey = input.dedupeKey?.trim().slice(0, 200);
  if (dedupeKey) {
    const existing = listRoomTasks(roomId).find((task) => task.dedupeKey === dedupeKey && task.status !== "cancelled" && task.status !== "failed");
    if (existing) return existing;
  }
  const now = Date.now();
  const task: RoomTask = {
    schemaVersion: 1,
    id: randomUUID(),
    roomId,
    title: cleanText(input.title, 240),
    description: cleanText(input.description, 64 * 1024),
    status: "pending",
    priority: Math.max(-100, Math.min(100, Math.floor(input.priority ?? 0))),
    createdBy: input.createdBy,
    ...(input.assignedTo ? { assignedTo: input.assignedTo } : {}),
    ...(dedupeKey ? { dedupeKey } : {}),
    dependsOn: [...new Set(input.dependsOn ?? [])],
    attempt: 0,
    maxAttempts: Math.max(1, Math.min(10, Math.floor(input.maxAttempts ?? 3))),
    createdAt: now,
    updatedAt: now,
  };
  writeTask(task);
  return task;
}

function dependenciesComplete(task: RoomTask, tasks: RoomTask[]): boolean {
  return task.dependsOn.every((id) => tasks.some((candidate) => candidate.id === id && candidate.status === "completed"));
}

export function claimRoomTask(roomId: string, taskId: string, sessionId: string): RoomTask {
  const room = getRoom(roomId);
  requireMember(room, sessionId);
  const tasks = listRoomTasks(roomId);
  const task = tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error("未找到协作任务。");
  if (task.status !== "pending") throw new Error(`协作任务当前状态为 ${task.status}，无法重复领取。`);
  if (task.assignedTo && task.assignedTo !== sessionId) throw new Error("协作任务已分配给其他会话。");
  if (!dependenciesComplete(task, tasks)) throw new Error("协作任务的依赖项尚未完成。");
  const activeCount = tasks.filter((candidate) => candidate.status === "leased" || candidate.status === "running").length;
  if (activeCount >= room.coordination.maxConcurrency) throw new Error("已达到协作空间的最大并发数。");
  const member = requireMember(room, sessionId);
  if (member.cwd) {
    const workspaceBusy = tasks.some((candidate) => (
      (candidate.status === "leased" || candidate.status === "running")
      && candidate.assignedTo !== sessionId
      && candidate.workspace?.cwd
      && resolve(candidate.workspace.cwd) === resolve(member.cwd!)
    ));
    if (workspaceBusy) throw new Error("This workspace already has an active room task; use a separate worktree for parallel work.");
  }
  const now = Date.now();
  task.status = "leased";
  task.assignedTo = sessionId;
  task.attempt += 1;
  task.lease = {
    holderSessionId: sessionId,
    token: randomUUID(),
    acquiredAt: now,
    heartbeatAt: now,
    expiresAt: now + room.coordination.leaseDurationMs,
  };
  if (member.cwd) {
    task.workspace = {
      cwd: member.cwd,
      ...(member.projectRoot ? { projectRoot: member.projectRoot } : {}),
      ...(member.worktreeBranch ? { worktreeBranch: member.worktreeBranch } : {}),
    };
  }
  task.updatedAt = now;
  writeTask(task);
  return task;
}

function requireLease(task: RoomTask, sessionId: string, token: string): void {
  if (!task.lease || task.lease.holderSessionId !== sessionId || task.lease.token !== token) {
    throw new Error("A valid task lease token owned by this session is required.");
  }
  if (task.lease.expiresAt <= Date.now()) throw new Error("The task lease has expired.");
}

export function heartbeatRoomTask(roomId: string, taskId: string, sessionId: string, token: string): RoomTask {
  const room = getRoom(roomId);
  const task = getRoomTask(roomId, taskId);
  requireLease(task, sessionId, token);
  const now = Date.now();
  task.status = "running";
  task.lease!.heartbeatAt = now;
  task.lease!.expiresAt = now + room.coordination.leaseDurationMs;
  task.updatedAt = now;
  writeTask(task);
  return task;
}

export function releaseRoomTaskLease(roomId: string, taskId: string, sessionId: string, token: string, reason: string): RoomTask {
  const task = getRoomTask(roomId, taskId);
  requireLease(task, sessionId, token);
  task.status = task.attempt >= task.maxAttempts ? "failed" : "pending";
  task.error = cleanText(reason, 64 * 1024);
  task.lease = undefined;
  task.assignedTo = undefined;
  task.updatedAt = Date.now();
  writeTask(task);
  return task;
}

export function finishRoomTask(roomId: string, taskId: string, sessionId: string, token: string, input: {
  status: "completed" | "failed" | "blocked";
  result: string;
}): RoomTask {
  const task = getRoomTask(roomId, taskId);
  if (task.status === input.status && !task.lease && task.assignedTo === sessionId && task.finalizedLeaseToken === token) return task;
  requireLease(task, sessionId, token);
  task.status = input.status;
  if (input.status === "completed") task.result = cleanText(input.result, 64 * 1024);
  else task.error = cleanText(input.result, 64 * 1024);
  task.lease = undefined;
  task.finalizedLeaseToken = token;
  task.updatedAt = Date.now();
  writeTask(task);
  return task;
}

function artifactMetadataPath(roomId: string, artifactId: string): string {
  if (!ROOM_ID_PATTERN.test(artifactId)) throw new Error("Invalid room artifact id.");
  return join(roomPaths(roomId).artifacts, `${artifactId}.json`);
}

export function listRoomArtifacts(roomId: string): RoomArtifact[] {
  const paths = roomPaths(roomId);
  getRoom(roomId);
  if (!existsSync(paths.artifacts)) return [];
  return readdirSync(paths.artifacts, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isFile() || !ROOM_ID_PATTERN.test(entry.name.replace(/\.json$/, "")) || !entry.name.endsWith(".json")) return [];
    try { return [JSON.parse(readFileSync(join(paths.artifacts, entry.name), "utf8")) as RoomArtifact]; } catch { return []; }
  }).sort((left, right) => left.createdAt - right.createdAt);
}

export function publishRoomArtifact(roomId: string, sessionId: string, input: {
  taskId?: string;
  kind: RoomArtifactKind;
  name: string;
  summary: string;
  sourcePath?: string;
  content?: string;
}): RoomArtifact {
  const room = getRoom(roomId);
  const member = requireMember(room, sessionId);
  if (input.taskId) {
    const task = getRoomTask(roomId, input.taskId);
    if (task.assignedTo !== sessionId && task.createdBy !== sessionId) throw new Error("This session is not associated with the artifact task.");
  }
  const id = randomUUID();
  const paths = roomPaths(roomId);
  mkdirSync(paths.artifacts, { recursive: true });
  let storedPath: string | undefined;
  let sourcePath: string | undefined;
  if (input.sourcePath) {
    if (!member.cwd) throw new Error("The room member has no registered workspace.");
    sourcePath = resolve(member.cwd, input.sourcePath);
    const inside = relative(resolve(member.cwd), sourcePath);
    if (inside.startsWith("..") || isAbsolute(inside)) throw new Error("Artifact source must stay inside this session's workspace.");
    const realWorkspace = realpathSync(member.cwd);
    const realSource = realpathSync(sourcePath);
    const realInside = relative(realWorkspace, realSource);
    if (realInside.startsWith("..") || isAbsolute(realInside)) throw new Error("Artifact source symbolic link escapes this session's workspace.");
    sourcePath = realSource;
    const stat = statSync(sourcePath);
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) throw new Error("Artifact source must be a file no larger than 5 MB.");
    const safeName = basename(sourcePath).replace(/[^a-zA-Z0-9._-]/g, "_");
    storedPath = join(paths.artifacts, `${id}-${safeName}`);
    copyFileSync(sourcePath, storedPath);
  } else if (input.content !== undefined) {
    if (Buffer.byteLength(input.content, "utf8") > 5 * 1024 * 1024) throw new Error("Artifact content must be no larger than 5 MB.");
    const safeName = basename(input.name).replace(/[^a-zA-Z0-9._-]/g, "_") || "artifact.txt";
    storedPath = join(paths.artifacts, `${id}-${safeName}`);
    writeFileSync(storedPath, input.content, "utf8");
  }
  const artifact: RoomArtifact = {
    schemaVersion: 1,
    id,
    roomId,
    sessionId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    kind: input.kind,
    name: cleanText(input.name, 240),
    summary: cleanText(input.summary, 4_000),
    ...(sourcePath ? { sourcePath } : {}),
    ...(storedPath ? { storedPath } : {}),
    worktree: {
      cwd: member.cwd,
      projectRoot: member.projectRoot,
      branch: member.worktreeBranch,
    },
    createdAt: Date.now(),
  };
  writeFileSync(artifactMetadataPath(roomId, id), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  emitRoomEvent({ type: "artifact", roomId, artifact });
  return artifact;
}

export function subscribeRoomEvents(roomId: string, listener: RoomEventListener): () => void {
  getRoom(roomId);
  const listeners = roomEventListeners();
  const set = listeners.get(roomId) ?? new Set<RoomEventListener>();
  set.add(listener);
  listeners.set(roomId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(roomId);
  };
}

export function appendPrivateNote(roomId: string, sessionId: string, content: string): PrivateRoomNote {
  const room = getRoom(roomId);
  requireMember(room, sessionId);
  const directory = getPrivateRoomDirectory(roomId, sessionId);
  mkdirSync(directory, { recursive: true });
  const note: PrivateRoomNote = { id: randomUUID(), roomId, sessionId, content: cleanText(content, 64 * 1024), createdAt: Date.now() };
  appendFileSync(join(directory, "notes.jsonl"), `${JSON.stringify(note)}\n`, "utf8");
  return note;
}

export function listPrivateNotes(roomId: string, sessionId: string, limit = 100): PrivateRoomNote[] {
  const room = getRoom(roomId);
  requireMember(room, sessionId);
  const path = join(getPrivateRoomDirectory(roomId, sessionId), "notes.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as PrivateRoomNote]; } catch { return []; }
  }).slice(-Math.max(1, Math.min(500, limit)));
}

export function subscribeRoom(roomId: string, listener: RoomListener): () => void {
  getRoom(roomId);
  const listeners = roomListeners();
  const set = listeners.get(roomId) ?? new Set<RoomListener>();
  set.add(listener);
  listeners.set(roomId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(roomId);
  };
}
