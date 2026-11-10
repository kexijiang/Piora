import type { WorkflowAction, WorkflowMode, WorkflowPromptOptions } from "./workflow-types";

export class WorkflowInputError extends Error {
  readonly code = "INVALID_WORKFLOW_INPUT";
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkflowInputError("Invalid workflow request.");
  return value as Record<string, unknown>;
}

export function parseWorkflowMode(value: unknown): WorkflowMode {
  if (value !== "agent" && value !== "plan" && value !== "goal") throw new WorkflowInputError("Choose Agent, Plan, or Goal.");
  return value;
}

export function parseWorkflowBudget(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 100) throw new WorkflowInputError("The workflow turn budget must be an integer from 1 to 100.");
  return value;
}

export function parseWorkflowPromptOptions(value: unknown): WorkflowPromptOptions | undefined {
  if (value === undefined) return undefined;
  const input = record(value);
  return {
    mode: parseWorkflowMode(input.mode),
    ...(input.turnBudget !== undefined ? { turnBudget: parseWorkflowBudget(input.turnBudget) } : {}),
  };
}

export function parseWorkflowRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new WorkflowInputError("A workflow revision is required. Refresh the current workflow.");
  return value;
}

export function parseWorkflowAction(value: unknown): WorkflowAction {
  const input = record(value);
  if (!["approve", "revise", "exit", "pause", "resume", "cancel", "set_budget"].includes(String(input.action))) throw new WorkflowInputError("Unknown workflow action.");
  if (typeof input.runId !== "string" || !input.runId || input.runId.length > 128) throw new WorkflowInputError("A workflow run ID is required.");
  return {
    action: input.action as WorkflowAction["action"],
    runId: input.runId,
    expectedRevision: parseWorkflowRevision(input.expectedRevision),
    ...(input.turnBudget !== undefined ? { turnBudget: parseWorkflowBudget(input.turnBudget) } : {}),
  };
}
