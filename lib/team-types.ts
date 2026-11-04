export const TEAM_AGENT_PROFILE_SCHEMA_VERSION = 1 as const;
export const TEAM_RUN_SCHEMA_VERSION = 1 as const;
export const TEAM_EVENT_SCHEMA_VERSION = 1 as const;

export const TEAM_DEFAULTS = {
  autoStart: true,
  requirePlanApproval: false,
  oneActiveRunPerRoom: true,
  maxConcurrency: 3,
  leaseDurationMs: 5 * 60_000,
  dispatchQueueTimeoutMs: 30 * 60_000,
  maxRunSteps: 128,
  maxTasks: 64,
  maxTaskAttempts: 3,
  maxReviewRounds: 3,
  requireReviewForCodeChanges: true,
  workerWorkspace: "dedicated_worktree",
  integration: "coordinator_integrates",
  recentRoomMessages: 20,
  maxInputBytes: 256 * 1024,
  messageBlobThresholdBytes: 32 * 1024,
  collapseAfterLines: 8,
  collapseAfterChars: 1_200,
  previewLines: 6,
  maxEvents: 10_000,
  maxEventBytes: 64 * 1024,
  maxArtifacts: 200,
} as const;

export type TeamAgentRole = "coordinator" | "planner" | "worker" | "reviewer" | "participant";
export type TeamThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface TeamAgentProfile {
  schemaVersion: typeof TEAM_AGENT_PROFILE_SCHEMA_VERSION;
  revision: number;
  name: string;
  role: TeamAgentRole;
  roleDescription: string;
  systemPrompt: string;
  personality: string[];
  capabilities: string[];
  constraints: string[];
  modelPolicy:
    | { mode: "session" }
    | { mode: "pinned"; provider: string; modelId: string; thinkingLevel: TeamThinkingLevel };
  toolPolicy: { mode: "inherit" } | { mode: "allowlist"; toolNames: string[] };
  skillPolicy: { mode: "inherit" } | { mode: "allowlist"; skillNames: string[] };
  workspacePolicy: {
    mode: "shared" | "dedicated_worktree" | "read_only";
    integration: "artifact_only" | "coordinator_integrates";
  };
  memoryPolicy: {
    recentRoomMessages: number;
    includePrivateNotes: boolean;
    retainAcrossRuns: boolean;
  };
}

export interface TeamAgentBinding {
  sessionId: string;
  /** Historical reply attribution only; never authorizes new commands. */
  previousSessionIds?: string[];
  cwd?: string;
  projectRoot?: string;
  worktreeBranch?: string;
  managedByPiora: boolean;
  boundAt: number;
  status: "ready" | "missing" | "needs_restart" | "provisioning";
}

export interface RoomMemberV3 {
  memberId: string;
  profile: TeamAgentProfile;
  binding: TeamAgentBinding;
  joinedAt: number;
}

export interface CollaborationRoomV3 {
  schemaVersion: 3;
  id: string;
  name: string;
  description?: string;
  projectRoot?: string;
  createdAt: number;
  updatedAt: number;
  nextSeq: number;
  members: RoomMemberV3[];
  coordination: {
    mode: "manual" | "team";
    coordinatorMemberId: string;
    plannerMemberId?: string;
    defaultReviewerMemberIds: string[];
    maxConcurrency: number;
    leaseDurationMs: number;
    maxRunSteps: number;
    maxTaskAttempts: number;
    requireReviewForCodeChanges: boolean;
  };
  workspace: {
    mode: "managed" | "custom";
    path: string;
    label: string;
    instructions?: string;
    defaultAgentWorkspace: "shared" | "dedicated_worktree";
  };
  paths: { root: string; shared: string; privateRoot: string };
}

export type TeamRunPhase =
  | "draft" | "planning" | "running" | "waiting_user" | "reviewing"
  | "integrating" | "synthesizing" | "completed" | "failed" | "interrupted" | "cancelled";

export interface TeamSuccessCriterion {
  id: string;
  description: string;
  required: boolean;
  status: "pending" | "satisfied" | "failed";
  evidenceIds: string[];
}

