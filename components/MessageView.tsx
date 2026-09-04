"use client";

import { memo, useState, useRef, useEffect, useMemo } from "react";
import dynamic from "next/dynamic";
import { LazyMarkdownBody as MarkdownBody } from "./LazyMarkdownBody";
import { copyText } from "@/lib/clipboard";
import { useI18n } from "@/hooks/useI18n";
import { parseCompactionSummary } from "@/lib/compaction-summary";
import { summarizeToolCall } from "@/lib/tool-summary";
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

function loadThinkingContent(sessionId: string, entryId: string, blockIndex: number): Promise<string> {
  const key = `${sessionId}:${entryId}:${blockIndex}`;
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
        `/api/sessions/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(entryId)}/thinking?blockIndex=${blockIndex}`,
        { signal: controller.signal },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
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
  showTimestamp?: boolean;
  prevTimestamp?: number;
  responseStartedAt?: number;
  sessionId?: string;
  onOpenAutomation?: (automationId: string) => void;
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
    if (block.type === "toolCall" && previous?.get(block.toolCallId) !== next?.get(block.toolCallId)) {
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

export const MessageView = memo(function MessageView({ message, isStreaming, toolResults, modelNames, cwd, onOpenFile, entryId, onFork, forking, onNavigate, prevAssistantEntryId, onEditContent, showTimestamp, prevTimestamp, responseStartedAt, sessionId, onOpenAutomation }: Props) {
  if (message.role === "user") {
    return <UserMessageView message={message as UserMessage} cwd={cwd} onOpenFile={onOpenFile} entryId={entryId} onFork={onFork} forking={forking} onNavigate={onNavigate} prevAssistantEntryId={prevAssistantEntryId} onEditContent={onEditContent} sessionId={sessionId} />;
  }
  if (message.role === "assistant") {
    return <AssistantMessageView message={message as AssistantMessage} isStreaming={isStreaming} toolResults={toolResults} modelNames={modelNames} cwd={cwd} onOpenFile={onOpenFile} showTimestamp={showTimestamp} prevTimestamp={prevTimestamp} responseStartedAt={responseStartedAt} sessionId={sessionId} entryId={entryId} onOpenAutomation={onOpenAutomation} />;
  }
  if (message.role === "toolResult") {
    // Rendered inline under its toolCall — skip standalone rendering if paired
    return null;
  }
  if (message.role === "custom") {
    if ((message as CustomMessage).customType === "compaction") {
      return <CompactionMessageView message={message as CustomMessage} />;
    }
    if ((message as CustomMessage).customType === "piora-automation") {
      const details = (message as CustomMessage).details as { automationId?: unknown; name?: unknown; rrule?: unknown } | undefined;
      return typeof details?.automationId === "string" ? (
        <AutomationCard
          automationId={details.automationId}
          fallbackName={typeof details.name === "string" ? details.name : undefined}
          fallbackRrule={typeof details.rrule === "string" ? details.rrule : undefined}
          onOpen={onOpenAutomation}
        />
      ) : null;
    }
    return <CustomMessageView message={message as CustomMessage} cwd={cwd} onOpenFile={onOpenFile} />;
  }
  if (message.role === "bashExecution") {
    return <BashExecutionView message={message as BashExecutionMessage} sessionId={sessionId} />;
  }
  return null;
}, (prev, next) => {
  return prev.message === next.message
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
    && prev.showTimestamp === next.showTimestamp
    && prev.prevTimestamp === next.prevTimestamp
    && prev.sessionId === next.sessionId
    && prev.onOpenAutomation === next.onOpenAutomation;
});

function UserMessageView({ message, cwd, onOpenFile, entryId, onFork, forking, onNavigate, prevAssistantEntryId, onEditContent, sessionId }: {
  message: UserMessage;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  entryId?: string;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  onNavigate?: (entryId: string) => void;
  prevAssistantEntryId?: string;
  onEditContent?: (content: string) => void;
  sessionId?: string;
}) {
  const { t, locale } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const [contentExpanded, setContentExpanded] = useState(false);
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

  const loadFullContent = async (): Promise<string> => {
    if (!hasDeferredContent) return content;
    if (!sessionId || !entryId) throw new Error(t("chat.longMessageUnavailable"));
    setContentLoading(true);
    setContentLoadError(null);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(entryId)}/prompt-material`);
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
  };

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
            borderRadius: 12,
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
                // lib/types.ts ImageContent uses {source:{type,data,media_type,url}}
                // pi-ai on-disk format uses flat {data, mimeType} — handle both
                const flat = img as unknown as { data?: string; mimeType?: string };
                const src = img.source
                  ? img.source.type === "base64"
                    ? `data:${img.source.media_type};base64,${img.source.data}`
                    : img.source.url ?? ""
                  : flat.data
                    ? `data:${flat.mimeType};base64,${flat.data}`
                    : "";
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
                  <AliIcon
                    name="arrowdown"
                    size={11}
                    style={{ transform: contentExpanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}
                  />
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
          发送失败：{sendError}
        </div>
      )}

      {/* Bottom row: action buttons + timestamp */}
      {(time || canFork || canNavigate || true) && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "flex-end",
          gap: 6, marginTop: 3,
        }}>
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
                borderRadius: 5,
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
                    borderRadius: 5,
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
                    borderRadius: 5,
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
}: {
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
}) {
  const { t } = useI18n();
  const time = showTimestamp ? formatTime(message.timestamp) : null;
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

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {blockItems.map(({ block, originalIndex }) => (
          <BlockView key={`${entryId ?? "stream"}-${originalIndex}`} block={block} toolResults={toolResults} isStreaming={isStreaming} streamingDuration={streamingDurations.get(originalIndex) ?? (block.type === "thinking" ? thinkingDurationFromFile : undefined)} toolCallDurations={toolCallDurations} cwd={cwd} onOpenFile={onOpenFile} sessionId={sessionId} entryId={entryId} blockIndex={originalIndex} onOpenAutomation={onOpenAutomation} />
        ))}
      </div>

      {providerError && (
        <div
          role="alert"
          style={{
            marginTop: blocks.length > 0 ? 8 : 0,
            padding: "7px 10px",
            border: "1px solid rgba(239,68,68,0.3)",
            borderRadius: 6,
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
        {textContent && !isStreaming && (
          <button
            onClick={copyContent}
             title={t("i18n.copyMessage")}
            style={{
              display: "flex", alignItems: "center", gap: 4,
              padding: "3px 8px", height: 22,
              background: "none", border: "none",
              borderRadius: 5,
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
        {time && !isStreaming && (
          <span style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", marginLeft: "auto" }}>{time}</span>
        )}
      </div>
    </div>
  );
}

function BlockView({ block, toolResults, isStreaming, streamingDuration, toolCallDurations, cwd, onOpenFile, sessionId, entryId, blockIndex, onOpenAutomation }: { block: AssistantContentBlock; toolResults?: Map<string, ToolResultMessage>; isStreaming?: boolean; streamingDuration?: number; toolCallDurations?: Map<string, number>; cwd?: string; onOpenFile?: (filePath: string) => void; sessionId?: string; entryId?: string; blockIndex: number; onOpenAutomation?: (automationId: string) => void }) {
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
    return <ToolCallBlock block={tc} result={result} duration={duration} onOpenFile={onOpenFile} onOpenAutomation={onOpenAutomation} />;
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
  const [expanded, setExpanded] = useState(false);
  const [loadState, setLoadState] = useState<ThinkingLoadState | null>(null);
  const sourceKey = sessionId && entryId ? `${sessionId}:${entryId}:${blockIndex}` : null;
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
      loadThinkingContent(sessionId, entryId, blockIndex),
      () => currentSourceKeyRef.current === sourceKey,
      setLoadState,
    );
  }, [block.deferred, blockIndex, entryId, expanded, sessionId, sourceKey]);

  const display = block.deferred && !sourceKey
    ? { status: "error" as const, error: t("i18n.thinkingUnavailable") }
    : getThinkingBlockDisplay(block, sourceKey, loadState);

  return (
    <div className={`thinking-block${expanded ? " is-expanded" : ""}`}>
      <button
        type="button"
        className="thinking-block-trigger"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="thinking-block-chevron" aria-hidden="true">
          <AliIcon name="chevron-right" size={12} strokeWidth={1.8} />
        </span>
        <span className="thinking-block-label">{t("i18n.thinking")}</span>
        {duration !== undefined && (
          <span className="thinking-block-duration">{duration}s</span>
        )}
      </button>
      {expanded && (
        <div className={`thinking-block-content${display.status === "error" ? " is-error" : ""}`}>
          {display.status === "loading"
            ? <span className="thinking-block-status">{t("i18n.loadingThinking")}</span>
            : display.status === "error"
              ? <span className="thinking-block-status">{display.error}</span>
              : display.status === "content"
                ? <MarkdownBody className="markdown-thinking" isStreaming={isStreaming} cwd={cwd} onOpenFile={onOpenFile}>{display.content}</MarkdownBody>
                : null}
        </div>
      )}
    </div>
  );
}


function ToolCallBlock({ block, result, duration, onOpenFile, onOpenAutomation }: { block: ToolCallContent; result?: ToolResultMessage; duration?: number; onOpenFile?: (filePath: string) => void; onOpenAutomation?: (automationId: string) => void }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const diagnostics = safeJson({ input: block.input, result: result ?? null });
  const fileChange = getFileChangeInfo(block, result);
  const resultDiff = result && !result.isError ? getResultDiff(result) : null;
  const summary = summarizeToolCall(block.toolName, block.input, result, t);
  const automationDetails = getAutomationToolCardDetails(block, result);

  if (automationDetails) {
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
    <div
      style={{
        borderRadius: 7,
        overflow: "hidden",
        fontSize: "var(--text-sm)",
        border: isError ? "1px solid rgba(248,113,113,0.45)" : "1px solid rgba(34,197,94,0.25)",
        background: isError ? "rgba(248,113,113,0.05)" : "rgba(34,197,94,0.04)",
      }}
    >
      {/* ── Tool call header ── */}
      <button
        className="tool-call-toggle"
        onClick={(event) => togglePreservingScroll(event.currentTarget, () => setExpanded((value) => !value))}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          width: "100%",
          padding: "6px 10px",
          background: "none",
          border: "none",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: "var(--text-sm)",
          textAlign: "left",
          minWidth: 0,
        }}
      >
        <AliIcon name={summary.icon as AliIconName} size={14} style={{ color: summary.status === "error" ? "var(--status-failed)" : summary.status === "running" ? "var(--status-running)" : "var(--status-completed)", flexShrink: 0 }} />
        <span style={{ color: "var(--text)", fontWeight: 550, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
          {summary.title}
        </span>
        <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
          {summary.detail ?? ""}
        </span>
        {duration !== undefined && (
          <span style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{duration}s</span>
        )}
        <AliIcon name="arrowdown" size={10} style={{ color: "var(--text-dim)", transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
      </button>

      {/* ── Paired result — only shown when expanded ── */}
      {expanded && result && (
        resultDiff ? (
          <PairedDiffResult
            diff={resultDiff}
          />
        ) : (
          <PairedResult
            text={resultText ?? ""}
            isEmpty={resultIsEmpty}
            isError={isError}
          />
        )
      )}
      {expanded && (
        <div style={{ borderTop: "1px solid var(--border)" }}>
          <button
            type="button"
            onClick={(event) => togglePreservingScroll(event.currentTarget, () => setDiagnosticsOpen((value) => !value))}
            aria-expanded={diagnosticsOpen}
            style={{ width: "100%", height: 28, padding: "0 10px", display: "flex", alignItems: "center", gap: 6, border: 0, background: "var(--bg-panel)", color: "var(--text-dim)", cursor: "pointer", fontSize: "var(--text-xs)", textAlign: "left" }}
          >
            <AliIcon name="code" size={12} />
            <span style={{ flex: 1 }}>{t("toolSummary.diagnostics")}</span>
            <AliIcon name="arrowdown" size={9} style={{ transform: diagnosticsOpen ? "rotate(180deg)" : "none" }} />
          </button>
          {diagnosticsOpen && <pre style={{ margin: 0, padding: "8px 10px", maxHeight: 320, overflow: "auto", background: "var(--bg-subtle)", color: "var(--text-muted)", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: "var(--text-xs)" }}>{diagnostics}</pre>}
        </div>
      )}
    </div>
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
  const icon: AliIconName = change.kind === "created" ? "file-add" : change.status === "failed" ? "error" : "edit";
  const statusClass = change.status === "failed" ? "is-failed" : change.status === "running" ? "is-running" : "is-complete";
  const noDiffMessage = change.unavailableReason === "too_large"
    ? t("fileChange.tooLarge")
    : change.unavailableReason === "binary"
      ? t("fileChange.binary")
      : change.kind === "unchanged"
        ? t("fileChange.noChanges")
        : t("fileChange.unavailable");

  return (
    <div className={`file-change-card ${statusClass}`} data-file-change-path={change.path}>
      <div className="file-change-header">
        <button
          type="button"
          className="file-change-toggle tool-call-toggle"
          aria-expanded={expanded}
          onClick={(event) => togglePreservingScroll(event.currentTarget, () => onExpandedChange(!expanded))}
        >
          <span className="file-change-icon" aria-hidden="true"><AliIcon name={icon} size={14} /></span>
          <span className="file-change-title">{t(titleKey)}</span>
          <span className="file-change-path" title={change.path}>{change.path}</span>
          {change.status === "completed" && (change.added > 0 || change.removed > 0) ? (
            <span className="file-change-stats" aria-label={t("fileChange.stats", { added: change.added, removed: change.removed })}>
              <span className="file-change-additions">+{change.added}</span>
              <span className="file-change-deletions">−{change.removed}</span>
            </span>
          ) : null}
          {duration !== undefined ? <span className="file-change-duration">{duration}s</span> : null}
          <AliIcon name="chevron-right" size={11} style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }} />
        </button>
        {onOpenFile ? (
          <button type="button" className="file-change-open" title={t("diff.openFile")} aria-label={t("diff.openFile")} onClick={() => onOpenFile(change.path)}>
            <AliIcon name="external-link" size={13} />
          </button>
        ) : null}
      </div>

      {expanded ? (
        <div className="file-change-details">
          {change.patch ? (
            <DiffView className="file-change-diff" patch={change.patch} filePath={change.path} mode="unified" showFileHeader={false} />
          ) : change.status === "failed" ? (
            <PairedResult text={resultText} isEmpty={!resultText.trim()} isError />
          ) : (
            <div className="file-change-notice">{noDiffMessage}</div>
          )}
          <button
            type="button"
            className="file-change-diagnostics-toggle"
            onClick={(event) => togglePreservingScroll(event.currentTarget, () => onDiagnosticsOpenChange(!diagnosticsOpen))}
            aria-expanded={diagnosticsOpen}
          >
            <AliIcon name="code" size={12} />
            <span>{t("toolSummary.diagnostics")}</span>
            <AliIcon name="chevron-right" size={9} style={{ marginLeft: "auto", transform: diagnosticsOpen ? "rotate(90deg)" : "none" }} />
          </button>
          {diagnosticsOpen ? <pre className="file-change-diagnostics">{diagnostics}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}

function togglePreservingScroll(control: HTMLElement, toggle: () => void) {
  const scroller = control.closest(".overflow-y-auto") as HTMLElement | null;
  const scrollTop = scroller?.scrollTop;
  toggle();
  if (!scroller || scrollTop === undefined) return;
  requestAnimationFrame(() => { scroller.scrollTop = scrollTop; });
}

interface ResultDiff {
  text: string;
}

function PairedDiffResult({ diff }: {
  diff: ResultDiff;
}) {
  return (
    <div
      style={{
        borderTop: "1px solid rgba(34,197,94,0.15)",
        background: "var(--bg)",
      }}
    >
      <DiffView patch={diff.text} mode="split" />
    </div>
  );
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
  return (
    <div
      style={{
        borderTop: `1px solid ${isError ? "rgba(248,113,113,0.3)" : "rgba(34,197,94,0.15)"}`,
        background: isError ? "rgba(248,113,113,0.04)" : "var(--bg-subtle)",
      }}
    >
      <pre
        style={{
          margin: 0,
          padding: "8px 10px",
          color: isError ? "#f87171" : (isEmpty ? "var(--text-dim)" : "var(--text-muted)"),
          fontSize: "var(--text-sm)",
          lineHeight: 1.5,
          overflow: "auto",
          maxHeight: 400,
          background: "var(--bg)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          fontStyle: isEmpty ? "italic" : "normal",
          opacity: isEmpty ? 0.6 : 1,
        }}
      >
         {isEmpty ? t("i18n.noOutput") : text}
      </pre>
    </div>
  );
}

function CompactionMessageView({ message }: { message: CustomMessage }) {
  const { t } = useI18n();
  const summary = getMessageText(message.content);
  const parsedSummary = useMemo(() => parseCompactionSummary(summary), [summary]);
  const time = formatTime(message.timestamp);

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          overflow: "hidden",
          background: "var(--bg)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 10px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
          }}
        >
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", fontWeight: 650 }}>
            compaction
          </span>
          {time && <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: "var(--text-xs)" }}>{time}</span>}
        </div>

        <div style={{ padding: "11px 13px 12px" }}>
          <div style={{ color: "var(--text)", fontSize: "var(--text-md)", fontWeight: 700, lineHeight: 1.35 }}>
             {t("i18n.conversationCompacted")}
          </div>
          <div style={{ marginTop: 3, marginBottom: 10, color: "var(--text)", fontSize: "var(--text-base)", lineHeight: 1.5 }}>
             {t("i18n.compactionDescription")}
          </div>
          {parsedSummary.body ? (
            <MarkdownBody className="markdown-compaction-message">{parsedSummary.body}</MarkdownBody>
          ) : (
             <span style={{ color: "var(--text-dim)", fontSize: "var(--text-sm)" }}>{t("i18n.noSummary")}</span>
          )}
          <CompactionFileMetadata readFiles={parsedSummary.readFiles} modifiedFiles={parsedSummary.modifiedFiles} />
        </div>
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
       <summary>{t("i18n.fileContext", { details: parts.join(", ") })}</summary>
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

function CustomMessageView({ message, cwd, onOpenFile }: { message: CustomMessage; cwd?: string; onOpenFile?: (filePath: string) => void }) {
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

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          overflow: "hidden",
          background: isHiddenDisplay ? "var(--bg-subtle)" : "var(--bg)",
          opacity: isHiddenDisplay && !contentExpanded ? 0.82 : 1,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 10px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
            fontSize: "var(--text-sm)",
          }}
        >
          <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", fontWeight: 650 }}>
            {title}
          </span>
           {isHiddenDisplay && <span style={{ color: "var(--text-dim)", fontSize: "var(--text-xs)" }}>{t("i18n.hiddenExtensionMessage")}</span>}
          {time && <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: "var(--text-xs)" }}>{time}</span>}
        </div>

        {contentExpanded ? (
          <div style={{ padding: "6px 9px" }}>
            {images.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: text ? 8 : 0 }}>
                {images.map((img, i) => {
                  const src = imageSource(img);
                  if (!src) return null;
                  return <MessageImage key={i} src={src} index={i} onOpen={() => setOpenImageIndex(i)} />;
                })}
              </div>
            )}
             {text ? <MarkdownBody className="markdown-custom-message" cwd={cwd} onOpenFile={onOpenFile}>{text}</MarkdownBody> : <span style={{ color: "var(--text-dim)", fontSize: "var(--text-sm)" }}>{t("i18n.noMessage")}</span>}
          </div>
        ) : (
          <button
            onClick={() => setContentExpanded(true)}
            style={{
              display: "block",
              width: "100%",
              padding: "8px 10px",
              border: "none",
              background: "transparent",
              color: "var(--text-dim)",
              cursor: "pointer",
              fontSize: "var(--text-sm)",
              textAlign: "left",
            }}
          >
             {text ? previewText(text) : t("i18n.showExtensionMessage")}
          </button>
        )}
        {openImageIndex !== null && images[openImageIndex] && (
          <MessageImageViewer
            src={imageSource(images[openImageIndex])}
            index={openImageIndex}
            onClose={() => setOpenImageIndex(null)}
          />
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "4px 9px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-subtle)",
          }}
        >
          {text || detailsText ? (
            <button
              onClick={copyContent}
              style={{
                padding: "3px 7px",
                border: "none",
                background: "none",
                color: copied ? "var(--accent)" : "var(--text-dim)",
                cursor: "pointer",
                fontSize: "var(--text-xs)",
              }}
            >
               {copied ? t("i18n.copied") : t("i18n.copy")}
            </button>
          ) : null}
          {(hasDetails || isHiddenDisplay) && (
            <button
              onClick={() => {
                if (isHiddenDisplay) setContentExpanded((v) => !v);
                else setDetailsExpanded((v) => !v);
              }}
              style={{
                marginLeft: "auto",
                padding: "3px 7px",
                border: "none",
                background: "none",
                color: "var(--text-dim)",
                cursor: "pointer",
                fontSize: "var(--text-xs)",
              }}
            >
              {isHiddenDisplay
                 ? (contentExpanded ? t("i18n.collapse") : t("i18n.expand"))
                 : (detailsExpanded ? t("i18n.hideDetails") : t("i18n.showDetails"))}
            </button>
          )}
        </div>

        {hasDetails && ((isHiddenDisplay && contentExpanded) || (!isHiddenDisplay && detailsExpanded)) && (
          <pre
            style={{
              margin: 0,
              padding: "9px 10px",
              borderTop: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              fontSize: "var(--text-sm)",
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 360,
              overflow: "auto",
              fontFamily: "var(--font-mono)",
            }}
          >
            {detailsText}
          </pre>
        )}
      </div>
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
  const flat = img as unknown as { data?: string; mimeType?: string };
  if (img.source) {
    return img.source.type === "base64"
      ? `data:${img.source.media_type};base64,${img.source.data}`
      : img.source.url ?? "";
  }
  return flat.data ? `data:${flat.mimeType};base64,${flat.data}` : "";
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

function BashExecutionView({ message, sessionId }: { message: BashExecutionMessage; sessionId?: string }) {
  const [fullOutput, setFullOutput] = useState<string | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [fullError, setFullError] = useState<string | null>(null);

  const isPending = !message.output && message.exitCode === undefined && !message.cancelled;
  const isError = message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0);
  const fullOutputUrl = sessionId && message.fullOutputPath
    ? `/api/agent/${encodeURIComponent(sessionId)}/bash-output?path=${encodeURIComponent(message.fullOutputPath)}`
    : null;
  const showFullButton = message.truncated && fullOutputUrl && fullOutput === null;
  const displayOutput = fullOutput ?? message.output;

  async function loadFullOutput() {
    if (!fullOutputUrl) return;
    setLoadingFull(true);
    setFullError(null);
    try {
      const res = await fetch(fullOutputUrl);
      const d = await res.json() as { success?: boolean; data?: { output?: string }; error?: string };
      if (d.success) {
        setFullOutput(d.data?.output ?? "");
      } else {
        setFullError(d.error ?? "failed");
      }
    } catch (e) {
      setFullError(String(e));
    } finally {
      setLoadingFull(false);
    }
  }

  // Reuse the existing ToolCallBlock so user-run bash looks identical to an
  // agent-run bash tool call: same header, collapse behavior, result pane.
  // Synthesize an equivalent ToolCallContent + ToolResultMessage pair.
  const toolName = message.excludeFromContext ? "bash (local)" : "bash";
  const block: ToolCallContent = {
    type: "toolCall",
    toolCallId: `bash-${message.timestamp ?? ""}`,
    toolName,
    input: { command: message.command },
  };
  const result: ToolResultMessage | undefined = isPending
    ? undefined
    : {
        role: "toolResult",
        toolCallId: block.toolCallId,
        toolName,
        content: displayOutput ? [{ type: "text", text: displayOutput }] : [],
        isError,
        timestamp: message.timestamp,
      };

  return (
    <div style={{ margin: "6px 0" }}>
      <ToolCallBlock block={block} result={result} />
      {message.truncated && fullOutputUrl && (
        <div style={{ padding: "4px 10px", fontSize: "var(--text-xs)", marginTop: -1 }}>
          {showFullButton && (
            <button
              onClick={loadFullOutput}
              disabled={loadingFull}
              style={{ background: "none", border: "none", color: "var(--accent)", cursor: loadingFull ? "default" : "pointer", fontSize: "var(--text-xs)", padding: 0, textDecoration: "underline" }}
            >
              {loadingFull ? "loading…" : "view full output"}
            </button>
          )}
          <a
            href={`${fullOutputUrl}&download=1`}
            style={{ marginLeft: showFullButton ? 10 : 0, color: "var(--accent)", fontSize: "var(--text-xs)", textDecoration: "underline" }}
          >
            download full output
          </a>
          {fullError && <span style={{ marginLeft: 6, color: "var(--text-dim)", fontSize: "var(--text-xs)" }}>({fullError})</span>}
        </div>
      )}
    </div>
  );
}
