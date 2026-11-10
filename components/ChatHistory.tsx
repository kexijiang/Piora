"use client";
import { memo, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type Ref, type RefObject } from "react";
import { CompactProcessSummary } from "./CompactProcessSummary";
import { prepareChatHistory, projectChatHistoryTail } from "@/lib/chat-history-projection";
import { CompactProcessContext, RevealProcessCommandContext } from "./CompactProcessContext";
import { messageFingerprint } from "@/lib/chat-history";
import type { AgentMessage } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";
import { MessageView } from "./MessageView";
import { RenderErrorBoundary } from "./RenderErrorBoundary";
import { AliIcon } from "./AliIcon";
import { VirtualList, type VirtualListHandle } from "./VirtualList";
import { ChatCommandCard, type ChatCommandCardActions } from "./ChatCommandCard";
import { ModelChangeNotice } from "./ModelChangeNotice";
import { type ModelChangeNotice as ModelChange } from "@/lib/model-change-notices";
import type { TaskTiming } from "@/lib/task-timing";
import type { ChatCommandView } from "@/lib/chat-command-types";

export interface ChatHistoryHandle { revealEntry(id: string): void; cancelNavigation(): void }
type MessageProps = ComponentProps<typeof MessageView>;
interface Props extends Pick<MessageProps, "modelNames" | "cwd" | "onOpenFile" | "onFork" | "onNavigate" | "onEditContent" | "onEditFailed" | "onRetry" | "retryDisabled" | "sessionId" | "onOpenAutomation" | "onOpenCommandExecution"> {
  visible?: boolean;
  onBranch?: (entryId: string) => Promise<void>;
  messages: AgentMessage[];
  modelChanges?: ModelChange[];
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

const NO_MODEL_CHANGES: ModelChange[] = [];
const NO_OPERATIONS: ChatCommandView[] = [];

const HistoryMessage = memo(function HistoryMessage({ originalMessage, allowActions, onBranch, onDeleteMessage, actionsDisabled, deleteDisabled, ...props }: MessageProps & {
  originalMessage: AgentMessage; allowActions: boolean; onBranch?: Props["onBranch"];
  onDeleteMessage?: Props["onDeleteMessage"]; actionsDisabled: boolean; deleteDisabled: boolean;
}) {
  const { t } = useI18n();
  const { entryId, message, intermediate } = props;
  const actions = useMemo(() => <>
    {onBranch && allowActions && entryId && (message.role === "user" || message.role === "assistant" && !intermediate && !message.content.some(block => block.type === "toolCall")) ?
      <button type="button" className="message-delete-button" disabled={actionsDisabled} title={t("i18n.branchFromHereTitle")} onClick={() => { void onBranch(entryId); }}><AliIcon name="fork" size={11} />{t("i18n.branchFromHere")}</button> : null}
    {allowActions && onDeleteMessage && (entryId || message.role === "user" && message.clientPromptId) ? <DeleteMessageAction message={originalMessage} entryId={entryId} onDelete={onDeleteMessage} disabled={deleteDisabled} /> : null}
  </>, [onBranch, allowActions, entryId, message, intermediate, actionsDisabled, onDeleteMessage, originalMessage, deleteDisabled, t]);
  return <MessageView {...props} messageActions={actions} />;
});

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
function ChatHistoryContent({ visible: _visible, messages: savedMessages, modelChanges = NO_MODEL_CHANGES, compactProcess = true, directProcess = false, streamingMessage, entryIds, busy, streaming, isNew, forkingEntryId, highlightedEntryId, lastUserMsgRef, pendingScrollToUserRef, scrollContainer, handleRef, onBranch, onDeleteMessage, deleteDisabled = false, operations = NO_OPERATIONS, commandActions, responseTimings, ...messageProps }: Props) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<Map<string, boolean>>(() => new Map());
  const [inspectCommand, setInspectCommand] = useState<string | null>(null);
  const list = useRef<VirtualListHandle>(null);
  const base = useMemo(() => prepareChatHistory(savedMessages, entryIds, expanded, compactProcess, directProcess, operations, modelChanges),
    [savedMessages, entryIds, expanded, compactProcess, directProcess, operations, modelChanges]);
  const { messages, rows, entryRows, entryGroups, toolResults, stableKeys } = useMemo(() => projectChatHistoryTail(base, streamingMessage, busy || streaming), [base, streamingMessage, busy, streaming]);
  const activeGroups = useRef<Set<string>>(new Set());
  useLayoutEffect(() => {
    const next = new Set(rows.filter(row => row.compactProcess?.active).map(row => row.key));
    const changes = rows.filter(row => row.compactProcess && row.compactProcess.active !== activeGroups.current.has(row.key));
    activeGroups.current = next;
    if (!compactProcess || directProcess || !changes.length) return;
    setExpanded(previous => {
      const updated = new Map(previous);
      for (const row of changes) updated.set(row.key, row.compactProcess!.active);
      return updated;
    });
  }, [rows, compactProcess, directProcess]);
  const metadata = base.metadata;
  const visibleRows = rows;
  // Text-only deltas retain the key array too: VirtualList need not rebuild
  // every offset or prune its height/disclosure caches on every token.
  const tailKeysJson = JSON.stringify(rows.slice(stableKeys.length).map(row => row.key));
  const keys = useMemo(() => [...stableKeys, ...JSON.parse(tailKeysJson) as string[]], [stableKeys, tailKeysJson]);
  const pendingReveal = useRef<string | null>(null);
  useLayoutEffect(() => {
    const key = pendingReveal.current ? entryRows.get(pendingReveal.current) : undefined;
    if (key && keys.includes(key) && !key.startsWith("compact-process:")) {
      list.current?.scrollToKey(key);
      pendingReveal.current = null;
    }
  }, [keys, entryRows]);
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

