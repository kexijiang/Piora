import type { AgentMessage, AssistantMessage, AssistantContentBlock, ToolResultMessage } from "./types";
import type { ChatHistoryRow } from "./chat-history";
import { isChatTurnAnchor } from "./chat-history";
import { getDisplayableAssistantBlocks, hasAssistantNotice, splitFinalAssistantBlocks } from "./message-display";
import { isCommandToolName, toolResultText } from "./command-execution";

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
}

/** A short, plain-text tail. The full log stays available in the command viewer. */
export function commandPreviewTail(output: string): string {
  return output.slice(-6000)
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .replace(/\r(?!\n)/g, "\n").trimEnd().split("\n").slice(-3)
    .map((line) => line.length > 240 ? `${line.slice(0, 240)}…` : line).join("\n");
}

function needsAttention(block: AssistantContentBlock, results: Map<string, ToolResultMessage>): boolean {
  if (block.type !== "toolCall") return false;
  const result = results.get(block.toolCallId);
  if (result?.isError) return true;
  // User handoff remains actionable even while the surrounding process is folded.
  return block.toolName === "browser" && block.input?.action === "wait_for_user"
    && (!result || result.isStreaming === true || (result.details as { status?: string } | undefined)?.status === "unsupported");
}

/** Compact mode changes the render plan only; transcript entries are never changed. */
export function buildCompactChatHistoryRows(
  messages: AgentMessage[], entryIds: string[], busy: boolean, expanded: ReadonlySet<string>, streamingIndex = -1,
) {
  const rows: ChatHistoryRow[] = [];
  const entryRows = new Map<string, string>();
  const results = new Map<string, ToolResultMessage>();
  for (const message of messages) if (message.role === "toolResult") results.set(message.toolCallId, message);
  const add = (index: number, message = messages[index], secondary = false) => {
    if (message.role === "toolResult") return;
    const key = `${secondary ? "compact-step" : "message"}:${entryIds[index] || (message.role === "user" ? message.clientPromptId : undefined) || index}`;
    rows.push({ key, index, message, secondary, isStreaming: index === streamingIndex, showTimestamp: secondary ? false : undefined });
    if (entryIds[index]) entryRows.set(entryIds[index], key);
  };

  for (let start = 0; start < messages.length;) {
    let end = start + 1;
    while (end < messages.length && !isChatTurnAnchor(messages[end])) end++;
    const anchored = isChatTurnAnchor(messages[start]);
    if (anchored) add(start);
    const first = start + Number(anchored);
    const active = busy && end === messages.length;
    let final = -1;
    for (let i = end - 1; i >= first; i--) if (messages[i].role === "assistant") { final = i; break; }
    const process: Array<{ index: number; message: AssistantMessage; attention: boolean }> = [];
    const visible: Array<{ index: number; message: AgentMessage }> = [];
    const steps: ProcessStep[] = [];
    let count = 0;
    for (let i = first; i < end; i++) {
      const message = messages[i];
      if (message.role === "toolResult") continue;
      if (message.role !== "assistant" || hasAssistantNotice(message) && i !== streamingIndex) {
        visible.push({ index: i, message });
        continue;
      }
      const options = { isStreaming: i === streamingIndex };
      const split = i === final ? splitFinalAssistantBlocks(message, options)
        : { processBlocks: getDisplayableAssistantBlocks(message, options), answerBlocks: [] };
      if (split.processBlocks.length) {
        const attention = split.processBlocks.some((block) => needsAttention(block, results));
        // Preserve original block indices for deferred thinking and virtual row state.
        process.push({ index: i, message: { ...message, content: split.processBlocks, usage: undefined }, attention });
        for (let b = 0; b < split.processBlocks.length; b++) {
          const block = split.processBlocks[b];
          if (block.type !== "toolCall" && block.type !== "thinking" && block.type !== "text") continue;
          count++;
          if (needsAttention(block, results)) continue;
          const result = block.type === "toolCall" ? results.get(block.toolCallId) : undefined;
          const status = block.type === "toolCall"
            ? result?.isError ? "error" : result && !result.isStreaming ? "done" : active ? "running" : "unknown"
            : i === streamingIndex ? "running" : "done";
          steps.push({ key: `${i}:${b}`, block, status,
            output: block.type === "toolCall" && isCommandToolName(block.toolName) && result?.isStreaming ? commandPreviewTail(toolResultText(result)) : undefined });
        }
      }
      if (split.answerBlocks.length) visible.push({ index: i, message: { ...message, content: split.answerBlocks } });
    }
    if (process.length) {
      const anchor = messages[start];
      const key = `compact-process:${entryIds[start] || (anchor.role === "user" ? anchor.clientPromptId : undefined) || start}`;
      const open = expanded.has(key);
      const timestamps = messages.slice(start, end).map((message) => message.timestamp).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
      rows.push({ key, index: start, compactProcess: { active, expanded: open, count,
        attention: process.some((item) => item.attention),
        startedAt: timestamps[0], endedAt: active ? undefined : timestamps.at(-1), preview: steps.slice(-3) } });
      for (const item of process) {
        if (open || item.attention) add(item.index, item.message, true);
        else if (entryIds[item.index]) entryRows.set(entryIds[item.index], key);
      }
    }
    for (const item of visible) add(item.index, item.message);
    start = end;
  }
  return { rows, entryRows };
}
