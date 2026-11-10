import type { PromptRunIdentity } from "./prompt-run-registry";
import type { ReviewEvidence } from "./tool-review-evidence";

/** Host-owned activity shared by interactive answer outputs. Never an RPC payload. */
export interface AnswerActionRun {
  identity: PromptRunIdentity;
  signal: AbortSignal;
  assertActive(): void;
  authorize(input: {
    name: "read" | "write"; args: Record<string, unknown>;
    evidence(signal: AbortSignal): Promise<ReviewEvidence>;
    ask(message: string, signal: AbortSignal): Promise<"once" | "deny">;
  }): Promise<() => void>;
}
