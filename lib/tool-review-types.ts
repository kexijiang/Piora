/** Browser-safe DTOs. No raw prompts, tool arguments, or provider errors in audit records. */
export const TOOL_REVIEW_POLICY_VERSION = 1;
export const TOOL_REVIEW_LIMITS = { timeoutMs: 30_000, maxInputChars: 24_000, maxOutputTokens: 700, maxEvidenceFiles: 8, maxFileBytes: 32_768, maxRetries: 0 } as const;
export type ToolReviewStatus = "reviewing" | "needs_user" | "approved" | "executing" | "completed" | "denied" | "cancelled" | "invalidated" | "failed" | "interrupted";
export interface ToolReviewDecision {
  decision: "allow" | "deny" | "ask_user";
  authorization: "explicit" | "implied" | "unclear";
  risk: "low" | "medium" | "high" | "critical";
  reason: string;
  question: string;
}
export interface ToolReviewRecord {
  schemaVersion: 1;
  policyVersion: number;
  id: string;
  sessionId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  permissionRevision: number;
  fingerprint: string;
  status: ToolReviewStatus;
  reason: string;
  model?: string;
  decision?: ToolReviewDecision["decision"];
  risk?: ToolReviewDecision["risk"];
  startedAt: number;
  updatedAt: number;
  durationMs?: number;
  tokens?: number;
  cost?: number;
}
export interface ToolReviewAuthorization {
  id: string;
  source: string;
  text: string;
  timestamp: number;
}
export interface ToolReviewModelInput { context: string; model: { provider: string; id: string }; signal: AbortSignal }
export type ToolReviewModel = (input: ToolReviewModelInput) => Promise<{ decision: ToolReviewDecision; tokens?: number; cost?: number }>;
