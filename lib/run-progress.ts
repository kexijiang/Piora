/** Events that show an active run has produced output or moved to a new step. */
const PROGRESS_EVENT_TYPES = new Set([
  "message_start", "message_update", "message_end",
  "tool_execution_start", "tool_execution_update", "tool_execution_end",
  "bash_output",
  "compaction_start", "compaction_end", "auto_compaction_start", "auto_compaction_end",
]);

export function isRunProgressEvent(type: string): boolean {
  return PROGRESS_EVENT_TYPES.has(type);
}

export interface RunStatusClock {
  runStartedAt: number | null;
  phaseKind: "waiting_model" | "running_command" | "running_tools" | "stopping" | "agent" | "bash" | null;
  phaseStartedAt: number | null;
  lastProgressAt: number | null;
}
