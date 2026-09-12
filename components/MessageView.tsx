"use client";
import { messageImageUrl } from "@/lib/message-images";

import { createContext, useContext, memo, useState, useRef, useEffect, useMemo, useCallback, type ReactNode } from "react";
import { useVirtualRowToggle } from "./VirtualRowState";
import dynamic from "next/dynamic";
import { LazyMarkdownBody as MarkdownBody } from "./LazyMarkdownBody";
import { copyText } from "@/lib/clipboard";
import { useI18n } from "@/hooks/useI18n";
import { parseCompactionSummary } from "@/lib/compaction-summary";
import { summarizeToolDisclosure } from "@/lib/tool-summary";
import { commandExitCode, commandResultMetadata, commandStatus, isCommandToolName, toolResultText, type CommandExecutionData } from "@/lib/command-execution";
import { getFileChangeInfo, type FileChangeInfo } from "@/lib/file-change";
import {
  getAssistantErrorMessage,
  getThinkingBlockDisplay,
  isEmptyThinkingBlock,
  shouldSubscribeToThinkingLoad,
  subscribeToThinkingLoad,
  type ThinkingLoadState,
} from "@/lib/message-display";
import type {
  AgentMessage,
  UserMessage,
  AssistantMessage,
  CustomMessage,
  ToolResultMessage,
  BashExecutionMessage,
  AssistantContentBlock,
  TextContent,
  ImageContent,
  ToolCallContent,
  ThinkingContent,
} from "@/lib/types";
import { AliIcon, type AliIconName } from "./AliIcon";
import { MessageImage, MessageImageViewer } from "./MessageImage";
import { CommandExecutionCard } from "./CommandExecutionView";
import { ChatDisclosure, DisclosureChevron, DisclosurePath } from "./ChatDisclosure";

const DiffView = dynamic(
  () => import("./DiffView").then((module) => module.DiffView),
  { ssr: false },
);
const AutomationCard = dynamic(
  () => import("./AutomationPanel").then((module) => module.AutomationCard),
  { ssr: false },
);

const MAX_THINKING_CACHE_ENTRIES = 100;
const THINKING_LOAD_TIMEOUT_MS = 15_000;
const USER_MESSAGE_COLLAPSE_LINE_THRESHOLD = 12;
const USER_MESSAGE_PREVIEW_LINES = 8;
const USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD = 2_400;
const USER_MESSAGE_PREVIEW_CHARS = 1_800;
type ThinkingCacheEntry = { promise: Promise<string> };
const thinkingContentCache = new Map<string, ThinkingCacheEntry>();

export function getUserMessagePreview(content: string): { collapsible: boolean; preview: string; lineCount: number } {
  const lines = content.split(/\r\n|\r|\n/);
  const collapsible = lines.length > USER_MESSAGE_COLLAPSE_LINE_THRESHOLD
    || content.length > USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD;
  if (!collapsible) return { collapsible: false, preview: content, lineCount: lines.length };

  const linePreview = lines.slice(0, USER_MESSAGE_PREVIEW_LINES).join("\n");
  const preview = linePreview.length > USER_MESSAGE_PREVIEW_CHARS
    ? `${linePreview.slice(0, USER_MESSAGE_PREVIEW_CHARS).trimEnd()}…`
    : linePreview;
  return { collapsible: true, preview, lineCount: lines.length };
}

function loadThinkingContent(sessionId: string, entryId: string, blockIndex: number, historyVersion?: string): Promise<string> {
  const key = `${sessionId}:${entryId}:${blockIndex}:${historyVersion ?? "chat"}`;
  const cached = thinkingContentCache.get(key);
  if (cached) {
    thinkingContentCache.delete(key);
    thinkingContentCache.set(key, cached);
    return cached.promise;
  }

  const cacheEntry = {} as ThinkingCacheEntry;
  const request = (async () => {
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, THINKING_LOAD_TIMEOUT_MS);
    try {
      const response = await fetch(
        historyVersion
          ? `/api/sessions/${encodeURIComponent(sessionId)}/history/content?${new URLSearchParams({ entryId, blockIndex: String(blockIndex), kind: "thinking", version: historyVersion })}`
          : `/api/sessions/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(entryId)}/thinking?blockIndex=${blockIndex}`,
        { signal: controller.signal },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      const data = await response.json() as { thinking?: unknown };
      if (typeof data.thinking !== "string") throw new Error("Invalid thinking response");
      return data.thinking;
    } catch (error) {
      if (timedOut) throw new Error("Thinking content request timed out");
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  })().catch((error) => {
    if (thinkingContentCache.get(key) === cacheEntry) {
      thinkingContentCache.delete(key);
    }
    throw error;
  });

  cacheEntry.promise = request;
  thinkingContentCache.set(key, cacheEntry);
  if (thinkingContentCache.size > MAX_THINKING_CACHE_ENTRIES) {
    const oldestKey = thinkingContentCache.keys().next().value;
    if (oldestKey) thinkingContentCache.delete(oldestKey);
  }
  return request;
}

interface Props {
  mode?: "chat" | "history";
  historyVersion?: string;
  messageActions?: ReactNode;
  message: AgentMessage;
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  modelNames?: Record<string, string>;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  entryId?: string;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  onNavigate?: (entryId: string) => void;
  prevAssistantEntryId?: string;
  onEditContent?: (content: string) => void;
  onRetry?: (message: UserMessage, entryId?: string) => Promise<void>;
  retryDisabled?: boolean;
  showTimestamp?: boolean;
  prevTimestamp?: number;
  responseStartedAt?: number;
  sessionId?: string;
  onOpenAutomation?: (automationId: string) => void;
  onOpenCommandExecution?: (data: CommandExecutionData) => void;
}

function formatTime(ts?: number): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isToday) return time;
  const date = d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
  return `${date} ${time}`;
}

