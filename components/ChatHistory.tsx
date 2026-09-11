"use client";
import { memo, useCallback, useImperativeHandle, useMemo, useRef, useState, type ComponentProps, type Ref, type RefObject } from "react";
import { buildChatHistoryRows, messageFingerprint } from "@/lib/chat-history";
import type { AgentMessage, ToolResultMessage } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";
import { MessageView } from "./MessageView";
import { RenderErrorBoundary } from "./RenderErrorBoundary";
import { AliIcon } from "./AliIcon";
import { VirtualList, type VirtualListHandle } from "./VirtualList";

export interface ChatHistoryHandle { revealEntry(id: string): void; cancelNavigation(): void }
type MessageProps = ComponentProps<typeof MessageView>;
interface Props extends Pick<MessageProps, "modelNames" | "cwd" | "onOpenFile" | "onFork" | "onNavigate" | "onEditContent" | "onRetry" | "retryDisabled" | "sessionId" | "onOpenAutomation" | "onOpenCommandExecution"> {
  messages: AgentMessage[];
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
}

function DeleteMessageAction({ message, entryId, onDelete, disabled }: { message: AgentMessage; entryId?: string; onDelete: NonNullable<Props["onDeleteMessage"]>; disabled: boolean }) {
  const { t } = useI18n();
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  return <div className="message-delete-action" style={{ display: "flex", justifyContent: message.role === "user" ? "flex-end" : "flex-start", alignItems: "center", gap: 8, marginBottom: 8 }}>
    {error ? <span role="alert" style={{ fontSize: "var(--text-xs)", color: "var(--status-failed)" }}>{error}</span> : null}
    <button type="button" disabled={disabled || deleting} title={disabled ? t("chat.deleteMessageBusy") : t("chat.deleteMessage")}
      onClick={() => { if (disabled || deleting) return; setDeleting(true); setError(""); void onDelete(message, entryId).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setDeleting(false)); }}
      style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 8px", border: "none", background: "none", color: "var(--text-dim)", fontSize: "var(--text-xs)", cursor: disabled || deleting ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1 }}>
      <AliIcon name="delete" size={12} />{t(deleting ? "chat.deletingMessage" : "chat.deleteMessage")}
    </button>
  </div>;
}

/** Live text stays in ChatWindow. Stable history does not render on token updates. */
export const ChatHistory = memo(function ChatHistory({ messages, entryIds, busy, streaming, isNew, forkingEntryId, highlightedEntryId, lastUserMsgRef, pendingScrollToUserRef, scrollContainer, handleRef, onDeleteMessage, deleteDisabled = false, ...messageProps }: Props) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const list = useRef<VirtualListHandle>(null);
  const { rows, entryRows } = useMemo(() => buildChatHistoryRows(messages, entryIds, busy || streaming, expanded), [messages, entryIds, busy, streaming, expanded]);
  const keys = useMemo(() => rows.map((row) => row.key), [rows]);
  const metadata = useMemo(() => {
    const toolResults = new Map<string, ToolResultMessage>();
    const userIndices = new Map<number, number>();
    const responseStarts = new Map<number, number>();
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
        if (lastUser >= 0 && messages[lastUser].timestamp !== undefined) responseStarts.set(i, messages[lastUser].timestamp!);
      }
    }
    if (lastAssistant >= 0) showTimestamps.add(lastAssistant);
    return { toolResults, userIndices, lastUser, responseStarts, showTimestamps };
  }, [messages]);
  useImperativeHandle(handleRef, () => ({
    revealEntry(id) { const key = entryRows.get(id); if (key) list.current?.scrollToKey(key); },
    cancelNavigation() { list.current?.cancelNavigation(); },
  }), [entryRows]);
  const toggle = useCallback((key: string) => setExpanded((previous) => {
    const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next;
  }), []);

  // Mount the newly sent prompt before the session hook's layout scroll runs.
  const pendingUserKey = pendingScrollToUserRef.current ? rows.find((row) => !row.process && row.index === metadata.lastUser)?.key : undefined;
  return <VirtualList keys={keys} pinnedKeys={pendingUserKey ? [pendingUserKey] : []} estimate={160} initialTail scrollContainer={scrollContainer} handleRef={list} renderItem={(_key, rowIndex) => {
    const row = rows[rowIndex];
    if (row.process) {
      const { count, toolCalls, expanded: open } = row.process;
      const parts = [t("chat.processDetails"), `${count} ${t(count === 1 ? "chat.message" : "chat.messages")}`];
      if (toolCalls) parts.push(`${toolCalls} ${t(toolCalls === 1 ? "chat.toolCall" : "chat.toolCalls")}`);
      return <button type="button" className="chat-process-toggle" aria-expanded={open} onClick={() => toggle(row.key)} title={t(open ? "chat.collapseProcess" : "chat.expandProcess")}>
        <AliIcon name="arrowright" size={12} style={{ transform: open ? "rotate(90deg)" : "none" }} /><span>{parts.join(" · ")}</span>
      </button>;
    }
    const index = row.index;
    const message = row.message!;
    const showTimestamp = row.showTimestamp ?? (metadata.showTimestamps.has(index) && !(streaming && index === messages.length - 1));
    return <div className={`chat-message-shell${highlightedEntryId === entryIds[index] ? " is-search-target" : ""}`} data-chat-entry-id={entryIds[index]} data-chat-user-index={metadata.userIndices.get(index)}
      ref={index === metadata.lastUser ? (element) => { lastUserMsgRef.current = element; if (element && pendingScrollToUserRef.current) list.current?.cancelNavigation(); } : undefined}>
      <RenderErrorBoundary resetKey={messageFingerprint(message, entryIds[index])} fallbackLabel={t("chat.messageRenderFailed")} errorTitle={t("chat.messageRenderError")}>
        <MessageView {...messageProps} message={message} toolResults={metadata.toolResults} entryId={entryIds[index]}
          onFork={busy || isNew || index === 0 && message.role === "user" ? undefined : messageProps.onFork}
          onNavigate={busy ? undefined : messageProps.onNavigate}
          forking={forkingEntryId === entryIds[index]}
          prevAssistantEntryId={!busy && message.role === "user" && messages[index - 1]?.role === "assistant" ? entryIds[index - 1] : undefined}
          showTimestamp={showTimestamp} prevTimestamp={messages[index - 1]?.timestamp}
          responseStartedAt={showTimestamp && !(busy && index > metadata.lastUser) ? metadata.responseStarts.get(index) : undefined} />
      </RenderErrorBoundary>
      {onDeleteMessage && (entryIds[index] || message.role === "user" && message.clientPromptId) ? <DeleteMessageAction message={messages[index]} entryId={entryIds[index]} onDelete={onDeleteMessage} disabled={deleteDisabled || busy || streaming} /> : null}
    </div>;
  }} />;
});
