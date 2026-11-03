import type { UiActionDeclaration, UiActionSource } from "./action-contract";
import type { UiActionOperation, UiActionStart } from "./action-operation";
import type { UiActionFileEvidence } from "./action-files";
import type { UiState } from "./surface-document";

/** The permission/execution lifecycle depends on confirmed data, not a renderer. */
export type AnswerActionSource = Omit<UiActionSource, "surface" | "actions"> & { actions: UiActionDeclaration };
export interface AnswerActionHost<S extends AnswerActionSource> {
  readActionSource(toolCallId: string): Promise<S>;
  readActions(toolCallId: string): Promise<UiActionOperation[]>;
  prepareAction(input: UiActionStart, runId: string, prepare: (source: S) => Pick<UiActionOperation, "file" | "snapshotHash">,
    assertAllowed: () => void): Promise<{ created: boolean; operation: UiActionOperation }>;
  withActionOperation<T>(id: string, work: (operation: UiActionOperation, context: {
    currentSource(): S; save(): void; assertOwned(): void;
  }) => T): Promise<T>;
  applyActionParameters(id: string, assertAllowed: () => void): Promise<{ revision: number; alreadyApplied: boolean }>;
}
export interface AnswerActionData<S extends AnswerActionSource> {
  snapshot(action: Extract<UiActionOperation["action"], { kind: "save_snapshot" }>, source: S): Buffer;
  parameters(cwd: string, action: Extract<UiActionOperation["action"], { kind: "read_json_parameters" }>, source: S, evidence: UiActionFileEvidence): UiState;
}
