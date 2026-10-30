import type { AgentMessage, AssistantMessage, AssistantContentBlock, ToolResultMessage } from "./types";
import type { ChatHistoryRow } from "./chat-history";
import { isEmptyThinkingBlock, hasAssistantNotice } from "./message-display";
import { isCommandToolName, toolResultText } from "./command-execution";
import { toolActivityKind, type ToolActivityKind } from "./tool-activity";
import { isAnswerOutputBlock } from "./answer-output";

export interface ProcessStep {
  key: string;
  block: AssistantContentBlock;
  status: "running" | "done" | "unknown" | "error";
  output?: string;
}

export interface CompactProcessGroup {
  active: boolean;
  expanded: boolean;
  count: number;
  startedAt?: number;
  endedAt?: number;
  attention: boolean;
  preview: ProcessStep[];
  activities: Partial<Record<"read" | "search" | "command" | "edit" | "thinking" | "other", number>>;
}

/** A short, plain-text tail. The full log stays available in the command viewer. */
export function commandPreviewTail(output: string): string {
  return output.slice(-6000)
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .replace(/\r(?!\n)/g, "\n").trimEnd().split("\n").slice(-3)
    .map((line) => line.length > 240 ? `${line.slice(0, 240)}…` : line).join("\n");
}

function needsAttention(block: AssistantContentBlock, results: Map<string, ToolResultMessage>, active: boolean): boolean {
  if (block.type !== "toolCall") return false;
  const result = results.get(block.toolCallId);
  if (result?.isError) return true;
  if (!active && (!result || result.isStreaming)) return true;
  // User handoff remains actionable even while the surrounding process is folded.
  return block.toolName === "browser" && block.input?.action === "wait_for_user"
    && (!result || result.isStreaming === true || (result.details as { status?: string } | undefined)?.status === "unsupported");
}

/** Both display modes share turn boundaries. Only running defaults differ. */
export function buildCompactChatHistoryRows(
  messages: AgentMessage[], entryIds: string[], busy: boolean,
  choices: ReadonlyMap<string, boolean>, streamingIndex = -1, compact = false, direct = false,
) {
  const rows: ChatHistoryRow[] = [];
  const entryRows = new Map<string, string>();
  const entryGroups = new Map<string, string>();
  const results = new Map<string, ToolResultMessage>();
  for (const message of messages) if (message.role === "toolResult") results.set(message.toolCallId, message);
  for (let start = 0; start < messages.length;) {
    let end = start + 1;
    // Compaction and custom status cards can occur within one user turn.
    while (end < messages.length && messages[end].role !== "user") end++;
    const active = busy && end === messages.length;
    const anchor = messages[start];
    const key = `compact-process:${entryIds[start] || (anchor.role === "user" ? anchor.clientPromptId : undefined) || start}`;
    const turnRows: ChatHistoryRow[] = [];
    const steps: ProcessStep[] = [];
    const activities: CompactProcessGroup["activities"] = {};
    let attention = false;
    for (let i = start; i < end; i++) {
      const message = messages[i];
      if (message.role === "toolResult") continue;
      const rowKey = `message:${entryIds[i] || (message.role === "user" ? message.clientPromptId : undefined) || i}`;
      if (message.role !== "assistant") {
        turnRows.push({ key: rowKey, index: i, message });
        continue;
      }
      attention ||= i !== streamingIndex && hasAssistantNotice(message);
      const content = Array.isArray(message.content) ? message.content : [];
      const segments: Array<{ offset: number; process: boolean; activity?: ToolActivityKind; blocks: AssistantContentBlock[] }> = [];
      for (const [b, original] of content.entries()) {
        if (Boolean(isEmptyThinkingBlock(original, { isStreaming: i === streamingIndex }))) continue;
        // Splitting rows must not change deferred lookup or disclosure identities.
        const block = original.type === "thinking" ? { ...original, deferredBlockIndex: original.deferredBlockIndex ?? b } : original;
        const process = block.type === "thinking" || block.type === "toolCall" && !isAnswerOutputBlock(block);
        const activity = block.type === "toolCall" ? toolActivityKind(block.toolName) : undefined;
        const previous = segments.at(-1);
        // Interactive outputs own a stable tool-call row before entry IDs hydrate.
        // Keep each output separate so adjacent outputs cannot change its identity.
        if (!isAnswerOutputBlock(block) && previous && !isAnswerOutputBlock(previous.blocks[0]) && previous.process === process && previous.activity === activity) previous.blocks.push(block);
        else segments.push({ offset: b, process, activity, blocks: [block] });
        if (process) {
          attention ||= needsAttention(block, results, active);
          const result = block.type === "toolCall" ? results.get(block.toolCallId) : undefined;
          const status = block.type === "toolCall" ? result?.isError ? "error" : result && !result.isStreaming ? "done" : active ? "running" : "unknown"
            : i === streamingIndex && b === content.length - 1 ? "running" : "done";
          steps.push({ key: `${rowKey}:${b}`, block, status,
            output: block.type === "toolCall" && isCommandToolName(block.toolName) && result?.isStreaming ? commandPreviewTail(toolResultText(result)) : undefined });
          const kind = block.type === "thinking" ? "thinking" : block.type !== "toolCall" ? "other"
            : isCommandToolName(block.toolName) ? "command" : block.toolName === "read" ? "read"
              : ["grep", "find", "ls"].includes(block.toolName) ? "search" : ["edit", "write"].includes(block.toolName) ? "edit" : "other";
          activities[kind] = (activities[kind] ?? 0) + 1;
        }
      }
      if (!segments.length && hasAssistantNotice(message)) turnRows.push({ key: rowKey, index: i, message });
      for (const [s, segment] of segments.entries()) {
        const last = s === segments.length - 1;
        const first = segment.blocks[0];
        const segmentKey = first.type === "toolCall" && isAnswerOutputBlock(first) ? `answer-output:${first.toolCallId}` : `${rowKey}:${segment.offset}`;
        turnRows.push({ key: segmentKey, index: i, secondary: segment.process,
          processGroupKey: segment.process ? key : undefined, attachRef: last,
          intermediate: !last || segment.process, isStreaming: i === streamingIndex && last,
          message: { ...message, content: segment.blocks, ...(!last ? { usage: undefined, stopReason: undefined, errorMessage: undefined } : {}) } as AssistantMessage });
        if (segment.process && entryIds[i] && !direct) entryGroups.set(entryIds[i], key);
      }
    }
    // Latest completed turn stays open until another input; exceptional turns
    // never hide their evidence, even after a previous manual collapse.
    const open = direct || attention || (choices.get(key) ?? (end === messages.length && (!active || !compact)));
    // Secondary rows stay individually virtualized under the process heading.
    // Thinking, prose and custom notices still split the assistant message.
    let headingAdded = false;
    const timestamps = messages.slice(start, end).map(message => message.timestamp).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    for (const row of turnRows) {
      if (row.secondary && !headingAdded && !direct) {
        rows.push({ key, index: row.index - 0.1, compactProcess: { active, expanded: open, count: steps.length, attention, activities,
          startedAt: timestamps[0], endedAt: active ? undefined : timestamps.at(-1), preview: steps.slice(-3) } });
        headingAdded = true;
      }
      const id = entryIds[row.index];
      if (id && (!entryRows.has(id) || entryRows.get(id) === key)) {
        entryRows.set(id, row.secondary && !open ? key : row.key);
      }
      if (!row.secondary || open) rows.push(row);
    }
    start = end;
  }
  return { rows, entryRows, entryGroups };
}
