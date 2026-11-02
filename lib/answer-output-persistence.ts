import type { ReadonlySessionManager } from "./session-readonly-manager";

export interface AnswerOutputCopyOptions {
  sourceFile?: string;
  targetFile?: string;
  sourceLeafId?: string | null;
}

/** Durable output operations; no UI or model-specific contracts cross this boundary. */
export interface AnswerOutputPersistenceAdapter {
  copy(source: string, target: string, retainedEntryIds: readonly string[], options: AnswerOutputCopyOptions): Promise<void>;
  snapshots(sessionId: string, sessionFile: string, snapshot?: ReadonlySessionManager): Promise<string[]>;
  readSnapshot(sessionId: string, sessionFile: string, toolCallId: string): Promise<string>;
}
