import type { RoomArtifact, RoomTask } from "./room-types";

export const TASK_RUN_SCHEMA_VERSION = 1;
export const TASK_PLAN_SCHEMA_VERSION = 1;

export type TaskRunSource = "session" | "room";

export type TaskRunPhase =
  | "draft"
  | "planned"
  | "waiting_approval"
  | "running"
  | "waiting_user"
  | "blocked"
  | "verifying"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled";

export type TaskRunRuntime = "idle" | "running" | "compacting" | "stopping";

export interface TaskPlanStep {
  id: string;
  title: string;
  description?: string;
  dependsOn: string[];
  status: "pending" | "running" | "completed" | "blocked" | "skipped";
  result?: string;
  reason?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface TaskPlanArtifact {
  schemaVersion: typeof TASK_PLAN_SCHEMA_VERSION;
  id: string;
  objective: string;
  assumptions: string[];
  successCriteria: string[];
  steps: TaskPlanStep[];
  createdAt: number;
  updatedAt: number;
}

export interface TaskRunEvidence {
  id: string;
  kind: "verification" | "artifact" | "observation";
  summary: string;
  createdAt: number;
  source?: "model" | "runtime";
  toolName?: string;
  toolCallId?: string;
}

export interface TaskRunArtifactReference {
  id: string;
  kind: "patch" | "commit" | "report" | "file";
  name: string;
  summary?: string;
  createdAt: number;
  source?: "model" | "runtime";
  toolName?: string;
  toolCallId?: string;
}

export interface TaskRunState {
  schemaVersion: typeof TASK_RUN_SCHEMA_VERSION;
  taskId: string;
  source: TaskRunSource;
  sessionId?: string;
  operationId?: string;
  parentTaskId?: string;
  objective: string;
  phase: TaskRunPhase;
  attempt: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  progress?: string;
  reason?: string;
  plan?: TaskPlanArtifact;
  evidence: TaskRunEvidence[];
  artifacts: TaskRunArtifactReference[];
}

interface TaskRunEventBase {
  schemaVersion: typeof TASK_RUN_SCHEMA_VERSION;
  eventId: string;
  taskId: string;
  at: number;
}

export type TaskRunEvent =
  | (TaskRunEventBase & {
      type: "created";
      source: TaskRunSource;
      objective: string;
      sessionId?: string;
      parentTaskId?: string;
    })
  | (TaskRunEventBase & { type: "planned"; plan: TaskPlanArtifact })
  | (TaskRunEventBase & { type: "approval_requested"; reason: string })
  | (TaskRunEventBase & { type: "started"; sessionId?: string; operationId?: string })
  | (TaskRunEventBase & { type: "progressed"; progress: string })
  | (TaskRunEventBase & { type: "evidence_added"; evidence: TaskRunEvidence })
  | (TaskRunEventBase & { type: "artifact_added"; artifact: TaskRunArtifactReference })
  | (TaskRunEventBase & { type: "verification_started" })
  | (TaskRunEventBase & { type: "input_requested"; reason: string })
  | (TaskRunEventBase & { type: "blocked"; reason: string })
  | (TaskRunEventBase & { type: "completed"; summary: string })
  | (TaskRunEventBase & { type: "failed"; reason: string })
  | (TaskRunEventBase & { type: "interrupted"; reason: string })
  | (TaskRunEventBase & { type: "cancelled"; reason: string });

const STARTABLE_PHASES = new Set<TaskRunPhase>([
  "draft",
  "planned",
  "waiting_approval",
  "waiting_user",
  "blocked",
  "failed",
  "interrupted",
]);

const ACTIVE_PHASES = new Set<TaskRunPhase>(["running", "verifying"]);

function cleanText(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength);
}

function copyPlan(plan: TaskPlanArtifact): TaskPlanArtifact {
  return {
    ...plan,
    assumptions: [...plan.assumptions],
    successCriteria: [...plan.successCriteria],
    steps: plan.steps.map((step) => ({ ...step, dependsOn: [...step.dependsOn] })),
  };
}

function copyState(state: TaskRunState): TaskRunState {
  return {
    ...state,
    ...(state.plan ? { plan: copyPlan(state.plan) } : {}),
    evidence: state.evidence.map((item) => ({ ...item })),
    artifacts: state.artifacts.map((item) => ({ ...item })),
  };
}

function requireText(value: string, label: string, maxLength = 4_000): string {
  const cleaned = cleanText(value, maxLength);
  if (!cleaned) throw new Error(`${label} requires non-empty text.`);
  return cleaned;
}