function formatResponseDuration(startedAt?: number, finishedAt?: number): string | null {
  if (startedAt === undefined || finishedAt === undefined || finishedAt < startedAt) return null;
  const elapsedMs = finishedAt - startedAt;
  if (elapsedMs < 10_000) return `${Math.max(0.1, elapsedMs / 1_000).toFixed(1)}s`;
  const seconds = Math.round(elapsedMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function haveSameRelevantToolResults(
  message: AgentMessage,
  previous: Map<string, ToolResultMessage> | undefined,
  next: Map<string, ToolResultMessage> | undefined,
): boolean {
  if (previous === next || message.role !== "assistant") return true;
  for (const block of (message as AssistantMessage).content ?? []) {
    if (block?.type === "toolCall" && previous?.get(block.toolCallId) !== next?.get(block.toolCallId)) {
      return false;
    }
  }
  return true;
}

export function getAutomationToolCardDetails(
  block: Pick<ToolCallContent, "toolName" | "input">,
  result: ToolResultMessage | undefined,
): { id: string; name?: string; rrule?: string } | null {
  if (block.toolName !== "piora_automation" || (block.input as { action?: unknown })?.action !== "create" || result?.isError) {
    return null;
  }
  const automation = (result?.details as { automation?: { id?: unknown; name?: unknown; rrule?: unknown } } | undefined)?.automation;
  if (typeof automation?.id !== "string") return null;
  return {
    id: automation.id,
    ...(typeof automation.name === "string" ? { name: automation.name } : {}),
    ...(typeof automation.rrule === "string" ? { rrule: automation.rrule } : {}),
  };
}

const HistoryModeContext = createContext(false);
const HistoryVersionContext = createContext<string | undefined>(undefined);
export const MessageView = memo(function MessageView(props: Props) {
  const history = props.mode === "history";
  return <HistoryModeContext.Provider value={history}><HistoryVersionContext.Provider value={props.historyVersion}><MessageContent {...props}
    onFork={history ? undefined : props.onFork} onNavigate={history ? undefined : props.onNavigate}
    onRetry={history ? undefined : props.onRetry} onEditContent={history ? undefined : props.onEditContent}
    onOpenAutomation={history ? undefined : props.onOpenAutomation} /></HistoryVersionContext.Provider></HistoryModeContext.Provider>;
});

const MessageContent = memo(function MessageContent({ mode, messageActions, message, isStreaming, toolResults, modelNames, cwd, onOpenFile, entryId, onFork, forking, onNavigate, prevAssistantEntryId, onEditContent, onRetry, retryDisabled, showTimestamp, prevTimestamp, responseStartedAt, sessionId, onOpenAutomation, onOpenCommandExecution }: Props) {
  if (message.role === "user") {
    return <UserMessageView messageActions={messageActions} message={message as UserMessage} cwd={cwd} onOpenFile={onOpenFile} entryId={entryId} onFork={onFork} forking={forking} onNavigate={onNavigate} prevAssistantEntryId={prevAssistantEntryId} onEditContent={onEditContent} onRetry={onRetry} retryDisabled={retryDisabled} sessionId={sessionId} />;
  }
  if (message.role === "assistant") {
    return <AssistantMessageView messageActions={messageActions} message={message as AssistantMessage} isStreaming={isStreaming} toolResults={toolResults} modelNames={modelNames} cwd={cwd} onOpenFile={onOpenFile} showTimestamp={showTimestamp} prevTimestamp={prevTimestamp} responseStartedAt={responseStartedAt} sessionId={sessionId} entryId={entryId} onOpenAutomation={onOpenAutomation} onOpenCommandExecution={onOpenCommandExecution} />;
  }
  if (message.role === "toolResult") {
    // Rendered inline under its toolCall — skip standalone rendering if paired
    return null;
  }
  if (message.role === "custom") {
    if ((message as CustomMessage).customType === "compaction") {
      return <div className="message-row"><CompactionMessageView message={message as CustomMessage} /><div className="message-hover-actions">{messageActions}</div></div>;
    }
    if (mode !== "history" && (message as CustomMessage).customType === "piora-automation") {
      const details = (message as CustomMessage).details as { automationId?: unknown; name?: unknown; rrule?: unknown } | undefined;
      return typeof details?.automationId === "string" ? (
        <div className="message-row"><AutomationCard
          automationId={details.automationId}
          fallbackName={typeof details.name === "string" ? details.name : undefined}
          fallbackRrule={typeof details.rrule === "string" ? details.rrule : undefined}
          onOpen={onOpenAutomation}
        /><div className="message-hover-actions">{messageActions}</div></div>
      ) : null;
    }
    return <CustomMessageView messageActions={messageActions} message={message as CustomMessage} cwd={cwd} onOpenFile={onOpenFile} />;
  }
  if (message.role === "bashExecution") {
    return <BashExecutionView messageActions={messageActions} message={message as BashExecutionMessage} sessionId={sessionId} cwd={cwd} onOpenCommandExecution={onOpenCommandExecution} />;
  }
  return null;
}, (prev, next) => {
  return prev.message === next.message
    && prev.mode === next.mode
    && prev.messageActions === next.messageActions
    && prev.isStreaming === next.isStreaming
    && haveSameRelevantToolResults(prev.message, prev.toolResults, next.toolResults)
    && prev.modelNames === next.modelNames
    && prev.responseStartedAt === next.responseStartedAt
    && prev.cwd === next.cwd
    && prev.onOpenFile === next.onOpenFile
    && prev.entryId === next.entryId
    && prev.onFork === next.onFork
    && prev.forking === next.forking
    && prev.onNavigate === next.onNavigate
    && prev.prevAssistantEntryId === next.prevAssistantEntryId
    && prev.onEditContent === next.onEditContent
    && prev.onRetry === next.onRetry
    && prev.retryDisabled === next.retryDisabled
    && prev.showTimestamp === next.showTimestamp
    && prev.prevTimestamp === next.prevTimestamp
    && prev.sessionId === next.sessionId
    && prev.onOpenAutomation === next.onOpenAutomation
    && prev.onOpenCommandExecution === next.onOpenCommandExecution;
});

function UserMessageView({ messageActions, message, cwd, onOpenFile, entryId, onFork, forking, onNavigate, prevAssistantEntryId, onEditContent, onRetry, retryDisabled, sessionId }: {
  messageActions?: ReactNode;
  message: UserMessage;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  entryId?: string;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  onNavigate?: (entryId: string) => void;
  prevAssistantEntryId?: string;
  onEditContent?: (content: string) => void;
  onRetry?: (message: UserMessage, entryId?: string) => Promise<void>;
  retryDisabled?: boolean;
  sessionId?: string;
}) {
  const { t, locale } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [contentExpanded, setContentExpanded] = useVirtualRowToggle("user-content");
  const [loadedContent, setLoadedContent] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentLoadError, setContentLoadError] = useState<string | null>(null);
  const [openImageIndex, setOpenImageIndex] = useState<number | null>(null);

  const initialContent =
    typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content
          .filter((b): b is TextContent => b?.type === "text" && typeof b.text === "string")
          .map((b) => b.text as string)
          .join("\n")
        : "";
  const content = loadedContent ?? initialContent;
  const historyVersion = useContext(HistoryVersionContext);
  const historyMode = useContext(HistoryModeContext);
  const hasDeferredContent = message.deferredContent === true && loadedContent === null;

  const imageBlocks: ImageContent[] =
    Array.isArray(message.content)
      ? message.content.filter((b): b is ImageContent => b?.type === "image")
      : [];

  const time = formatTime(message.timestamp);
  const sendError = message.sendError;
  const canFork = !!entryId && !!onFork;
  const canNavigate = !!prevAssistantEntryId && !!onNavigate;
  const contentPreview = useMemo(() => {
    const preview = getUserMessagePreview(content);
    return hasDeferredContent
      ? { ...preview, collapsible: true, lineCount: message.deferredLineCount ?? preview.lineCount }
      : preview;
  }, [content, hasDeferredContent, message.deferredLineCount]);
  const displayedContent = contentPreview.collapsible && !contentExpanded
    ? contentPreview.preview
    : content;
  const contentLineCount = contentPreview.lineCount.toLocaleString(locale);

  const loadFullContent = useCallback(async (): Promise<string> => {
    if (!hasDeferredContent) return content;
    if (!sessionId || !entryId) throw new Error(t("chat.longMessageUnavailable"));
    setContentLoading(true);
    setContentLoadError(null);
    try {
      const response = await fetch(historyVersion
        ? `/api/sessions/${encodeURIComponent(sessionId)}/history/content?${new URLSearchParams({ entryId, kind: "prompt", version: historyVersion })}`
        : `/api/sessions/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(entryId)}/prompt-material`,
      historyVersion ? { signal: AbortSignal.timeout(30_000) } : undefined);
      const body = await response.json().catch(() => ({})) as { content?: unknown; error?: unknown };
      if (!response.ok || typeof body.content !== "string") {
        throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
      }
      setLoadedContent(body.content);
      return body.content;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setContentLoadError(errorMessage);
      throw error;
    } finally {
      setContentLoading(false);
    }
  }, [hasDeferredContent, content, sessionId, entryId, t, historyVersion]);

  useEffect(() => {
    if (contentExpanded && hasDeferredContent) void loadFullContent().catch(() => {});
  }, [contentExpanded, hasDeferredContent, loadFullContent]);

  const copyContent = () => {
    Promise.resolve(loadFullContent()).then((fullContent) => copyText(fullContent)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  const toggleContent = () => {
    if (contentExpanded) {
      setContentExpanded(false);
      return;
    }
    if (!hasDeferredContent) {
      setContentExpanded(true);
      return;
    }
    void loadFullContent().then(() => setContentExpanded(true)).catch(() => {});
  };

  return (
    <div
      className="message-row message-row-user"
      style={{ marginBottom: 16, display: "flex", flexDirection: "column", alignItems: "flex-end" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{ display: "flex", alignItems: "flex-end", gap: 6, maxWidth: "85%" }}>
        <div
          className="message-user-bubble"
          style={{
            flex: 1,
            minWidth: 0,
            background: "var(--user-bg)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-surface)",
            padding: "8px 12px",
            fontSize: "var(--text-base)",
            lineHeight: 1.6,
            color: "var(--text)",
            wordBreak: "break-word",
          }}
        >
          {imageBlocks.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: content ? 8 : 0 }}>
              {imageBlocks.map((img, i) => {
                const src = messageImageUrl(img);
                return src ? <MessageImage key={i} src={src} index={i} onOpen={() => setOpenImageIndex(i)} /> : null;
              })}
            </div>
          )}
          {openImageIndex !== null && imageBlocks[openImageIndex] && (
            <MessageImageViewer
              src={imageSource(imageBlocks[openImageIndex])}
              index={openImageIndex}
              onClose={() => setOpenImageIndex(null)}
            />
          )}
          {content && (
            <>
              <MarkdownBody className="markdown-user-message" cwd={cwd} onOpenFile={onOpenFile}>{displayedContent}</MarkdownBody>
              {contentPreview.collapsible && (
                <button
                  type="button"
                  className="message-user-expand"
                  aria-expanded={contentExpanded}
                  aria-label={t(contentExpanded ? "chat.collapseLongMessage" : "chat.expandLongMessage", { count: contentLineCount })}
                  onClick={toggleContent}
                  disabled={contentLoading}
                >
                  <DisclosureChevron />
                  {contentLoading
                    ? t("chat.loadingLongMessage")
                    : t(contentExpanded ? "chat.collapseLongMessage" : "chat.expandLongMessage", { count: contentLineCount })}
                </button>
              )}
              {contentLoadError && <div role="alert" style={{ marginTop: 6, color: "var(--status-failed)", fontSize: "var(--text-xs)" }}>{contentLoadError}</div>}
            </>
          )}
        </div>

      </div>

      {sendError && (
        <div role="alert" style={{ marginTop: -10, marginBottom: 10, color: "var(--status-failed, #dc2626)", fontSize: "var(--text-xs)", maxWidth: "85%" }}>
          {t(message.sendUnconfirmed ? "chat.sendUnconfirmed" : "chat.sendFailed")}：{sendError}
        </div>
      )}

      {/* Bottom row: action buttons + timestamp */}
      {retryError ? <div role="alert" style={{ color: "var(--status-failed)", fontSize: "var(--text-xs)" }}>{retryError}</div> : null}
      {!historyMode && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "flex-end",
          gap: 6, marginTop: 3,
        }}>
          {onRetry ? <button type="button" title={t("chat.retryMessageTitle")} disabled={retryDisabled || retrying}
            onClick={() => { if (retrying || retryDisabled) return; setRetrying(true); setRetryError(null); void onRetry(message, entryId).catch((reason) => setRetryError(reason instanceof Error ? reason.message : String(reason))).finally(() => setRetrying(false)); }}
            style={{
              display: "flex", alignItems: "center", gap: 4, padding: "3px 8px", height: 22,
              background: "none", border: "none", borderRadius: "var(--radius-control)",
              color: "var(--text-dim)", cursor: retryDisabled || retrying ? "not-allowed" : "pointer",
              opacity: hovered ? (retryDisabled ? 0.45 : 1) : 0,
              pointerEvents: hovered ? "auto" : "none",
              transition: "opacity 0.12s", fontSize: "var(--text-xs)",
            }}>
            <AliIcon name="reload" size={11} />{t(retrying ? "chat.retryMessageSending" : "chat.retryMessage")}
          </button> : null}
          <div style={{
            display: "flex", gap: 3,
            opacity: hovered ? 1 : 0,
            pointerEvents: hovered ? "auto" : "none",
            transition: "opacity 0.12s",
          }}>
            <button
              onClick={copyContent}
               title={t("i18n.copyMessage")}
              style={{
                display: "flex", alignItems: "center", gap: 4,
                padding: "3px 8px", height: 22,
                background: "none", border: "none",
                borderRadius: "var(--radius-control)",
                color: copied ? "var(--accent)" : "var(--text-dim)",
                cursor: "pointer",
                fontSize: "var(--text-xs)", fontWeight: 400,
                whiteSpace: "nowrap",
                transition: "color 0.12s",
              }}
              onMouseEnter={(e) => { if (!copied) e.currentTarget.style.color = "var(--accent)"; }}
              onMouseLeave={(e) => { if (!copied) e.currentTarget.style.color = "var(--text-dim)"; }}
            >
              {copied ? (
                <AliIcon name="check" size={11} />
              ) : (
                <AliIcon name="copy" size={11} />
              )}
               {copied ? t("i18n.copied") : t("i18n.copy")}
            </button>
            {messageActions}
          </div>
          {(canFork || canNavigate) && (
            <div style={{
              display: "flex", gap: 3,
              opacity: (hovered || forking) ? 1 : 0,
              pointerEvents: (hovered || forking) ? "auto" : "none",
              transition: "opacity 0.12s",
            }}>
              {canNavigate && (
                <button
                  onClick={() => {
                    void loadFullContent().then((fullContent) => {
                      onNavigate!(prevAssistantEntryId!);
                      onEditContent?.(fullContent);
                    }).catch(() => {});
                  }}
                   title={t("i18n.editFromHereTitle")}
                  style={{
                    display: "flex", alignItems: "center", gap: 4,
                    padding: "3px 8px", height: 22,
                    background: "none", border: "none",
                    borderRadius: "var(--radius-control)",
                    color: "var(--text-dim)",
                    cursor: "pointer",
                    fontSize: "var(--text-xs)", fontWeight: 400,
                    whiteSpace: "nowrap",
                    transition: "color 0.12s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }}
                >
                  <AliIcon name="history" size={11} />
                   {t("i18n.editFromHere")}
                </button>
              )}
              {canFork && (
                <button
                  onClick={() => { onFork!(entryId!); }}
                  disabled={forking}
                   title={forking ? t("i18n.creatingSession") : t("i18n.newSessionTitle")}
                  style={{
                    display: "flex", alignItems: "center", gap: 4,
                    padding: "3px 8px", height: 22,
                    background: "none", border: "none",
                    borderRadius: "var(--radius-control)",
                    color: forking ? "var(--accent)" : "var(--text-dim)",
                    cursor: forking ? "not-allowed" : "pointer",
                    fontSize: "var(--text-xs)", fontWeight: 400,
                    whiteSpace: "nowrap",
                    transition: "color 0.12s",
                  }}
                  onMouseEnter={(e) => { if (!forking) e.currentTarget.style.color = "var(--accent)"; }}
                  onMouseLeave={(e) => { if (!forking) e.currentTarget.style.color = "var(--text-dim)"; }}
                >
                  <AliIcon name="fork" size={11} />
                   {forking ? t("i18n.creating") : t("i18n.newSession")}
                </button>
              )}
            </div>
          )}
          {time && <span style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)" }}>{time}</span>}
        </div>
      )}
    </div>
  );
}

