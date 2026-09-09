import type { AgentMessage, AssistantMessage, AssistantContentBlock } from "./types";
import { countToolCallBlocks, getAssistantErrorMessage, getDisplayableAssistantBlocks, hasFileMutationBlocks, splitFinalAssistantBlocks } from "./message-display";

export function isChatTurnAnchor(message: AgentMessage): boolean {
  return message.role === "user" || message.role === "custom" && message.customType === "compaction";
}

export interface ChatHistoryRow {
  key: string;
  index: number;
  message?: AgentMessage;
  process?: { count: number; toolCalls: number; expanded: boolean };
  attachRef?: boolean;
  showTimestamp?: boolean;
}

function withBlocks(message: AssistantMessage, content: AssistantContentBlock[], omitUsage = false): AssistantMessage {
  return { ...message, content, ...(omitUsage ? { usage: undefined } : {}) };
}

function hasAnswer(message: AgentMessage): boolean {
  return message.role === "assistant" && splitFinalAssistantBlocks(message).answerBlocks.some((block) =>
    block.type === "image" || block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0);
}

function hasVisibleToolOutput(blocks: AssistantContentBlock[]): boolean {
  return hasFileMutationBlocks(blocks) || blocks.some((block) => block.type === "toolCall" && /^bash(?:\s|$)/.test(block.toolName));
}

/** A render plan, not React elements. Collapsed and offscreen messages stay unmounted. */
export function buildChatHistoryRows(messages: AgentMessage[], entryIds: string[], busy: boolean, expanded: ReadonlySet<string>) {
  const rows: ChatHistoryRow[] = [];
  const entryRows = new Map<string, string>();
  const addMessage = (index: number, prefix = "message", override?: AgentMessage, options: Partial<ChatHistoryRow> = {}) => {
    const message = override ?? messages[index];
    if (message.role === "toolResult" || message.role === "assistant"
      && !getDisplayableAssistantBlocks(message).length && !getAssistantErrorMessage(message)) return;
    const key = `${prefix}:${entryIds[index] || (message.role === "user" ? message.clientPromptId : undefined) || index}`;
    rows.push({ key, index, message, ...options });
    if (entryIds[index] && options.attachRef !== false) entryRows.set(entryIds[index], key);
  };
  for (let start = 0; start < messages.length;) {
    if (!isChatTurnAnchor(messages[start])) { addMessage(start++); continue; }
    let end = start + 1;
    while (end < messages.length && !isChatTurnAnchor(messages[end])) end++;
    let final = -1;
    for (let i = end - 1; i > start; i--) if (hasAnswer(messages[i])) { final = i; break; }
    if (final === -1) for (let i = end - 1; i > start; i--) if (messages[i].role === "assistant") { final = i; break; }
    if (final === -1 || busy && end === messages.length) {
      for (let i = start; i < end; i++) addMessage(i);
      start = end;
      continue;
    }
    addMessage(start);
    const process = Array.from({ length: final - start - 1 }, (_, i) => start + i + 1)
      .filter((i) => messages[i].role === "custom" || messages[i].role === "assistant" && getDisplayableAssistantBlocks(messages[i] as AssistantMessage).length > 0);
    const assistant = messages[final] as AssistantMessage;
    const split = splitFinalAssistantBlocks(assistant);
    const processMessage = split.processBlocks.length ? withBlocks(assistant, split.processBlocks, true) : undefined;
    const answer = split.answerBlocks.length || getAssistantErrorMessage(assistant) ? withBlocks(assistant, split.answerBlocks) : undefined;
    const count = process.length + Number(Boolean(processMessage));
    const changes = process.some((i) => messages[i].role === "assistant" && hasVisibleToolOutput(getDisplayableAssistantBlocks(messages[i] as AssistantMessage)))
      || hasVisibleToolOutput(split.processBlocks);
    if (count) {
      const key = `process:${entryIds[start] || start}`;
      if (!changes) {
        const toolCalls = process.reduce((total, i) => total + (messages[i].role === "assistant" ? countToolCallBlocks(getDisplayableAssistantBlocks(messages[i] as AssistantMessage)) : 0), 0)
          + countToolCallBlocks(split.processBlocks);
        rows.push({ key, index: start, process: { count, toolCalls, expanded: expanded.has(key) } });
        for (const i of process) if (entryIds[i]) entryRows.set(entryIds[i], key);
        if (!answer && entryIds[final]) entryRows.set(entryIds[final], key);
      }
      if (changes || expanded.has(key)) {
        for (const i of process) addMessage(i, "process-message");
        if (processMessage) addMessage(final, "process-final", processMessage, { attachRef: !answer, showTimestamp: false });
      }
    }
    if (answer) addMessage(final, "message", answer);
    for (let i = final + 1; i < end; i++) addMessage(i);
    start = end;
  }
  return { rows, entryRows };
}

export function messageFingerprint(message: AgentMessage, entryId?: string): string {
  if (!("content" in message)) return `${entryId}:${message.role}`;
  const content = message.content;
  if (typeof content === "string") return `${entryId}:${content.length}`;
  if (!Array.isArray(content)) return `${entryId}:empty`;
  let size = content.length;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if ("text" in block && typeof block.text === "string") size += block.text.length;
    if ("thinking" in block && typeof block.thinking === "string") size += block.thinking.length;
    if ("input" in block) { try { size += JSON.stringify(block.input)?.length ?? 0; } catch { size++; } }
  }
  return `${entryId ?? "stream"}:${size}`;
}
