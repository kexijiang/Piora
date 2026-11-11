/** Serializable workflow contracts shared by the runtime and chat UI. */
export type WorkflowMode = "agent" | "plan" | "goal";
export interface WorkflowPromptOptions { mode: WorkflowMode; turnBudget?: number }
export type WorkflowStatus = "planning" | "awaiting_approval" | "running" | "completed" | "waiting" | "paused" | "cancelled" | "failed" | "budget_exhausted";
export interface WorkflowCriterion { id: string; text: string; evidence: string; status: "pending" | "verified" }
export interface WorkflowRun {
  id: string;
  kind: "plan" | "goal";
  status: WorkflowStatus;
  objective: string;
  title: string;
  markdown: string;
  criteria: WorkflowCriterion[];
  progress: string;
  reason: string;
  turnBudget: number;
  turnsUsed: number;
  version: number;
  createdAt: number;
  updatedAt: number;
  /** Number of consecutive turns without new recorded progress or tool evidence. */
  noProgressTurns: number;
}
export interface WorkflowSnapshot {
  sessionId: string;
  revision: number;
  mode: WorkflowMode;
  turnBudget: number;
  current: WorkflowRun | null;
  history: WorkflowRun[];
}
export type WorkflowActionName = "approve" | "revise" | "exit" | "pause" | "resume" | "cancel" | "set_budget";
export interface WorkflowAction { action: WorkflowActionName; runId: string; expectedRevision: number; turnBudget?: number }
export interface WorkflowActionResult { snapshot: WorkflowSnapshot; prompt?: string }
export const DEFAULT_WORKFLOW_TURN_BUDGET = 10;
export const MAX_WORKFLOW_TURN_BUDGET = 100;
