import type { UiAction, UiActionSource } from "./action-contract";
import type { UiActionFileEvidence } from "./action-files";
import type { UiState } from "./surface-document";
import type { UiActionProblem } from "./action-feedback";

export type UiActionStatus = "prepared" | "waiting_approval" | "executing" | "completed" | "cancelled" | "failed" | "uncertain";
export interface UiActionOperation {
  id: string; runId: string; createdAt: number;
  source: Pick<UiActionSource, "toolCallId" | "operationId" | "leafId" | "publicationEntryId" | "revision" | "digest">;
  action: UiAction; file: UiActionFileEvidence; snapshotHash?: string;
  status: UiActionStatus;
  result?: { kind: "parameters"; state: UiState } | { kind: "snapshot"; path: string; sha256: string; bytes: number };
  error?: string;
  problem?: UiActionProblem;
  reconciliation?: "matching" | "missing" | "different";
  appliedRevision?: number;
}
export type UiActionStart = { requestId: string; toolCallId: string; sourceDigest: string; actionId: string };
export const actionTerminal = (status: UiActionStatus) => ["completed", "cancelled", "failed", "uncertain"].includes(status);