export interface TeamPlan {
  schemaVersion: 1;
  revision: number;
  objective: string;
  assumptions: string[];
  successCriteria: TeamSuccessCriterion[];
  taskIds: string[];
  submittedByMemberId: string;
  createdAt: number;
  updatedAt: number;
}

export type TeamTaskStatus =
  | "pending" | "ready" | "dispatching" | "queued" | "running" | "submitted"
  | "reviewing" | "changes_requested" | "completed" | "failed" | "blocked"
  | "interrupted" | "cancelled" | "skipped";

export interface TeamTaskReviewPolicy {
  required: boolean;
  reviewerMemberIds: string[];
  minimumApprovals: number;
}

export interface TeamTask {
  schemaVersion: 1;
  id: string;
  teamRunId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  requiredCapabilities: string[];
  dependsOn: string[];
  priority: number;
  status: TeamTaskStatus;
  assignmentMode: "auto" | "fixed";
  preferredMemberId?: string;
  assignedMemberId?: string;
  assignedSessionId?: string;
  attempt: number;
  maxAttempts: number;
  lease?: {
    tokenHash: string;
    dispatchId: string;
    holderMemberId: string;
    holderSessionId: string;
    acquiredAt: number;
    startedAt?: number;
    heartbeatAt: number;
    expiresAt: number;
  };
  reviewPolicy: TeamTaskReviewPolicy;
  submission?: {
    summary: string;
    evidenceIds: string[];
    artifactIds: string[];
    submittedAt: number;
  };
  reviewRound: number;
  createdAt: number;
  updatedAt: number;
}

export interface TeamExecutionContext {
  schemaVersion: 1;
  roomId: string;
  teamRunId: string;
  taskId: string;
  dispatchId: string;
  memberId: string;
  profileRevision: number;
  attempt: number;
  leaseToken: string;
  purpose: "planning" | "task" | "review" | "replan" | "synthesis";
}

export interface PersistedTeamExecutionRef extends Omit<TeamExecutionContext, "leaseToken"> {
  leaseTokenRef: string;
}

