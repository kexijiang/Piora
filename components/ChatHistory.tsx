"use client";
import { memo, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type Ref, type RefObject } from "react";
import { CompactProcessSummary } from "./CompactProcessSummary";
import { buildCompactChatHistoryRows } from "@/lib/compact-chat-history";
import { CompactProcessContext, RevealProcessCommandContext } from "./CompactProcessContext";
import { insertCommandHistoryRows, layoutChatResponseRows, messageFingerprint } from "@/lib/chat-history";
import type { AgentMessage, ToolResultMessage } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";
import { MessageView } from "./MessageView";
import { RenderErrorBoundary } from "./RenderErrorBoundary";
import { AliIcon } from "./AliIcon";
import { VirtualList, type VirtualListHandle } from "./VirtualList";
import { ChatCommandCard, type ChatCommandCardActions } from "./ChatCommandCard";
import type { TaskTiming } from "@/lib/task-timing";
import type { ChatCommandView } from "@/lib/chat-command-types";

export interface ChatHistoryHandle { revealEntry(id: string): void; cancelNavigation(): void }
type MessageProps = ComponentProps<typeof MessageView>;
interface Props extends Pick<MessageProps, "modelNames" | "cwd" | "onOpenFile" | "onFork" | "onNavigate" | "onEditContent" | "onEditFailed" | "onRetry" | "retryDisabled" | "sessionId" | "onOpenAutomation" | "onOpenCommandExecution"> {
  messages: AgentMessage[];
  compactProcess?: boolean;
  directProcess?: boolean;
  streamingMessage?: AgentMessage | null;
  entryIds: string[];
  busy: boolean;
  streaming: boolean;
  isNew: boolean;
  forkingEntryId: string | null;
  highlightedEntryId: string | null;
  lastUserMsgRef: RefObject<HTMLDivElement | null>;
  pendingScrollToUserRef: RefObject<boolean>;
  scrollContainer: RefObject<HTMLDivElement | null>;
  handleRef: Ref<ChatHistoryHandle>;
  onDeleteMessage?: (message: AgentMessage, entryId?: string) => Promise<void>;
  deleteDisabled?: boolean;
  responseTimings?: Map<number, TaskTiming>;
  operations?: ChatCommandView[];
  commandActions?: ChatCommandCardActions;
}

function DeleteMessageAction({ message, entryId, onDelete, disabled }: { message: AgentMessage; entryId?: string; onDelete: NonNullable<Props["onDeleteMessage"]>; disabled: boolean }) {
  const { t } = useI18n();
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  return <span className="message-delete-action" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
    <button type="button" disabled={disabled || deleting} title={disabled ? t("chat.deleteMessageBusy") : t("chat.deleteMessage")}
      onClick={() => { if (disabled || deleting) return; setDeleting(true); setError(""); void onDelete(message, entryId).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setDeleting(false)); }}
      className="message-delete-button">
      <AliIcon name="delete" size={11} />{t(deleting ? "chat.deletingMessage" : "chat.deleteMessage")}
    </button>
    {error ? <span role="alert" style={{ fontSize: "var(--text-xs)", color: "var(--status-failed)" }}>{error}</span> : null}
  </span>;
}

