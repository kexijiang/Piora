import type { AssistantContentBlock, ToolResultMessage } from "./types";

/** Host-owned envelope. Payload validation and interaction belong to its renderer. */
export interface AnswerOutput {
  kind: string;
  version: number;
  snapshot: string;
  payload: unknown;
}

const ANSWER_TOOL_NAMES = new Set(["piora_render_ui", "piora_render_ui_plan"]);
const MAX_SNAPSHOT_LENGTH = 128_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Names are known before a result arrives, keeping streamed answers out of process folds. */
export function isAnswerOutputBlock(block: AssistantContentBlock): boolean {
  return block.type === "toolCall" && ANSWER_TOOL_NAMES.has(block.toolName);
}

export function readAnswerOutput(details: unknown): AnswerOutput | null {
  if (!isRecord(details) || !isRecord(details.answerOutput)) return null;
  const output = details.answerOutput;
  if (typeof output.kind !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(output.kind)
    || !Number.isSafeInteger(output.version) || (output.version as number) < 1
    || typeof output.snapshot !== "string" || output.snapshot.length > MAX_SNAPSHOT_LENGTH) return null;
  return { kind: output.kind, version: output.version as number, snapshot: output.snapshot, payload: output.payload };
}

/** Text remains readable without installing, enabling or successfully loading a renderer. */
export function answerOutputSnapshot(result?: ToolResultMessage): string {
  const output = readAnswerOutput(result?.details);
  if (output && !result?.isError) return output.snapshot;
  return (Array.isArray(result?.content) ? result.content : [])
    .filter(block => block?.type === "text" && typeof block.text === "string")
    .map(block => (block as { text: string }).text).join("\n").slice(0, MAX_SNAPSHOT_LENGTH);
}