  // A session can first mount behind settings (e.g. after extension reload).
  // Subsequent hides are handled by the memo boundary without unmounting rows.
  if (_visible === false) return null;

  // Mount the newly sent prompt before the session hook's layout scroll runs.
  const pendingUserKey = pendingScrollToUserRef.current ? rows.find((row) => !row.process && row.index === metadata.lastUser)?.key : undefined;
  return <VirtualList keys={keys} pinnedKeys={pendingUserKey ? [pendingUserKey] : []} estimate={160} initialTail scrollContainer={scrollContainer} handleRef={list} renderItem={(_key, rowIndex) => {
    const row = visibleRows[rowIndex];
    if (row.modelChange) return <ModelChangeNotice notice={row.modelChange} modelNames={messageProps.modelNames} />;
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
        <HistoryMessage {...messageProps} message={message} intermediate={row.intermediate} isStreaming={row.isStreaming} toolResults={toolResults} entryId={entryIds[index]}
          retryPrompt={metadata.retryPrompts.get(index)} retryDisabled={messageProps.retryDisabled || busy || streaming}
          originalMessage={messages[index]} allowActions={row.attachRef !== false} onBranch={onBranch} onDeleteMessage={onDeleteMessage}
          actionsDisabled={busy || streaming || isNew || Boolean(forkingEntryId)} deleteDisabled={deleteDisabled || busy || streaming}
          onFork={busy || isNew || index === 0 && message.role === "user" ? undefined : messageProps.onFork}
          onNavigate={busy ? undefined : messageProps.onNavigate}
          forking={forkingEntryId === entryIds[index]}
          prevAssistantEntryId={!busy && message.role === "user" && messages[index - 1]?.role === "assistant" ? entryIds[index - 1] : undefined}
          showTimestamp={showTimestamp} prevTimestamp={messages[index - 1]?.timestamp}
          taskTiming={responseTimings?.get(index)} />
      </RenderErrorBoundary>
    </div></RevealProcessCommandContext.Provider></CompactProcessContext.Provider>;
  }} />;
}

// Freeze only the presentation. The owning session hook keeps receiving SSE,
// reconciling completion and persisting recovery receipts while settings is open.
// Retaining this subtree also retains virtual heights and disclosure state.
export const ChatHistory = memo(ChatHistoryContent, (previous, next) =>
  next.visible === false || Object.keys(next).length === Object.keys(previous).length
    && (Object.keys(next) as Array<keyof Props>).every(key => Object.is(previous[key], next[key])));