function requireTask(state: TaskRunState | undefined, event: TaskRunEvent): TaskRunState {
  if (!state) throw new Error(`TaskRun ${event.taskId} must begin with a created event.`);
  if (state.taskId !== event.taskId) throw new Error(`TaskRun event ${event.eventId} targets a different task.`);
  return copyState(state);
}

function transition(state: TaskRunState, event: TaskRunEvent, phase: TaskRunPhase): TaskRunState {
  state.phase = phase;
  state.updatedAt = event.at;
  if (["completed", "failed", "cancelled"].includes(phase)) state.finishedAt = event.at;
  else state.finishedAt = undefined;
  return state;
}

export function reduceTaskRunEvent(
  current: TaskRunState | undefined,
  event: TaskRunEvent,
): TaskRunState {
  if (event.type === "created") {
    if (current) throw new Error(`TaskRun ${event.taskId} already exists.`);
    return {
      schemaVersion: TASK_RUN_SCHEMA_VERSION,
      taskId: event.taskId,
      source: event.source,
      ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      ...(event.parentTaskId ? { parentTaskId: event.parentTaskId } : {}),
      objective: requireText(event.objective, "TaskRun objective", 8_000),
      phase: "draft",
      attempt: 0,
      createdAt: event.at,
      updatedAt: event.at,
      evidence: [],
      artifacts: [],
    };
  }

  const state = requireTask(current, event);
  switch (event.type) {
    case "planned":
      if (state.phase !== "draft" && state.phase !== "planned") {
        throw new Error(`Cannot attach a plan while TaskRun is ${state.phase}.`);
      }
      state.plan = copyPlan(event.plan);
      state.objective = requireText(event.plan.objective, "Task plan objective", 8_000);
      return transition(state, event, "planned");
    case "approval_requested":
      if (state.phase !== "planned" && !ACTIVE_PHASES.has(state.phase)) {
        throw new Error(`Cannot request approval while TaskRun is ${state.phase}.`);
      }
      state.reason = requireText(event.reason, "Approval request");
      return transition(state, event, "waiting_approval");
    case "started":
      if (!STARTABLE_PHASES.has(state.phase)) throw new Error(`Cannot start TaskRun while it is ${state.phase}.`);
      state.attempt += 1;
      state.startedAt ??= event.at;
      state.reason = undefined;
      if (event.sessionId) state.sessionId = event.sessionId;
      state.operationId = event.operationId;
      return transition(state, event, "running");
    case "progressed":
      if (!ACTIVE_PHASES.has(state.phase)) throw new Error(`Cannot record progress while TaskRun is ${state.phase}.`);
      state.progress = requireText(event.progress, "TaskRun progress");
      state.updatedAt = event.at;
      return state;
    case "evidence_added":
      if (!ACTIVE_PHASES.has(state.phase)) throw new Error(`Cannot record evidence while TaskRun is ${state.phase}.`);
      state.evidence.push({
        ...event.evidence,
        summary: requireText(event.evidence.summary, "TaskRun evidence"),
      });
      state.updatedAt = event.at;
      return state;
    case "artifact_added":
      if (!ACTIVE_PHASES.has(state.phase)) throw new Error(`Cannot attach an artifact while TaskRun is ${state.phase}.`);
      state.artifacts.push({
        ...event.artifact,
        name: requireText(event.artifact.name, "TaskRun artifact name", 240),
        ...(event.artifact.summary
          ? { summary: cleanText(event.artifact.summary, 4_000) }
          : {}),
      });
      state.updatedAt = event.at;
      return state;
    case "verification_started":
      if (state.phase !== "running") throw new Error(`Cannot verify TaskRun while it is ${state.phase}.`);
      return transition(state, event, "verifying");
    case "input_requested":
      if (!ACTIVE_PHASES.has(state.phase)) throw new Error(`Cannot request input while TaskRun is ${state.phase}.`);
      state.reason = requireText(event.reason, "Input request");
      return transition(state, event, "waiting_user");
    case "blocked":
      if (!ACTIVE_PHASES.has(state.phase) && state.phase !== "waiting_approval" && state.phase !== "waiting_user") {
        throw new Error(`Cannot block TaskRun while it is ${state.phase}.`);
      }
      state.reason = requireText(event.reason, "Blocked TaskRun");
      return transition(state, event, "blocked");
    case "completed":
      if (!ACTIVE_PHASES.has(state.phase)) throw new Error(`Cannot complete TaskRun while it is ${state.phase}.`);
      state.progress = requireText(event.summary, "TaskRun completion");
      state.reason = undefined;
      return transition(state, event, "completed");
    case "failed":
      if (!ACTIVE_PHASES.has(state.phase)) throw new Error(`Cannot fail TaskRun while it is ${state.phase}.`);
      state.reason = requireText(event.reason, "TaskRun failure");
      return transition(state, event, "failed");
    case "interrupted":
      if (!ACTIVE_PHASES.has(state.phase) && state.phase !== "waiting_approval") {
        throw new Error(`Cannot interrupt TaskRun while it is ${state.phase}.`);
      }
      state.reason = requireText(event.reason, "TaskRun interruption");
      return transition(state, event, "interrupted");
    case "cancelled":
      if (state.phase === "completed" || state.phase === "cancelled") {
        throw new Error(`Cannot cancel TaskRun while it is ${state.phase}.`);
      }
      state.reason = requireText(event.reason, "TaskRun cancellation");
      return transition(state, event, "cancelled");
  }
}

