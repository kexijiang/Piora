import type {
  CollaborationRoomV3,
  RoomMemberV3,
  TeamAgentRole,
} from "./team-types";

export const ROOM_SCHEMA_VERSION = 3 as const;
export type RoomMemberRole = TeamAgentRole;
export type RoomMessageAuthorKind = "user" | "session" | "system";

/**
 * Runtime v3 member with non-enumerable v2 aliases attached by room-store.
 * New code should use profile/binding or the compatibility helpers below.
 */
export interface RoomMember extends RoomMemberV3 {
  /** @deprecated use binding.sessionId */
  sessionId: string;
  /** @deprecated use profile.name */
  name?: string;
  /** @deprecated use profile.roleDescription */
  instructions?: string;
  /** @deprecated use binding.cwd */
  cwd?: string;
  /** @deprecated use binding.projectRoot */
  projectRoot?: string;
  /** @deprecated use binding.worktreeBranch */
  worktreeBranch?: string;
  /** @deprecated use profile.role */
  role: RoomMemberRole;
}

export interface CollaborationRoom extends Omit<CollaborationRoomV3, "members" | "coordination"> {
  members: RoomMember[];
  coordination: {
    mode: "manual" | "team";
    coordinatorMemberId: string;
    plannerMemberId?: string;
    defaultReviewerMemberIds: string[];
    /** @deprecated runtime alias derived from coordinatorMemberId */
    coordinatorSessionId?: string;
    maxConcurrency: number;
    leaseDurationMs: number;
    maxRunSteps: number;
    maxTaskAttempts: number;
    requireReviewForCodeChanges: boolean;
  };
}

export function getRoomMemberName(member: RoomMemberV3 | RoomMember): string {
  return member.profile.name;
}

export function getRoomMemberRole(member: RoomMemberV3 | RoomMember): RoomMemberRole {
  return member.profile.role;
}

export function getRoomMemberSessionId(member: RoomMemberV3 | RoomMember): string {
  return member.binding.sessionId;
}

export function getRoomMemberInstructions(member: RoomMemberV3 | RoomMember): string {
  return member.profile.roleDescription;
}

export type RoomTaskStatus = "pending" | "leased" | "running" | "completed" | "failed" | "blocked" | "cancelled";

export interface RoomTaskLease {
  holderSessionId: string;
  token: string;
  acquiredAt: number;
  heartbeatAt: number;
  expiresAt: number;
}

export interface RoomTask {
  schemaVersion: 1;
  id: string;
  roomId: string;
  title: string;
  description: string;
  status: RoomTaskStatus;
  priority: number;
  createdBy: string;
  assignedTo?: string;
  dedupeKey?: string;
  dependsOn: string[];
  lease?: RoomTaskLease;
  attempt: number;
  maxAttempts: number;
  createdAt: number;
  updatedAt: number;
  result?: string;
  error?: string;
  finalizedLeaseToken?: string;
  workspace?: {
    cwd: string;
    projectRoot?: string;
    worktreeBranch?: string;
  };
}

export type RoomArtifactKind = "patch" | "commit" | "report" | "file";

export interface RoomArtifact {
  schemaVersion: 1;
  id: string;
  roomId: string;
  sessionId: string;
  taskId?: string;
  kind: RoomArtifactKind;
  name: string;
  summary: string;
  sourcePath?: string;
  storedPath?: string;
  worktree?: {
    cwd?: string;
    projectRoot?: string;
    branch?: string;
  };
  createdAt: number;
}

export type RoomEvent =
  | { type: "message"; roomId: string; message: RoomMessage }
  | { type: "presence"; roomId: string; presence: RoomPresence }
  | { type: "task"; roomId: string; task: RoomTask }
  | { type: "room"; roomId: string; room: CollaborationRoom }
  | { type: "artifact"; roomId: string; artifact: RoomArtifact }
  | { type: "audit"; roomId: string; audit: RoomAuditEntry };

export interface RoomAuditEntry {
  id: string;
  roomId: string;
  actorSessionId: string;
  action: "room.created" | "room.updated" | "member.added" | "member.updated" | "member.removed" | "workspace.updated" | "coordination.updated";
  summary: string;
  createdAt: number;
}

export interface RoomMessage {
  id: string;
  roomId: string;
  seq: number;
  author: {
    kind: RoomMessageAuthorKind;
    id: string;
    name?: string;
    memberId?: string;
    identitySource?: "local_account" | "room_member" | "system";
  };
  content: string;
  payload: RoomMessagePayloadMetadata;
  createdAt: number;
  replyTo?: string;
  correlationId?: string;
  clientPromptId?: string;
  promptRunId?: string;
  threadRootId?: string;
  teamRunId?: string;
  taskId?: string;
  kind?: "message" | "handoff" | "question" | "delivery";
  targetMemberIds?: string[];
  attachments?: RoomAttachment[];
  /** Bounded automatic-routing metadata used to prevent reply storms. */
  forwardDepth?: number;
  autoRound?: number;
  maxAutoRounds?: number;
}

export interface RoomAttachment {
  name: string;
  path: string;
  mimeType?: string;
}

export interface RoomMention {
  memberId: string;
  start: number;
  end: number;
}

export interface RoomSubmission {
  clientPromptId: string;
  messageId: string;
  roomId: string;
  status: "accepted" | "queued" | "delivered" | "error";
  intent: "auto" | "new_task" | "answer" | "share";
  targetMemberIds: string[];
  commandIds: string[];
  teamRunId?: string;
  memberSelection?: RoomMemberSelection;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RoomMemberAssessment {
  memberId: string;
  fingerprint: string;
  suitable: boolean;
  confidence: number;
  reason: string;
  status: "completed" | "error";
}

export interface RoomMemberSelection {
  assessments: RoomMemberAssessment[];
  selectedMemberId?: string;
  clarificationOnly?: boolean;
}

export interface RoomMessagePayloadMetadata {
  byteLength: number;
  lineCount: number;
  sha256: string;
  truncated: boolean;
  payloadRef?: string;
}

export interface RoomPresence {
  sessionId: string;
  messageId: string;
  status: "processing" | "completed" | "error";
  phase?: "selection";
  detail?: string;
  updatedAt: number;
}

export interface PrivateRoomNote {
  id: string;
  roomId: string;
  sessionId: string;
  content: string;
  createdAt: number;
}

export interface RoomSnapshot {
  room: CollaborationRoom;
  messages: RoomMessage[];
}
