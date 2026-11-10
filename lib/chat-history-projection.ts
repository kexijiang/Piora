import { buildCompactChatHistoryRows } from "./compact-chat-history";
import { insertCommandHistoryRows, layoutChatResponseRows } from "./chat-history";
import { insertModelChangeRows, type ModelChangeNotice } from "./model-change-notices";
import type { ChatCommandView } from "./chat-command-types";
import type { AgentMessage, ToolResultMessage, UserMessage } from "./types";
const NO_STABLE_KEYS: string[] = [];

/** Rebuilt on persisted/history edits, not on every streaming text update. */
export function prepareChatHistory(
  saved: AgentMessage[], ids: string[], choices: ReadonlyMap<string, boolean>,
  compact: boolean, direct: boolean, operations: ChatCommandView[], notices: ModelChangeNotice[],
) {
  const toolResults = new Map<string, ToolResultMessage>();
  const userIndices = new Map<number, number>();
  const showTimestamps = new Set<number>();
  const retryPrompts = new Map<number, { message: UserMessage; entryId?: string }>();
  let retryPrompt: { message: UserMessage; entryId?: string } | undefined;
  let lastUser = -1, lastAssistant = -1;
  for (let i = 0; i < saved.length; i++) {
    const message = saved[i];
    if (message.role === "toolResult") toolResults.set(message.toolCallId, message);
    if (message.role === "user") {
      retryPrompt = { message, entryId: ids[i] };
      userIndices.set(i, userIndices.size);
      if (lastAssistant >= 0) showTimestamps.add(lastAssistant);
      lastUser = i; lastAssistant = -1;
    }
    if (message.role === "assistant") lastAssistant = i;
    if (message.role === "assistant" && message.stopReason === "error" && retryPrompt) retryPrompts.set(i, retryPrompt);
  }
  if (lastAssistant >= 0) showTimestamps.add(lastAssistant);
  const start = Math.max(0, lastUser);
  const prefixToolCalls = new Set(saved.slice(0, start).flatMap(message => message.role === "assistant" && Array.isArray(message.content)
    ? message.content.flatMap(block => block.type === "toolCall" ? [block.toolCallId] : []) : []));
  // Keep global indices/keys. Slicing before projection would change anonymous
  // recovery identities and make the previous turn look like the latest turn.
  const prefix = buildCompactChatHistoryRows(saved, ids, false, choices, -1, compact, direct,
    { start: 0, end: start, results: toolResults });
  const extras = insertModelChangeRows(insertCommandHistoryRows([], saved, ids, operations), ids, notices);
  const rows = [...layoutChatResponseRows(prefix.rows, saved, false), ...extras.filter(row => row.index < start)]
    .sort((a, b) => a.index - b.index);
  return { saved, ids, choices, compact, direct, start, prefix, rows, keys: rows.map(row => row.key), prefixToolCalls, operations, notices,
    tailExtras: extras.filter(row => row.index >= start),
    metadata: { toolResults, userIndices, showTimestamps, lastUser, retryPrompts } };
}

/** Only the latest user turn is reprojected as its assistant/tool output grows. */
export function projectChatHistoryTail(base: ReturnType<typeof prepareChatHistory>, live: AgentMessage | null | undefined, busy: boolean) {
  const messages = live ? [...base.saved, live] : base.saved;
  const toolResults = live?.role === "toolResult"
    ? new Map(base.metadata.toolResults).set(live.toolCallId, live) : base.metadata.toolResults;
  // A late tool result may belong to an earlier turn (e.g. queued user input).
  // Invalidate that projection rather than displaying stale error/handoff state.
  if (live?.role === "toolResult" && base.prefixToolCalls.has(live.toolCallId)) {
    const plan = buildCompactChatHistoryRows(messages, base.ids, busy, base.choices, base.saved.length, base.compact, base.direct);
    const rows = insertModelChangeRows(layoutChatResponseRows(insertCommandHistoryRows(plan.rows, messages, base.ids, base.operations), messages, busy), base.ids, base.notices);
    return { messages, rows, toolResults, entryRows: plan.entryRows, entryGroups: plan.entryGroups, stableKeys: NO_STABLE_KEYS };
  }
  const tail = buildCompactChatHistoryRows(messages, base.ids, busy, base.choices,
    live ? base.saved.length : -1, base.compact, base.direct,
    { start: base.start, end: messages.length, results: toolResults });
  const extras = base.tailExtras.map(row => {
    // An unanchored command can precede the first live message after the saved
    // tail; preserve the old timestamp fallback without scanning old messages.
    if (row.operation && row.index === base.saved.length + .5 && live
      && (live.timestamp ?? 0) > row.operation.acceptedAt) return { ...row, index: base.saved.length - .5 };
    return row;
  });
  const rows = [...base.rows, ...[...layoutChatResponseRows(tail.rows, messages, busy, base.start), ...extras]
    .sort((a, b) => a.index - b.index || (a.operation?.acceptedAt ?? 0) - (b.operation?.acceptedAt ?? 0))];
  return { messages, rows, toolResults, stableKeys: base.keys,
    entryRows: { get: (id: string) => tail.entryRows.get(id) ?? base.prefix.entryRows.get(id) },
    entryGroups: { get: (id: string) => tail.entryGroups.get(id) ?? base.prefix.entryGroups.get(id) } };
}