export function replayTaskRun(events: readonly TaskRunEvent[]): TaskRunState | undefined {
  let state: TaskRunState | undefined;
  for (const event of events) state = reduceTaskRunEvent(state, event);
  return state;
}

export interface TaskRunProjectionInput {
  sessionId: string;
  runtime: TaskRunRuntime;
  pendingApproval: boolean;
  lastPromptFailed: boolean;
  errorSummary?: string;
  startedAt?: number;
  title?: string;
  activity?: { message: string; updatedAt: number };
  now?: number;
}

export function projectTaskRun(input: TaskRunProjectionInput): TaskRunState | undefined {
  const now = input.now ?? Date.now();
  const hasRuntimeState = input.runtime !== "idle" || input.pendingApproval || input.lastPromptFailed;
  if (!hasRuntimeState) return undefined;
  const phase: TaskRunPhase = input.pendingApproval
    ? "waiting_approval"
    : input.lastPromptFailed
      ? "failed"
      : "running";
  const createdAt = input.startedAt ?? input.activity?.updatedAt ?? now;
  return {
    schemaVersion: TASK_RUN_SCHEMA_VERSION,
    taskId: input.sessionId,
    source: "session",
    sessionId: input.sessionId,
    objective: cleanText(input.title || input.activity?.message || "Active Pi task", 8_000),
    phase,
    attempt: 1,
    createdAt,
    updatedAt: input.activity?.updatedAt ?? now,
    startedAt: input.startedAt ?? createdAt,
    ...(phase === "failed" ? { finishedAt: now } : {}),
    ...(input.activity?.message ? { progress: input.activity.message } : {}),
    ...(input.errorSummary ? { reason: input.errorSummary } : {}),
    evidence: [],
    artifacts: [],
  };
}

function phaseFromRoomTask(task: RoomTask): TaskRunPhase {
  switch (task.status) {
    case "pending": return "planned";
    case "leased":
    case "running": return "running";
    case "completed": return "completed";
    case "failed": return "failed";
    case "blocked": return "blocked";
    case "cancelled": return "cancelled";
  }
}

export function projectRoomTaskRun(
  task: RoomTask,
  artifacts: readonly RoomArtifact[] = [],
): TaskRunState {
  const phase = phaseFromRoomTask(task);
  const terminal = phase === "completed" || phase === "failed" || phase === "cancelled";
  const reason = task.error || ((phase === "blocked" || phase === "failed") ? task.result : undefined);
  return {
    schemaVersion: TASK_RUN_SCHEMA_VERSION,
    taskId: task.id,
    source: "room",
    ...(task.assignedTo ? { sessionId: task.assignedTo } : {}),
    ...(task.lease ? { operationId: `${task.id}:attempt:${task.attempt}` } : {}),
    objective: task.title,
    phase,
    attempt: task.attempt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.lease ? { startedAt: task.lease.acquiredAt } : {}),
    ...(terminal ? { finishedAt: task.updatedAt } : {}),
    ...(task.result && phase !== "blocked" && phase !== "failed" ? { progress: task.result } : {}),
    ...(reason ? { reason } : {}),
    evidence: [],
    artifacts: artifacts
      .filter((artifact) => artifact.taskId === task.id)
      .map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        name: artifact.name,
        summary: artifact.summary,
        createdAt: artifact.createdAt,
      })),
  };
}