/** One turn projection for saved history and the live tail in both display modes. */
export const ChatHistory = memo(function ChatHistory({ messages: savedMessages, compactProcess = false, directProcess = false, streamingMessage, entryIds, busy, streaming, isNew, forkingEntryId, highlightedEntryId, lastUserMsgRef, pendingScrollToUserRef, scrollContainer, handleRef, onDeleteMessage, deleteDisabled = false, operations = [], commandActions, responseTimings, ...messageProps }: Props) {
  const { t } = useI18n();
  const messages = useMemo(() => streamingMessage ? [...savedMessages, streamingMessage] : savedMessages, [savedMessages, streamingMessage]);
  const streamingIndex = streamingMessage ? messages.length - 1 : -1;
  const [expanded, setExpanded] = useState<Map<string, boolean>>(() => new Map());
  const [inspectCommand, setInspectCommand] = useState<string | null>(null);
  const list = useRef<VirtualListHandle>(null);
  const { rows, entryRows, entryGroups } = useMemo(() => {
    const plan = buildCompactChatHistoryRows(messages, entryIds, busy || streaming, expanded, streamingIndex, compactProcess, directProcess);
    return { ...plan, rows: layoutChatResponseRows(insertCommandHistoryRows(plan.rows, messages, entryIds, operations), messages, busy || streaming) };
  }, [messages, entryIds, busy, streaming, expanded, compactProcess, directProcess, streamingIndex, operations]);
  const visibleRows = rows;
  const keys = useMemo(() => visibleRows.map((row) => row.key), [visibleRows]);
  const pendingReveal = useRef<string | null>(null);
  useLayoutEffect(() => {
    const key = pendingReveal.current ? entryRows.get(pendingReveal.current) : undefined;
    if (key && keys.includes(key) && !key.startsWith("compact-process:")) {
      list.current?.scrollToKey(key);
      pendingReveal.current = null;
    }
  }, [keys, entryRows]);
  const metadata = useMemo(() => {
    const toolResults = new Map<string, ToolResultMessage>();
    const userIndices = new Map<number, number>();
    const showTimestamps = new Set<number>();
    let lastUser = -1;
    let lastAssistant = -1;
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (message.role === "toolResult") toolResults.set(message.toolCallId, message);
      if (message.role === "user") {
        userIndices.set(i, userIndices.size);
        if (lastAssistant >= 0) showTimestamps.add(lastAssistant);
        lastUser = i; lastAssistant = -1;
      }
      if (message.role === "assistant") {
        lastAssistant = i;
      }
    }
    if (lastAssistant >= 0) showTimestamps.add(lastAssistant);
    return { toolResults, userIndices, lastUser, showTimestamps };
  }, [messages]);
  useImperativeHandle(handleRef, () => ({
    revealEntry(id) {
      const key = entryRows.get(id);
      const group = entryGroups.get(id);
      if (group) {
        pendingReveal.current = id;
        setExpanded(previous => new Map(previous).set(group, true));
      } else if (key) list.current?.scrollToKey(key);
    },
    cancelNavigation() { pendingReveal.current = null; list.current?.cancelNavigation(); },
  }), [entryRows, entryGroups]);
  const toggle = useCallback((key: string, open: boolean) => setExpanded(previous => new Map(previous).set(key, open)), []);

  // Mount the newly sent prompt before the session hook's layout scroll runs.
  const pendingUserKey = pendingScrollToUserRef.current ? rows.find((row) => !row.process && row.index === metadata.lastUser)?.key : undefined;
  return <VirtualList keys={keys} pinnedKeys={pendingUserKey ? [pendingUserKey] : []} estimate={160} initialTail scrollContainer={scrollContainer} handleRef={list} renderItem={(_key, rowIndex) => {
    const row = visibleRows[rowIndex];
    if (row.operation) return commandActions ? <ChatCommandCard record={row.operation} actions={commandActions} /> : null;
    if (row.compactProcess) return <CompactProcessSummary group={row.compactProcess}
      onToggle={() => { setInspectCommand(null); toggle(row.key, !row.compactProcess!.expanded); }}
      onInspectCommand={(id) => {
        setInspectCommand(id);
        setExpanded(previous => new Map(previous).set(row.key, true));
      }} />;
    const index = row.index;
    const message = row.message!;
    const showTimestamp = row.showTimestamp ?? (metadata.showTimestamps.has(index) && !(streaming && index === messages.length - 1));
    return <CompactProcessContext.Provider value={true}><RevealProcessCommandContext.Provider value={inspectCommand}><div className={`chat-message-shell${row.secondary ? " compact-process-detail" : ""}${highlightedEntryId === entryIds[index] ? " is-search-target" : ""}`} data-chat-entry-id={entryIds[index]} data-chat-user-index={metadata.userIndices.get(index)}
      data-process-join-before={Boolean(row.processGroupKey && visibleRows[rowIndex - 1]?.processGroupKey === row.processGroupKey) || undefined}
      data-process-join-after={Boolean(row.processGroupKey && visibleRows[rowIndex + 1]?.processGroupKey === row.processGroupKey) || undefined}
      onClickCapture={(event) => {
        if (row.processGroupKey && (event.target as HTMLElement).closest("button, a, input, textarea")) {
          setExpanded(previous => previous.get(row.processGroupKey!) === true ? previous : new Map(previous).set(row.processGroupKey!, true));
        }
      }}
      ref={index === metadata.lastUser ? (element) => { lastUserMsgRef.current = element; if (element && pendingScrollToUserRef.current) list.current?.cancelNavigation(); } : undefined}>
      <RenderErrorBoundary resetKey={messageFingerprint(message, entryIds[index])} fallbackLabel={t("chat.messageRenderFailed")} errorTitle={t("chat.messageRenderError")}>
        <MessageView {...messageProps} message={message} intermediate={row.intermediate} isStreaming={row.isStreaming} toolResults={metadata.toolResults} entryId={entryIds[index]}
          messageActions={row.attachRef !== false && onDeleteMessage && (entryIds[index] || message.role === "user" && message.clientPromptId) ? <DeleteMessageAction message={messages[index]} entryId={entryIds[index]} onDelete={onDeleteMessage} disabled={deleteDisabled || busy || streaming} /> : null}
          onFork={busy || isNew || index === 0 && message.role === "user" ? undefined : messageProps.onFork}
          onNavigate={busy ? undefined : messageProps.onNavigate}
          forking={forkingEntryId === entryIds[index]}
          prevAssistantEntryId={!busy && message.role === "user" && messages[index - 1]?.role === "assistant" ? entryIds[index - 1] : undefined}
          showTimestamp={showTimestamp} prevTimestamp={messages[index - 1]?.timestamp}
          taskTiming={responseTimings?.get(index)} />
      </RenderErrorBoundary>
    </div></RevealProcessCommandContext.Provider></CompactProcessContext.Provider>;
  }} />;
});