function AssistantMessageView({
  messageActions,
  message,
  isStreaming,
  toolResults,
  modelNames,
  cwd,
  onOpenFile,
  showTimestamp,
  prevTimestamp,
  responseStartedAt,
  sessionId,
  entryId,
  onOpenAutomation,
  onOpenCommandExecution,
}: {
  messageActions?: ReactNode;
  message: AssistantMessage;
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  modelNames?: Record<string, string>;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  showTimestamp?: boolean;
  prevTimestamp?: number;
  responseStartedAt?: number;
  sessionId?: string;
  entryId?: string;
  onOpenAutomation?: (automationId: string) => void;
  onOpenCommandExecution?: (data: CommandExecutionData) => void;
}) {
  const { t } = useI18n();
  const time = showTimestamp ? formatTime(message.timestamp) : null;
  const historyMode = useContext(HistoryModeContext);
  const responseDuration = showTimestamp ? formatResponseDuration(responseStartedAt, message.timestamp) : null;
  const blockItems = (Array.isArray(message.content) ? message.content : [])
    .map((block, originalIndex) => ({ block, originalIndex }))
    .filter(({ block }) => !isEmptyThinkingBlock(block, { isStreaming }));
  const blocks = blockItems.map(({ block }) => block);
  const providerError = getAssistantErrorMessage(message, { isStreaming });
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const streamStartRef = useRef<number | null>(null);
  const [tps, setTps] = useState<number | null>(null);
  const blockItemsRef = useRef(blockItems);
  blockItemsRef.current = blockItems;

  // Streaming-based timing for thinking blocks
  const blockStartTimesRef = useRef<Map<number, number>>(new Map());
  const [streamingDurations, setStreamingDurations] = useState<Map<number, number>>(new Map());

  // Thinking duration derived from file timestamps: time from prev message end to this message end
  // This is the total generation time (thinking + any text before first tool call)
  const thinkingDurationFromFile = useMemo<number | undefined>(() => {
    if (!message.timestamp || !prevTimestamp) return undefined;
    const secs = Math.round((message.timestamp - prevTimestamp) / 1000);
    return secs > 0 ? secs : undefined;
  }, [message.timestamp, prevTimestamp]);

  // Tool call durations derived from session file timestamps (accurate for completed messages)
  // assistant message timestamp = when generation ended = when tools started running
  // toolResult timestamp = when tool execution finished
  const toolCallDurations = useMemo<Map<string, number>>(() => {
    const map = new Map<string, number>();
    if (!toolResults || !message.timestamp) return map;
    for (const [callId, result] of toolResults) {
      if (result.timestamp && message.timestamp) {
        const secs = Math.round((result.timestamp - message.timestamp) / 1000);
        if (secs > 0) map.set(callId, secs);
      }
    }
    return map;
  }, [toolResults, message.timestamp]);

  const textContent = blocks
    .filter((b): b is TextContent => b?.type === "text")
    .map((b) => (typeof b.text === "string" ? b.text : ""))
    .join("\n");

  const copyContent = () => {
    copyText(textContent).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  useEffect(() => {
    if (!isStreaming) {
      // Finalise any un-finished thinking block durations on stream end
      const now = new Date().getTime();
      setStreamingDurations((prev: Map<number, number>) => {
        const next = new Map(prev);
        for (const [idx, start] of blockStartTimesRef.current) {
          if (!next.has(idx)) next.set(idx, Math.round((now - start) / 1000));
        }
        return next;
      });
      streamStartRef.current = null;
      setTps(null);
      return;
    }
    const tick = () => {
      const items = blockItemsRef.current;
      const bs = items.map(({ block }) => block);
      const now = Date.now();

      // Record start time for each block the first time we see it
      items.forEach(({ originalIndex }) => {
        if (!blockStartTimesRef.current.has(originalIndex)) blockStartTimesRef.current.set(originalIndex, now);
      });

      // When a non-last block has a successor already started, finalise its duration
      setStreamingDurations((prev: Map<number, number>) => {
        let changed = false;
        const next = new Map(prev);
        for (let i = 0; i < items.length - 1; i++) {
          const originalIndex = items[i].originalIndex;
          const nextOriginalIndex = items[i + 1].originalIndex;
          if (!next.has(originalIndex) && blockStartTimesRef.current.has(originalIndex)) {
            const start = blockStartTimesRef.current.get(originalIndex)!;
            const nextStart = blockStartTimesRef.current.get(nextOriginalIndex) ?? now;
            next.set(originalIndex, Math.round((nextStart - start) / 1000));
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      let chars = 0;
      for (const b of bs) {
        if (b.type === "text") chars += (b as TextContent).text?.length ?? 0;
        else if (b.type === "thinking") chars += (b as ThinkingContent).thinking?.length ?? 0;
        else if (b.type === "toolCall") chars += JSON.stringify((b as ToolCallContent).input ?? {}).length;
      }
      if (chars === 0) return;
      if (streamStartRef.current === null) streamStartRef.current = now;
      const elapsed = (now - streamStartRef.current) / 1000;
      if (elapsed > 0.5) setTps(chars / 4 / elapsed);
    };
    const id = setInterval(tick, 300);
    return () => clearInterval(id);
  }, [isStreaming]);

  if (blocks.length === 0 && !isStreaming && !providerError) return null;

  return (
    <div
      className="message-row message-row-assistant"
      data-streaming={isStreaming ? "true" : "false"}
      style={{ marginBottom: 16 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Model label */}
      <div
        className="message-model-label"
        style={{
          fontSize: "var(--text-xs)",
          color: "var(--text-dim)",
          marginBottom: 4,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        {message.provider && (
          <span>{modelNames?.[`${message.provider}:${message.model}`] ?? modelNames?.[message.model] ?? message.model}</span>
        )}
        {isStreaming && (() => {
          let chars = 0;
          for (const b of blocks) {
            if (b.type === "text") chars += (b as TextContent).text?.length ?? 0;
            else if (b.type === "thinking") chars += (b as ThinkingContent).thinking?.length ?? 0;
            else if (b.type === "toolCall") chars += JSON.stringify((b as ToolCallContent).input ?? {}).length;
          }
          const est = Math.round(chars / 4);
          return (
            <>

              {est > 0 && (
                <span style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text)" }} title={t("i18n.estimatedTokens")}>
                  <span style={{ display: "flex", alignItems: "center", gap: 2, fontSize: "var(--text-xs)", fontWeight: 400 }}>
                    <AliIcon name="arrowdown" size={10} />
                    {est}
                  </span>
                  {tps !== null && (() => {
                    const bg = tps >= 50 ? "#53b3cb" : tps >= 30 ? "#9bc53d" : tps >= 15 ? "#f9c22e" : "#e01a4f";
                    return (
                      <span style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 4, background: bg, color: "#fff", fontSize: "var(--text-xs)", fontWeight: 400 }}>
                        {tps.toFixed(1)} t/s
                      </span>
                    );
                  })()}
                </span>
              )}
            </>
          );
        })()}
      </div>

      <div className="message-assistant-blocks">
        {blockItems.map(({ block, originalIndex }) => (
          <BlockView key={`${entryId ?? "stream"}-${originalIndex}`} block={block} toolResults={toolResults} isStreaming={isStreaming} streamingDuration={streamingDurations.get(originalIndex) ?? (block.type === "thinking" ? thinkingDurationFromFile : undefined)} toolCallDurations={toolCallDurations} cwd={cwd} onOpenFile={onOpenFile} sessionId={sessionId} entryId={entryId} blockIndex={originalIndex} onOpenAutomation={onOpenAutomation} onOpenCommandExecution={onOpenCommandExecution} />
        ))}
      </div>

      {providerError && (
        <div
          role="alert"
          style={{
            marginTop: blocks.length > 0 ? 8 : 0,
            padding: "7px 10px",
            border: "1px solid rgba(239,68,68,0.3)",
            borderRadius: "var(--radius-control)",
            background: "rgba(239,68,68,0.07)",
            color: "#ef4444",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-sm)",
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          Error: {providerError}
        </div>
      )}

      <div className="message-response-meta" style={{
        display: "flex", alignItems: "center", gap: 8, marginTop: 4,
      }}>
        {message.usage && !isStreaming && (
          <div style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)" }}>
            {formatUsage(message.usage)}
          </div>
        )}
        {responseDuration && !isStreaming && (
          <span style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>
            {t("i18n.responseTime", { duration: responseDuration })}
          </span>
        )}
        {textContent && !isStreaming && !historyMode && (
          <button
            onClick={copyContent}
             title={t("i18n.copyMessage")}
            style={{
              display: "flex", alignItems: "center", gap: 4,
              padding: "3px 8px", height: 22,
              background: "none", border: "none",
              borderRadius: "var(--radius-control)",
              color: copied ? "var(--accent)" : "var(--text-dim)",
              cursor: "pointer",
              fontSize: "var(--text-xs)", fontWeight: 400,
              whiteSpace: "nowrap",
              opacity: hovered ? 1 : 0,
              pointerEvents: hovered ? "auto" : "none",
              transition: "opacity 0.12s, color 0.12s",
            }}
            onMouseEnter={(e) => { if (!copied) e.currentTarget.style.color = "var(--accent)"; }}
            onMouseLeave={(e) => { if (!copied) e.currentTarget.style.color = "var(--text-dim)"; }}
          >
            {copied ? (
              <AliIcon name="check" size={11} />
            ) : (
              <AliIcon name="copy" size={11} />
            )}
             {copied ? t("i18n.copied") : t("i18n.copy")}
          </button>
        )}
        {!isStreaming ? <span className="message-hover-actions">{messageActions}</span> : null}
        {time && !isStreaming && (
          <span style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", marginLeft: "auto" }}>{time}</span>
        )}
      </div>
    </div>
  );
}

function BlockView({ block, toolResults, isStreaming, streamingDuration, toolCallDurations, cwd, onOpenFile, sessionId, entryId, blockIndex, onOpenAutomation, onOpenCommandExecution }: { block: AssistantContentBlock; toolResults?: Map<string, ToolResultMessage>; isStreaming?: boolean; streamingDuration?: number; toolCallDurations?: Map<string, number>; cwd?: string; onOpenFile?: (filePath: string) => void; sessionId?: string; entryId?: string; blockIndex: number; onOpenAutomation?: (automationId: string) => void; onOpenCommandExecution?: (data: CommandExecutionData) => void }) {
  if (block.type === "text") {
    return <TextBlock block={block as TextContent} isStreaming={isStreaming} cwd={cwd} onOpenFile={onOpenFile} />;
  }
  if (block.type === "thinking") {
    const thinkingBlock = block as ThinkingContent;
    return <ThinkingBlock block={thinkingBlock} duration={streamingDuration} isStreaming={isStreaming} cwd={cwd} onOpenFile={onOpenFile} sessionId={sessionId} entryId={entryId} blockIndex={thinkingBlock.deferredBlockIndex ?? blockIndex} />;
  }
  if (block.type === "toolCall") {
    const tc = block as ToolCallContent;
    const result = toolResults?.get(tc.toolCallId);
    const duration = toolCallDurations?.get(tc.toolCallId);
    return <ToolCallBlock block={tc} result={result} duration={duration} cwd={cwd} sessionId={sessionId} onOpenFile={onOpenFile} onOpenAutomation={onOpenAutomation} onOpenCommandExecution={onOpenCommandExecution} />;
  }
  return null;
}

function TextBlock({ block, isStreaming, cwd, onOpenFile }: { block: TextContent; isStreaming?: boolean; cwd?: string; onOpenFile?: (filePath: string) => void }) {
  return <MarkdownBody className="markdown-assistant-message" isStreaming={isStreaming} cwd={cwd} onOpenFile={onOpenFile}>{block.text}</MarkdownBody>;
}

function ThinkingBlock({ block, duration, isStreaming, cwd, onOpenFile, sessionId, entryId, blockIndex }: {
  block: ThinkingContent;
  duration?: number;
  isStreaming?: boolean;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  sessionId?: string;
  entryId?: string;
  blockIndex: number;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useVirtualRowToggle(`thinking:${blockIndex}`);
  const historyVersion = useContext(HistoryVersionContext);
  const [loadState, setLoadState] = useState<ThinkingLoadState | null>(null);
  const sourceKey = sessionId && entryId ? `${sessionId}:${entryId}:${blockIndex}:${historyVersion ?? "chat"}` : null;
  const loadStateRef = useRef(loadState);
  const currentSourceKeyRef = useRef(sourceKey);
  loadStateRef.current = loadState;
  currentSourceKeyRef.current = sourceKey;

  useEffect(() => {
    if (!expanded || !block.deferred || !sourceKey || !sessionId || !entryId) return;
    const existing = loadStateRef.current;
    if (!shouldSubscribeToThinkingLoad(sourceKey, existing)) return;

    return subscribeToThinkingLoad(
      sourceKey,
      loadThinkingContent(sessionId, entryId, blockIndex, historyVersion),
      () => currentSourceKeyRef.current === sourceKey,
      setLoadState,
    );
  }, [block.deferred, blockIndex, entryId, expanded, sessionId, sourceKey, historyVersion]);

  const display = block.deferred && !sourceKey
    ? { status: "error" as const, error: t("i18n.thinkingUnavailable") }
    : getThinkingBlockDisplay(block, sourceKey, loadState);

  return (
    <ChatDisclosure className="thinking-block" triggerClassName="thinking-block-trigger"
      expanded={expanded} onExpandedChange={setExpanded} icon="brain" label={t("i18n.thinking")}
      metadata={duration !== undefined ? `${duration}s` : undefined}>
      <div className={`thinking-block-content${display.status === "error" ? " is-error" : ""}`}>
        {display.status === "loading"
          ? <span className="thinking-block-status">{t("i18n.loadingThinking")}</span>
          : display.status === "error"
            ? <span className="thinking-block-status">{display.error}</span>
            : display.status === "content"
              ? <MarkdownBody className="markdown-thinking" isStreaming={isStreaming} cwd={cwd} onOpenFile={onOpenFile}>{display.content}</MarkdownBody>
              : null}
      </div>
    </ChatDisclosure>
  );
}


function ToolCallBlock({ block, result, duration, cwd, sessionId, onOpenFile, onOpenAutomation, onOpenCommandExecution }: { block: ToolCallContent; result?: ToolResultMessage; duration?: number; cwd?: string; sessionId?: string; onOpenFile?: (filePath: string) => void; onOpenAutomation?: (automationId: string) => void; onOpenCommandExecution?: (data: CommandExecutionData) => void }) {
  const { t } = useI18n();
  const historyMode = useContext(HistoryModeContext);
  const [expanded, setExpanded] = useVirtualRowToggle(`tool:${block.toolCallId}`);
  const [diagnosticsOpen, setDiagnosticsOpen] = useVirtualRowToggle(`diagnostics:${block.toolCallId}`);
  const diagnostics = safeJson({ input: block.input, result: result ?? null });
  const fileChange = getFileChangeInfo(block, result);
  const resultDiff = result && !result.isError ? getResultDiff(result) : null;
  const summary = summarizeToolDisclosure(block.toolName, block.input, result?.isStreaming ? undefined : result, t);
  const automationDetails = getAutomationToolCardDetails(block, result);

  if (isCommandToolName(block.toolName)) {
    const output = toolResultText(result);
    const metadata = commandResultMetadata(result);
    const data: CommandExecutionData = {
      id: block.toolCallId,
      toolName: block.toolName,
      command: typeof block.input.command === "string" ? block.input.command : "",
      output,
      status: commandStatus(result, output),
      isStreaming: !historyMode && (!result || result.isStreaming === true),
      historical: historyMode,
      duration,
      cwd,
      exitCode: commandExitCode(result, output),
      truncated: metadata.truncated,
      fullOutputPath: metadata.fullOutputPath,
      sessionId,
      diagnostics,
    };
    return <CommandExecutionCard data={data} onOpen={onOpenCommandExecution} />;
  }

  if (automationDetails && !historyMode) {
    return (
      <AutomationCard
        automationId={automationDetails.id}
        fallbackName={automationDetails.name}
        fallbackRrule={automationDetails.rrule}
        onOpen={onOpenAutomation}
      />
    );
  }

  // Result display
  const resultText = result && Array.isArray(result.content)
    ? result.content
      .filter((b): b is { type: "text"; text: string } => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n")
    : null;
  const resultIsEmpty = resultText === null ? false : (resultText.trim() === "(no output)" || resultText.trim() === "");
  const isError = result?.isError ?? false;

  if (fileChange) {
    return (
      <FileChangeBlock
        change={fileChange}
        resultText={resultText ?? ""}
        duration={duration}
        expanded={expanded}
        diagnosticsOpen={diagnosticsOpen}
        diagnostics={diagnostics}
        onOpenFile={onOpenFile}
        onExpandedChange={setExpanded}
        onDiagnosticsOpenChange={setDiagnosticsOpen}
      />
    );
  }

  return (
    <ChatDisclosure className="tool-call-card" triggerClassName="tool-call-toggle"
      expanded={expanded} onExpandedChange={setExpanded} icon={summary.icon as AliIconName} label={summary.title}
      description={summary.subject ? <>
        {summary.subjectIsPath ? <DisclosurePath path={summary.subject} /> : <span title={summary.subject}>{summary.subject}</span>}
        {summary.detail ? <span className="tool-call-detail" title={summary.detail}>{summary.detail}</span> : null}
      </> : summary.detail ? <span title={summary.detail}>{summary.detail}</span> : undefined}
      metadata={<>
        <span className={`chat-disclosure-status is-${historyMode && !result ? "unknown" : summary.status}`}>{t(historyMode && !result ? "history.noSavedResult" : summary.status === "running" ? "command.status.running" : summary.status === "error" ? "command.status.failed" : "command.status.success")}</span>
        {duration !== undefined ? <span>{duration}s</span> : null}
      </>}>
      {result ? resultDiff
        ? <PairedDiffResult diff={resultDiff} />
        : <PairedResult text={resultText ?? ""} isEmpty={resultIsEmpty} isError={isError} />
        : <div className="chat-disclosure-notice">{t(historyMode ? "history.noSavedResult" : "command.waitingForOutput")}</div>}
      <ChatDisclosure variant="inline" expanded={diagnosticsOpen} onExpandedChange={setDiagnosticsOpen}
        label={t("toolSummary.diagnostics")}>
        <pre className="chat-disclosure-diagnostics">{diagnostics}</pre>
      </ChatDisclosure>
    </ChatDisclosure>
  );
}

function FileChangeBlock({
  change,
  resultText,
  duration,
  expanded,
  diagnosticsOpen,
  diagnostics,
  onOpenFile,
  onExpandedChange,
  onDiagnosticsOpenChange,
}: {
  change: FileChangeInfo;
  resultText: string;
  duration?: number;
  expanded: boolean;
  diagnosticsOpen: boolean;
  diagnostics: string;
  onOpenFile?: (filePath: string) => void;
  onExpandedChange: (value: boolean) => void;
  onDiagnosticsOpenChange: (value: boolean) => void;
}) {
  const { t } = useI18n();
  const titleKey = change.status === "running"
    ? "fileChange.running"
    : change.status === "failed"
      ? "fileChange.failed"
      : change.kind === "created"
        ? "fileChange.created"
        : change.kind === "unchanged"
          ? "fileChange.unchanged"
          : "fileChange.edited";
  const icon: AliIconName = change.kind === "created" ? "file-add" : "edit";
  const statusClass = change.status === "failed" ? "is-failed" : change.status === "running" ? "is-running" : "is-complete";
  const noDiffMessage = change.unavailableReason === "too_large"
    ? t("fileChange.tooLarge")
    : change.unavailableReason === "binary"
      ? t("fileChange.binary")
      : change.kind === "unchanged"
        ? t("fileChange.noChanges")
        : t("fileChange.unavailable");

  return (
    <ChatDisclosure className={`file-change-card ${statusClass}`} data-file-change-path={change.path}
      expanded={expanded} onExpandedChange={onExpandedChange} icon={icon} label={t(titleKey)}
      triggerClassName="file-change-toggle tool-call-toggle" description={<DisclosurePath path={change.path} />}
      metadata={<>
        {change.status !== "completed" ? <span className={`chat-disclosure-status is-${change.status}`}>
          {t(change.status === "running" ? "command.status.running" : "command.status.failed")}
        </span> : null}
        {change.status === "completed" && (change.added > 0 || change.removed > 0) ? (
          <span className="file-change-stats" aria-label={t("fileChange.stats", { added: change.added, removed: change.removed })}>
            <span className="file-change-additions">+{change.added}</span>
            <span className="file-change-deletions">−{change.removed}</span>
          </span>
        ) : null}
        {duration !== undefined ? <span>{duration}s</span> : null}
      </>}
      actions={onOpenFile ? <button type="button" className="chat-disclosure-action" title={t("diff.openFile")}
        aria-label={t("diff.openFile")} onClick={() => onOpenFile(change.path)}><AliIcon name="external-link" size={14} /></button> : null}>
      {change.patch ? (
        <DiffView className="file-change-diff" patch={change.patch} filePath={change.path} mode="unified" showFileHeader={false} />
      ) : change.status === "failed" ? (
        <PairedResult text={resultText} isEmpty={!resultText.trim()} isError />
      ) : (
        <div className="chat-disclosure-notice">{noDiffMessage}</div>
      )}
      <ChatDisclosure variant="inline" expanded={diagnosticsOpen} onExpandedChange={onDiagnosticsOpenChange}
        label={t("toolSummary.diagnostics")}>
        <pre className="chat-disclosure-diagnostics">{diagnostics}</pre>
      </ChatDisclosure>
    </ChatDisclosure>
  );
}

interface ResultDiff {
  text: string;
}

function PairedDiffResult({ diff }: { diff: ResultDiff }) {
  return <div className="tool-result-diff"><DiffView patch={diff.text} mode="split" /></div>;
}

function getResultDiff(result: ToolResultMessage): ResultDiff | null {
  const details = (result as ToolResultMessage & { details?: unknown }).details;
  if (!isRecord(details)) return null;

  const patch = typeof details.patch === "string" ? details.patch : null;
  if (patch) return { text: patch };

  const diff = typeof details.diff === "string" ? details.diff : null;
  if (diff) return { text: diff };

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function PairedResult({ text, isEmpty, isError }: {
  text: string;
  isEmpty: boolean;
  isError: boolean;
}) {
  const { t } = useI18n();
  return <pre className={`tool-result-output${isError ? " is-error" : ""}${isEmpty ? " is-empty" : ""}`}>
    {isEmpty ? t("i18n.noOutput") : text}
  </pre>;
}

function CompactionMessageView({ message }: { message: CustomMessage }) {
  const { t } = useI18n();
  const summary = getMessageText(message.content);
  const parsedSummary = useMemo(() => parseCompactionSummary(summary), [summary]);
  const time = formatTime(message.timestamp);

  return (
    <div className="chat-disclosure is-expanded compaction-message-card">
      <div className="chat-disclosure-heading">
        <AliIcon name="archive" size={14} aria-hidden="true" />
        <span className="chat-disclosure-label">{t("i18n.conversationCompacted")}</span>
        {time ? <span className="chat-disclosure-meta">{time}</span> : null}
      </div>
      <div className="chat-disclosure-content">
        <p className="compaction-description">{t("i18n.compactionDescription")}</p>
        {parsedSummary.body ? <MarkdownBody className="markdown-compaction-message">{parsedSummary.body}</MarkdownBody>
          : <span className="chat-disclosure-notice">{t("i18n.noSummary")}</span>}
        <CompactionFileMetadata readFiles={parsedSummary.readFiles} modifiedFiles={parsedSummary.modifiedFiles} />
      </div>
    </div>
  );
}

function CompactionFileMetadata({ readFiles, modifiedFiles }: { readFiles: string[]; modifiedFiles: string[] }) {
  const { t } = useI18n();
  const total = readFiles.length + modifiedFiles.length;
  if (total === 0) return null;

  const parts = [];
  if (readFiles.length > 0) parts.push(`${readFiles.length} read`);
  if (modifiedFiles.length > 0) parts.push(`${modifiedFiles.length} modified`);

  return (
    <details className="compaction-file-details">
       <summary><DisclosureChevron />{t("i18n.fileContext", { details: parts.join(", ") })}</summary>
       {modifiedFiles.length > 0 && <CompactionFileList title={t("i18n.modifiedFiles")} files={modifiedFiles} />}
       {readFiles.length > 0 && <CompactionFileList title={t("i18n.readFiles")} files={readFiles} />}
    </details>
  );
}

function CompactionFileList({ title, files }: { title: string; files: string[] }) {
  return (
    <div className="compaction-file-section">
      <div className="compaction-file-title">{title}</div>
      <ul className="compaction-file-list">
        {files.map((file) => (
          <li key={file}>{file}</li>
        ))}
      </ul>
    </div>
  );
}

function CustomMessageView({ messageActions, message, cwd, onOpenFile }: { messageActions?: ReactNode; message: CustomMessage; cwd?: string; onOpenFile?: (filePath: string) => void }) {
  const { t } = useI18n();
  const isHiddenDisplay = message.display === false;
  const [contentExpanded, setContentExpanded] = useState(!isHiddenDisplay);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [openImageIndex, setOpenImageIndex] = useState<number | null>(null);
  const text = getMessageText(message.content);
  const images = getMessageImages(message.content);
  const hasDetails = message.details !== undefined;
  const detailsText = hasDetails ? safeJson(message.details) : "";
  const title = formatCustomType(message.customType);
  const time = formatTime(message.timestamp);

  const copyContent = () => {
    copyText(text || detailsText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const actions = <>
    {text || detailsText ? <button type="button" className="chat-disclosure-action" onClick={copyContent}
      title={t(copied ? "i18n.copied" : "i18n.copy")} aria-label={t(copied ? "i18n.copied" : "i18n.copy")}>
      <AliIcon name={copied ? "check" : "copy"} size={14} />
    </button> : null}
    <span className="message-hover-actions">{messageActions}</span>
  </>;
  const body = <>
    {images.length > 0 ? <div className="custom-message-images">
      {images.map((img, i) => {
        const src = imageSource(img);
        return src ? <MessageImage key={i} src={src} index={i} onOpen={() => setOpenImageIndex(i)} /> : null;
      })}
    </div> : null}
    {text ? <MarkdownBody className="markdown-custom-message" cwd={cwd} onOpenFile={onOpenFile}>{text}</MarkdownBody>
      : <span className="chat-disclosure-notice">{t("i18n.noMessage")}</span>}
  </>;
  const details = <pre className="chat-disclosure-diagnostics custom-message-details">{detailsText}</pre>;

  return (
    <div className="message-row custom-message-row">
      {isHiddenDisplay ? (
        <ChatDisclosure className="custom-message-card" expanded={contentExpanded} onExpandedChange={setContentExpanded}
          icon="message" label={title} description={text ? previewText(text) : t("i18n.showExtensionMessage")}
          metadata={<><span>{t("i18n.hiddenExtensionMessage")}</span>{time ? <span>{time}</span> : null}</>} actions={actions}>
          {body}
          {hasDetails ? details : null}
        </ChatDisclosure>
      ) : (
        <div className="chat-disclosure is-expanded custom-message-card">
          <div className="chat-disclosure-header">
            <div className="chat-disclosure-heading">
              <AliIcon name="message" size={14} aria-hidden="true" />
              <span className="chat-disclosure-label">{title}</span>
              {time ? <span className="chat-disclosure-meta">{time}</span> : null}
            </div>
            <div className="chat-disclosure-actions">{actions}</div>
          </div>
          <div className="chat-disclosure-content">
            {body}
            {hasDetails ? <ChatDisclosure variant="inline" expanded={detailsExpanded} onExpandedChange={setDetailsExpanded}
              label={t(detailsExpanded ? "i18n.hideDetails" : "i18n.showDetails")}>{details}</ChatDisclosure> : null}
          </div>
        </div>
      )}
      {openImageIndex !== null && images[openImageIndex] ? (
        <MessageImageViewer src={imageSource(images[openImageIndex])} index={openImageIndex} onClose={() => setOpenImageIndex(null)} />
      ) : null}
    </div>
  );
}

function getMessageText(content: CustomMessage["content"] | UserMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is TextContent => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

function getMessageImages(content: CustomMessage["content"] | UserMessage["content"]): ImageContent[] {
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is ImageContent => b?.type === "image");
}

function imageSource(img: ImageContent): string {
  return messageImageUrl(img);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatCustomType(type: string): string {
  return typeof type === "string" && type ? type : "extension";
}

function previewText(text: string): string {
  if (typeof text !== "string") return "Show extension message";
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "Show extension message";
  return normalized.length > 140 ? `${normalized.slice(0, 140)}...` : normalized;
}


function formatUsage(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}): string {
  const parts = [];
  if (usage.input) parts.push(`${usage.input.toLocaleString()} in`);
  if (usage.output) parts.push(`${usage.output.toLocaleString()} out`);
  if (usage.cacheRead) parts.push(`${usage.cacheRead.toLocaleString()} cache R`);
  if (usage.cacheWrite) parts.push(`${usage.cacheWrite.toLocaleString()} cache W`);
  if (usage.cost?.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
  return parts.join(" · ");
}

function BashExecutionView({ messageActions, message, sessionId, cwd, onOpenCommandExecution }: { messageActions?: ReactNode; message: BashExecutionMessage; sessionId?: string; cwd?: string; onOpenCommandExecution?: (data: CommandExecutionData) => void }) {
  const historyMode = useContext(HistoryModeContext);
  const isPending = !message.output && message.exitCode === undefined && !message.cancelled;
  const toolName = message.excludeFromContext ? "bash (local)" : "bash";
  const data: CommandExecutionData = {
    id: `bash-${message.timestamp ?? message.command}`,
    toolName,
    command: message.command,
    output: message.output,
    status: isPending || message.exitCode === undefined && !message.cancelled ? "running" : message.cancelled ? "cancelled" : message.exitCode === 0 ? "success" : "failed",
    isStreaming: !historyMode && message.exitCode === undefined && !message.cancelled,
    historical: historyMode,
    cwd,
    exitCode: message.exitCode,
    truncated: message.truncated === true,
    fullOutputPath: message.fullOutputPath,
    sessionId,
    diagnostics: safeJson({
      command: message.command,
      exitCode: message.exitCode,
      cancelled: message.cancelled,
      truncated: message.truncated,
      fullOutputPath: message.fullOutputPath,
    }),
  };
  return <div style={{ margin: "6px 0" }}><CommandExecutionCard data={data} onOpen={onOpenCommandExecution} actions={messageActions} /></div>;
}