export interface TeamDispatchState {
  dispatchId: string;
  purpose: TeamExecutionContext["purpose"];
  taskId: string;
  memberId: string;
  sessionId: string;
  attempt: number;
  retryGeneration?: number;
  leaseTokenHash: string;
  status: "requested" | "accepted" | "queued" | "running" | "completed" | "failed" | "interrupted";
  commandId?: string;
  promptRunId?: string;
  requestedAt: number;
  updatedAt: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface TeamEvidence {
  id: string;
  teamRunId: string;
  taskId: string;
  memberId: string;
  kind: "verification" | "observation" | "review" | "integration";
  summary: string;
  source: "model" | "runtime";
  toolName?: string;
  toolCallId?: string;
  exitCode?: number;
  createdAt: number;
}

export interface TeamArtifactReference {
  id: string;
  roomId: string;
  teamRunId: string;
  taskId: string;
  memberId: string;
  kind: "patch" | "commit" | "report" | "file";
  name: string;
  summary: string;
  sourcePath?: string;
  storedPath?: string;
  commit?: { hash: string; branch: string };
  createdAt: number;
}

export interface TeamReviewDecision {
  id: string;
  teamRunId: string;
  taskId: string;
  reviewerMemberId: string;
  round: number;
  verdict: "approved" | "changes_requested";
  summary: string;
  findings: Array<{
    severity: "critical" | "high" | "medium" | "low";
    title: string;
    detail: string;
    file?: string;
    line?: number;
  }>;
  evidenceIds: string[];
  createdAt: number;
}

export interface TeamRunState {
  schemaVersion: typeof TEAM_RUN_SCHEMA_VERSION;
  id: string;
  roomId: string;
  revision: number;
  objective: string;
  phase: TeamRunPhase;
  createdBy: { kind: "user" | "member"; id: string };
  coordinatorMemberId: string;
  plan?: TeamPlan;
  tasks: Record<string, TeamTask>;
  successCriteria: TeamSuccessCriterion[];
  activeDispatches: Record<string, TeamDispatchState>;
  evidence: Record<string, TeamEvidence>;
  artifacts: Record<string, TeamArtifactReference>;
  reviewDecisions: Record<string, TeamReviewDecision>;
  progressSummary?: string;
  guidance?: Array<{ messageId: string; memberIds?: string[] }>;
  waitingReason?: string;
  stopRequested?: { reason: string; commandIds: string[]; at: number };
  finalSummary?: string;
  finalArtifactIds: string[];
  schedulingSteps: number;
  retryGeneration?: number;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
}

export type TeamRunActor =
  | { kind: "user"; id: string }
  | { kind: "member"; memberId: string; sessionId?: string }
  | { kind: "system"; id: "piora" };

export type TeamRunEvent =
  | { type: "run.created"; objective: string; coordinatorMemberId: string; createdBy?: TeamRunState["createdBy"] }
  | { type: "planning.requested"; dispatch: TeamDispatchState }
  | { type: "plan.submitted"; plan: TeamPlan; tasks: TeamTask[] }
  | { type: "plan.rejected"; reason: string }
  | { type: "run.started" }
  | { type: "run.progressed"; summary: string }
  | { type: "run.guidance_added"; messageId: string; memberIds?: string[] }
  | { type: "run.waiting_user"; reason: string }
  | { type: "run.resumed"; guidance?: string }
  | { type: "run.synthesis_requested"; dispatch: TeamDispatchState }
  | { type: "run.completed"; summary: string; finalArtifactIds: string[]; successCriteriaEvidence?: Record<string, string[]> }
  | { type: "run.failed"; reason: string }
  | { type: "run.interrupted"; reason: string }
  | { type: "run.cancelled"; reason: string }
    | { type: "run.stop_requested"; reason: string }
  | { type: "task.created"; task: TeamTask }
  | { type: "task.ready"; taskId: string }
  | { type: "task.dispatch_requested"; taskId: string; dispatch: TeamDispatchState; leaseTokenHash: string }
  | { type: "task.dispatch_accepted"; taskId: string; dispatchId: string; commandId: string }
  | { type: "task.prompt_started"; taskId: string; dispatchId: string; promptRunId: string }
  | { type: "task.heartbeat"; taskId: string; dispatchId: string; expiresAt: number; progress?: string }
  | { type: "task.evidence_added"; taskId: string; evidence: TeamEvidence }
  | { type: "task.artifact_added"; taskId: string; artifact: TeamArtifactReference }
  | { type: "task.submitted"; taskId: string; submission: TeamTask["submission"] }
  | { type: "task.review_requested"; taskId: string; dispatches: TeamDispatchState[] }
  | { type: "task.review_submitted"; taskId: string; decision: TeamReviewDecision }
  | { type: "task.changes_requested"; taskId: string; reason: string }
  | { type: "task.completed"; taskId: string }
  | { type: "task.blocked"; taskId: string; reason: string }
  | { type: "task.failed"; taskId: string; reason: string; retryable: boolean }
  | { type: "task.interrupted"; taskId: string; reason: string }
  | { type: "task.requeued"; taskId: string; reason: string }
  | { type: "task.cancelled"; taskId: string; reason: string }
  | { type: "dispatch.failed"; dispatchId: string; taskId: string; code?: string; reason: string };

export interface TeamRunEventEnvelope {
  schemaVersion: typeof TEAM_EVENT_SCHEMA_VERSION;
  id: string;
  cursor: number;
  roomId: string;
  teamRunId: string;
  at: number;
  actor: TeamRunActor;
  causationId?: string;
  correlationId?: string;
  event: TeamRunEvent;
}

export interface TeamRunSnapshot {
  schemaVersion: 1;
  revision: number;
  lastEventId: string;
  lastCursor: number;
  state: TeamRunState;
  checksum: string;
}

export interface TeamOutboxRecord {
  schemaVersion: 1;
  id: string;
  roomId: string;
  teamRunId: string;
  kind: "dispatch" | "room_message" | "workspace";
  idempotencyKey: string;
  payload: Record<string, unknown>;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  createdAt: number;
  updatedAt: number;
  deliveredAt?: number;
  errorCode?: string;
}

export interface AppendTeamEventInput {
  event: TeamRunEvent;
  actor?: TeamRunActor;
  at?: number;
  id?: string;
  causationId?: string;
  correlationId?: string;
}
