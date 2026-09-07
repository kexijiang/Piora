"use client";
import { registerAbortHandler } from "@/hooks/useKeyboardShortcuts";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentMessage, BashExecutionMessage, ExtensionUiRequest, SessionInfo, SessionTreeNode } from "@/lib/types";
import { normalizeCustomPanelLines, parseAnsiLine } from "@/lib/ansi";
import { asBracketedPaste, toTerminalKeyData } from "@/lib/terminal-input";
import { messageFingerprint } from "@/lib/chat-history";
import { ChatHistory, type ChatHistoryHandle } from "./ChatHistory";
import { MessageView } from "./MessageView";
import { RenderErrorBoundary } from "./RenderErrorBoundary";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { NewSessionContextChip, NewSessionLauncher } from "./NewSessionLauncher";
import { SystemPromptSelector } from "./SystemPromptSelector";
import type { NewSessionInitialPrompt } from "./new-session-types";
import { ChatMinimap } from "./ChatMinimap";
import { ChatScrollRail } from "./ChatScrollRail";
import { useI18n } from "@/hooks/useI18n";
import { useAgentSession, type AgentPhase, type AttachedImage, type BuiltinSlashCommandResult, type NoticeItem, type SlashCommandInfo } from "@/hooks/useAgentSession";
import { useDragDrop } from "@/hooks/useDragDrop";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import type { ContextUsage, SessionStatsInfo } from "@/lib/pi-types";
import { deriveCompanionActivityStatus, type CompanionActivity } from "@/lib/companion";
import { AliIcon } from "./AliIcon";
import { shouldShowScrollToBottom } from "@/lib/chat-scroll";
import { getProjectLabel } from "@/lib/session-project-groups";
import { isProjectlessChatCwd } from "@/lib/projectless-chat-path";
import { UserInputCard } from "./UserInputCard";
import type { SessionCapabilitiesState } from "@/lib/session-capabilities";
import { findVisionAgentStatus, VisionAgentStatus } from "./VisionAgentStatus";

interface Props {
  session: SessionInfo | null;
  focusEntryId?: string | null;
  newSessionCwd: string | null;
  newSessionInitialModel?: { provider: string; modelId: string } | null;
  initialPrompt?: NewSessionInitialPrompt | null;
  claimInitialPrompt?: (promptId: string) => boolean;
  onAgentEnd?: (sessionId: string) => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSessionStatsChange?: (stats: SessionStatsInfo | null) => void;
  onSessionStatsPanelOpen?: () => void;
  onContextUsageChange?: (usage: ContextUsage | null) => void;
  onOpenFile?: (filePath: string) => void;
  onCompanionActivityChange?: (activity: CompanionActivity) => void;
  onTaskControlsChange?: (controls: TaskControls | null) => void;
  onOpenTaskChanges?: () => void;
  onRenameTask?: (name: string) => void | Promise<void>;
  onExportTask?: () => void;
  onSlashCommandsChange?: (commands: SlashCommandInfo[]) => void;
  onOpenAutomation?: (automationId: string) => void;
  onCapabilitiesChange?: (capabilities: SessionCapabilitiesState | null) => void;
  onOpenModels?: () => void;
  onPromptSubmitted?: () => void;
}

export interface TaskControls {
  disabled: boolean;
  runCommand: (command: string, excludeFromContext: boolean) => Promise<void>;
  abort: () => Promise<void>;
  bashRunning: boolean;
  pendingCommand: string | null;
  latestBash: { command: string; output: string; exitCode?: number; cancelled?: boolean; excludeFromContext?: boolean } | null;
}

function phaseLabel(phase: AgentPhase, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (phase?.kind === "stopping") return t("taskHeader.stopping");
  if (phase?.kind === "running_tools") {
    const names = (Array.isArray(phase.tools) ? phase.tools : []).map((t) => (typeof t?.name === "string" ? t.name : ""));
    if (names.length === 0) return t("chat.runningTool");
    if (names.length === 1) return t("chat.runningNamedTool", { name: names[0] });
    if (names.length <= 3) return t("chat.runningTools", { names: names.join(", ") });
    return t("chat.runningToolsMore", { names: names.slice(0, 2).join(", "), count: names.length - 2 });
  }
  if (phase?.kind === "waiting_model") return t("chat.waitingModel");
  if (phase?.kind === "running_command") return t("chat.runningCommand");
  return t("chat.thinking");
}

const CHAT_MINIMAP_WIDTH = 36;
const CHAT_COLUMN_PADDING = 16;
const CHAT_COLUMN_LEFT_PADDING = 36;
const CHAT_SCROLL_RAIL_WIDTH = 14;
const CHAT_SCROLL_RAIL_GAP = 10;
const CHAT_COLUMN_RIGHT_PADDING = CHAT_SCROLL_RAIL_WIDTH + CHAT_SCROLL_RAIL_GAP;
const CHAT_INPUT_RIGHT_PADDING = CHAT_MINIMAP_WIDTH + CHAT_COLUMN_RIGHT_PADDING;
const CHAT_COLUMN_DEFAULT_WIDTH = 820;
const CHAT_COLUMN_MIN_WIDTH = 560;
const CHAT_COLUMN_MAX_WIDTH = 1400;
const SCROLL_TO_BOTTOM_THRESHOLD = 96;

function getUserInputText(message: AgentMessage): string | null {
  if (message.role !== "user") return null;
  if (typeof message.content === "string") {
    const text = message.content.trim();
    return text.length > 0 ? text : null;
  }
  const text = Array.isArray(message.content)
    ? message.content
      .filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n")
      .trim()
    : "";
  return text.length > 0 ? text : null;
}

function getVisionRetryPayload(messages: readonly AgentMessage[]): { message: string; images?: AttachedImage[] } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const text = getUserInputText(message) ?? "";
    const images = Array.isArray(message.content)
      ? message.content.flatMap((block) => {
        if (block.type !== "image" || block.source.type !== "base64" || !block.source.data) return [];
        const mimeType = block.source.media_type || "image/png";
        return [{
          data: block.source.data,
          mimeType,
          previewUrl: `data:${mimeType};base64,${block.source.data}`,
        } satisfies AttachedImage];
      })
      : [];
    if (text || images.length > 0) return { message: text, ...(images.length > 0 ? { images } : {}) };
  }
  return null;
}

export function ChatWindow({ session, focusEntryId, newSessionCwd, newSessionInitialModel, initialPrompt, claimInitialPrompt, onAgentEnd, onSessionCreated, onSessionForked, modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSessionStatsChange, onSessionStatsPanelOpen, onContextUsageChange, onOpenFile, onCompanionActivityChange, onTaskControlsChange, onSlashCommandsChange, onOpenAutomation, onCapabilitiesChange, onOpenModels, onPromptSubmitted }: Props) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const chatSurfaceRef = useRef<HTMLDivElement>(null);
  const chatColumnWidthRef = useRef(CHAT_COLUMN_DEFAULT_WIDTH);
  const getChatColumnMaxWidth = useCallback(() => {
    const surfaceWidth = chatSurfaceRef.current?.clientWidth
      ?? (typeof window === "undefined" ? CHAT_COLUMN_MAX_WIDTH : window.innerWidth);
    return Math.max(CHAT_COLUMN_MIN_WIDTH, surfaceWidth - CHAT_COLUMN_LEFT_PADDING - CHAT_INPUT_RIGHT_PADDING);
  }, []);
  const getResponsiveChatColumnWidth = useCallback(() => {
    const viewportWidth = typeof window === "undefined" ? CHAT_COLUMN_MAX_WIDTH : window.innerWidth;
    const fluidWidth = Math.min(1180, Math.max(CHAT_COLUMN_DEFAULT_WIDTH, viewportWidth * 0.72));
    return Math.min(getChatColumnMaxWidth(), fluidWidth);
  }, [getChatColumnMaxWidth]);
  const getRenderedChatColumnWidth = useCallback(() => (
    chatSurfaceRef.current?.querySelector<HTMLElement>(".chat-column")?.getBoundingClientRect().width
      ?? getResponsiveChatColumnWidth()
  ), [getResponsiveChatColumnWidth]);
  const chatColumnResizer = useResizablePanel({
    ariaLabel: t("layout.resizeChatColumn"),
    cssVariable: "--chat-column-width",
    defaultWidth: CHAT_COLUMN_DEFAULT_WIDTH,
    getCurrentWidth: getRenderedChatColumnWidth,
    getDefaultWidth: getResponsiveChatColumnWidth,
    getMaxWidth: getChatColumnMaxWidth,
    growthDirection: "right",
    dragScale: 2,
    followDefaultWidth: true,
    maxWidth: CHAT_COLUMN_MAX_WIDTH,
    minWidth: CHAT_COLUMN_MIN_WIDTH,
    panelRef: chatSurfaceRef,
    storageKey: "pi-chat-column-width",
    widthRef: chatColumnWidthRef,
  });

  // 稳定化 onEditContent 引用，配合 React.memo 防止历史消息重渲染
  const handleEditContent = useCallback((content: string) => {
    chatInputRef?.current?.insertIfEmpty(content);
  }, [chatInputRef]);

  const {
    loading, error, messages, entryIds, streamState,
    agentRunning, bashRunning, pendingBash, modelNames, modelList, modelError, modelThinkingLevels, modelThinkingLevelMaps, thinkingLevel,
    retryInfo, contextUsage, systemPromptBinding, systemPromptSelection, systemPromptSaving, forkingEntryId,
    isCompacting, compactError, compactResult, displayModel: displayModelValue, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages, capabilities,
    liveOutputFollowPaused,
    notices, extensionDialog, extensionCustomUi, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput,
    isAutoModelSelection,
    agentPhase,
    isNew,
    sessionIdRef, messagesEndRef, scrollContainerRef,
    lastUserMsgRef,
    pendingScrollToUserRef,
    handleSend, handleAbort, handleFork, handleNavigate, handleModelChange, handleScrollToBottom, pauseHistoryFollow,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    handleRecallQueue,
    handleBuiltinSlashCommand,
    handleThinkingLevelChange, handleSystemPromptSelection, loadSlashCommands,
  } = useAgentSession({
    session, newSessionCwd, newSessionInitialModel,
    newSessionInitialSystemPromptSelection: initialPrompt?.systemPromptSelection ?? null,
    onAgentEnd, onSessionCreated, onSessionForked,
    modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSessionStatsPanelOpen,
  });
  const sessionBusy = agentRunning || bashRunning;
  const locallyClaimedInitialPromptRef = useRef<string | null>(null);
  const handleComposerSend = useCallback(async (...args: Parameters<typeof handleSend>) => {
    await handleSend(...args);
    onPromptSubmitted?.();
  }, [handleSend, onPromptSubmitted]);

  useEffect(() => {
    if (!isNew || !initialPrompt || sessionBusy || isAutoModelSelection) return;
    if (locallyClaimedInitialPromptRef.current === initialPrompt.id) return;
    if (claimInitialPrompt && !claimInitialPrompt(initialPrompt.id)) return;
    locallyClaimedInitialPromptRef.current = initialPrompt.id;
    void handleSend(
      initialPrompt.message,
      initialPrompt.images,
      initialPrompt.files,
    ).then(() => onPromptSubmitted?.());
  }, [claimInitialPrompt, handleSend, initialPrompt, isAutoModelSelection, isNew, onPromptSubmitted, sessionBusy]);

  // Builtin slash-command results echo into the conversation area instead of
  // only appearing as transient notices, so the user can see what a command
  // did without opening panels or reading toasts.
  const [commandEchoes, setCommandEchoes] = useState<Array<{ id: number; text: string; message?: string; error?: string }>>([]);
  const commandEchoCounterRef = useRef(0);
  useEffect(() => {
    setCommandEchoes([]);
    commandEchoCounterRef.current = 0;
  }, [session?.id]);
  const handleBuiltinCommandWithEcho = useCallback(async (message: string): Promise<BuiltinSlashCommandResult> => {
    const result = await handleBuiltinSlashCommand(message);
    if (result.handled) {
      commandEchoCounterRef.current += 1;
      const echo = {
        id: commandEchoCounterRef.current,
        text: message,
        ...(result.error ? { error: result.error } : {}),
        ...(result.message ? { message: result.message } : {}),
      };
      setCommandEchoes((current) => [...current.slice(-39), echo]);
    }
    return result;
  }, [handleBuiltinSlashCommand]);
  const latestBash = useMemo(() => {
    if (streamState.streamingMessage?.role === "bashExecution") {
      return streamState.streamingMessage as BashExecutionMessage;
    }
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === "bashExecution") return message;
    }
    return null;
  }, [messages, streamState.streamingMessage]);
  useEffect(() => { onSlashCommandsChange?.(slashCommands); }, [onSlashCommandsChange, slashCommands]);
  useEffect(() => {
    if (session?.id) void loadSlashCommands();
  }, [loadSlashCommands, session?.id]);

  useEffect(() => {
    onTaskControlsChange?.({
      disabled: sessionBusy,
      runCommand: async (command, excludeFromContext) => { await handleSend(`${excludeFromContext ? "!!" : "!"}${command}`); },
      abort: handleAbort,
      bashRunning,
      pendingCommand: pendingBash?.command ?? null,
      latestBash,
    });
  }, [bashRunning, handleAbort, handleSend, latestBash, onTaskControlsChange, pendingBash?.command, sessionBusy]);

  useEffect(() => () => onTaskControlsChange?.(null), [onTaskControlsChange]);
  useEffect(() => { onCapabilitiesChange?.(capabilities); }, [capabilities, onCapabilitiesChange]);
  useEffect(() => () => onCapabilitiesChange?.(null), [onCapabilitiesChange]);
  const latestErrorNotice = useMemo(() => {
    for (let index = notices.length - 1; index >= 0; index -= 1) {
      if (notices[index]?.type === "error") return notices[index]?.message ?? null;
    }
    return null;
  }, [notices]);
  const companionActivityStatus = deriveCompanionActivityStatus({
    error,
    hasErrorNotice: latestErrorNotice !== null,
    hasReviewRequest: Boolean(extensionDialog || extensionCustomUi),
    isBusy: sessionBusy,
    isCompacting,
    phase: agentPhase?.kind ?? null,
  });
  const companionActivityCause = companionActivityStatus === "failed"
    ? (error || latestErrorNotice || t("companion.activity.failedCause"))
    : companionActivityStatus === "review"
      ? t("companion.activity.reviewCause")
      : companionActivityStatus === "waiting"
        ? t("companion.activity.waitingCause")
        : companionActivityStatus === "running"
          ? (isCompacting ? t("companion.activity.compactingCause") : phaseLabel(agentPhase, t))
          : "";

  const companionSessionId = session?.id ?? sessionIdRef.current ?? undefined;
  const companionWasBusyRef = useRef(false);
  const companionPreviousStatusRef = useRef<CompanionActivity["status"]>("idle");
  const companionRunIdRef = useRef(0);
  const [companionActivityEvent, setCompanionActivityEvent] = useState<CompanionActivity["event"]>();

  useEffect(() => {
    const wasBusy = companionWasBusyRef.current;
    const previousStatus = companionPreviousStatusRef.current;
    let kind: NonNullable<CompanionActivity["event"]>["kind"] | null = null;

    if (companionActivityStatus === "failed" && previousStatus !== "failed") {
      kind = "failed";
    } else if (sessionBusy && !wasBusy) {
      companionRunIdRef.current += 1;
      kind = "started";
    } else if (!sessionBusy && wasBusy && companionActivityStatus !== "failed") {
      kind = "completed";
    }

    companionWasBusyRef.current = sessionBusy;
    companionPreviousStatusRef.current = companionActivityStatus;
    if (!kind) return;

    const runId = companionRunIdRef.current;
    const occurredAt = Date.now();
    setCompanionActivityEvent({
      kind,
      occurredAt,
      key: `${companionSessionId ?? "draft"}:${runId}:${kind}:${occurredAt}`,
    });
  }, [companionActivityStatus, companionSessionId, sessionBusy]);

  useEffect(() => {
    onCompanionActivityChange?.({
      status: companionActivityStatus,
      cause: companionActivityCause,
      ...(companionSessionId ? { sessionId: companionSessionId } : {}),
      ...(companionRunIdRef.current > 0 ? { runId: companionRunIdRef.current } : {}),
      ...(companionActivityEvent ? { event: companionActivityEvent } : {}),
    });
  }, [companionActivityCause, companionActivityEvent, companionActivityStatus, companionSessionId, onCompanionActivityChange]);

  useEffect(() => () => {
    onCompanionActivityChange?.({ status: "idle", cause: "" });
  }, [onCompanionActivityChange]);

  // Register the abort handler for the global Esc shortcut
  useEffect(() => {
    registerAbortHandler(sessionBusy ? handleAbort : null);
  }, [sessionBusy, handleAbort]);

  const historyRef = useRef<ChatHistoryHandle>(null);
  const [highlightedEntryId, setHighlightedEntryId] = useState<string | null>(null);
  const handledFocusEntryRef = useRef<string | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  useEffect(() => {
    if (!focusEntryId || loading || !entryIds.includes(focusEntryId)) return;
    const focusKey = (session?.id ?? "new") + ":" + focusEntryId;
    if (handledFocusEntryRef.current === focusKey) return;
    handledFocusEntryRef.current = focusKey;
    pauseHistoryFollow();
    historyRef.current?.revealEntry(focusEntryId);
    setHighlightedEntryId(focusEntryId);
  }, [entryIds, focusEntryId, loading, pauseHistoryFollow, session?.id]);
  useEffect(() => {
    if (!highlightedEntryId) return;
    const timer = window.setTimeout(() => setHighlightedEntryId(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [highlightedEntryId]);

  // Push session stats up to AppShell for the top bar.
  // Compare scalar fields to avoid loops from new object identity each render.
  const statsKey = sessionStats
    ? [
      sessionStats.sessionId,
      sessionStats.sessionFile ?? "",
      sessionStats.sessionName ?? "",
      sessionStats.userMessages,
      sessionStats.assistantMessages,
      sessionStats.toolCalls,
      sessionStats.toolResults,
      sessionStats.totalMessages,
      sessionStats.tokens.input,
      sessionStats.tokens.output,
      sessionStats.tokens.cacheRead,
      sessionStats.tokens.cacheWrite,
      sessionStats.tokens.total,
      sessionStats.cost ?? 0,
    ].join("|")
    : null;
  const sessionStatsRef = useRef(sessionStats);
  sessionStatsRef.current = sessionStats;
  useEffect(() => {
    onSessionStatsChange?.(sessionStatsRef.current);
  }, [statsKey, onSessionStatsChange]);
  useEffect(() => () => { onSessionStatsChange?.(null); }, [onSessionStatsChange]);

  // Push context usage up to AppShell as well.
  const ctxKey = contextUsage
    ? `${contextUsage.percent ?? "null"}|${contextUsage.contextWindow}|${contextUsage.tokens ?? "null"}`
    : null;
  const contextUsageRef = useRef(contextUsage);
  contextUsageRef.current = contextUsage;
  useEffect(() => {
    onContextUsageChange?.(contextUsageRef.current);
  }, [ctxKey, onContextUsageChange]);
  useEffect(() => () => { onContextUsageChange?.(null); }, [onContextUsageChange]);

  const onDrop = useCallback((files: File[]) => {
    if (sessionBusy) return;
    chatInputRef?.current?.addFiles(files);
  }, [sessionBusy, chatInputRef]);

  const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop(onDrop);

  const inputHistory = useMemo(() => {
    const seen = new Set<string>();
    const history: string[] = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const text = getUserInputText(messages[i]);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      history.push(text);
      if (history.length >= 50) break;
    }
    return history.reverse();
  }, [messages]);
  const userEntryIds = useMemo(() => messages.flatMap((message, index) => message.role === "user" ? [entryIds[index]] : []), [messages, entryIds]);
  const revealHistoryForMinimap = useCallback((userIndex: number) => {
    pauseHistoryFollow();
    const id = userEntryIds[userIndex];
    if (id) historyRef.current?.revealEntry(id);
  }, [pauseHistoryFollow, userEntryIds]);
  const jumpToBottom = useCallback(() => {
    historyRef.current?.cancelNavigation();
    handleScrollToBottom();
  }, [handleScrollToBottom]);

  const isEmptyNew = isNew && messages.length === 0 && !streamState.isStreaming && !sessionBusy;

  useEffect(() => {
    if (loading || isEmptyNew) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    let frame = 0;
    const updateVisibility = () => {
      frame = 0;
      const transientTail = container.querySelector<HTMLElement>("[data-chat-tail-spacer]");
      const shouldShow = liveOutputFollowPaused || shouldShowScrollToBottom({
        scrollHeight: container.scrollHeight,
        scrollTop: container.scrollTop,
        clientHeight: container.clientHeight,
        transientTailHeight: transientTail?.offsetHeight ?? 0,
        threshold: SCROLL_TO_BOTTOM_THRESHOLD,
      });
      setShowScrollToBottom((current) => current === shouldShow ? current : shouldShow);
    };
    const scheduleUpdate = () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updateVisibility);
    };

    container.addEventListener("scroll", scheduleUpdate, { passive: true });
    const resizeObserver = new ResizeObserver(scheduleUpdate);
    resizeObserver.observe(container);
    const content = container.firstElementChild;
    if (content) resizeObserver.observe(content);
    scheduleUpdate();

    return () => {
      container.removeEventListener("scroll", scheduleUpdate);
      resizeObserver.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [isEmptyNew, liveOutputFollowPaused, loading, scrollContainerRef, session?.id]);

  const messageCwd = session?.cwd ?? newSessionCwd ?? undefined;
  const isProjectlessChat = session?.projectless === true || isProjectlessChatCwd(messageCwd);
  const newSessionProjectLabel = isProjectlessChat
    ? t("sidebar.chats")
    : messageCwd ? getProjectLabel(messageCwd) : t("projectMenu.noProject");

  const availableThinkingLevels = displayModelValue
    ? (modelThinkingLevels[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const currentThinkingLevelMap = displayModelValue
    ? (modelThinkingLevelMaps[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const visibleExtensionStatuses = extensionStatuses;
  const visionStatus = useMemo(() => findVisionAgentStatus(extensionStatuses), [extensionStatuses]);
  const visionRetryPayload = useMemo(() => getVisionRetryPayload(messages), [messages]);
  const retryVisionAnalysis = useCallback(() => {
    if (sessionBusy || !visionRetryPayload) return;
    void handleComposerSend(visionRetryPayload.message, visionRetryPayload.images);
  }, [handleComposerSend, sessionBusy, visionRetryPayload]);

  const chatInputElement = (
    <ChatInput
      ref={chatInputRef}
      variant={isEmptyNew ? "launcher" : "conversation"}
      placeholder={isEmptyNew ? t("newSession.placeholder") : undefined}
      contextControl={(
        <>
          {isEmptyNew ? (
            <NewSessionContextChip
              label={newSessionProjectLabel}
              title={isProjectlessChat ? undefined : messageCwd}
            />
          ) : null}
          <SystemPromptSelector
            selection={systemPromptSelection}
            binding={systemPromptBinding}
            disabled={sessionBusy || systemPromptSaving}
            onChange={handleSystemPromptSelection}
          />
        </>
      )}
      onSend={handleComposerSend}
      onAbort={handleAbort}
      onSteer={agentRunning ? handleSteer : undefined}
      onFollowUp={agentRunning ? handleFollowUp : undefined}
      onPromptWithStreamingBehavior={agentRunning ? handlePromptWithStreamingBehavior : undefined}
      isStreaming={sessionBusy}
      model={displayModelValue}
      isAutoModelSelection={isAutoModelSelection}
      modelNames={modelNames}
      modelList={modelList}
      modelError={modelError}
      onModelChange={handleModelChange}
      onCompact={session ? handleCompact : undefined}
      onAbortCompaction={handleAbortCompaction}
      isCompacting={isCompacting}
      compactError={compactError}
      compactResult={compactResult}
      thinkingLevel={thinkingLevel}
      onThinkingLevelChange={session || isNew ? handleThinkingLevelChange : undefined}
      availableThinkingLevels={availableThinkingLevels}
      thinkingLevelMap={currentThinkingLevelMap}
      retryInfo={retryInfo}
      queuedMessages={queuedMessages}
      inputHistory={inputHistory}
      onRecallQueue={handleRecallQueue}
      slashCommands={slashCommands}
      slashCommandsLoading={slashCommandsLoading}
      onLoadSlashCommands={loadSlashCommands}
      onBuiltinCommand={handleBuiltinCommandWithEcho}
      draftKey={session?.id ?? (newSessionCwd ? `new:${newSessionCwd}` : undefined)}
      cwd={session?.cwd ?? newSessionCwd}
      contextUsage={contextUsage}
      sessionStats={sessionStats}
      extensionStatuses={visibleExtensionStatuses}
    />
  );

  const aboveEditorWidgets = extensionWidgets.filter((widget) => widget.placement !== "belowEditor");
  const belowEditorWidgets = extensionWidgets.filter((widget) => widget.placement === "belowEditor");

  if (loading) {
    return (
      <div className="relative flex h-full flex-col overflow-hidden" aria-busy="true">
        <div className="session-loading-indicator flex flex-1 items-center justify-center text-text-muted" role="status">
          {t("chat.loadingSession")}
        </div>
        <div className="session-loading-composer" aria-hidden="true" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-red-400">
        {error}
      </div>
    );
  }

  return (
    <div
      ref={chatSurfaceRef}
      className="relative flex h-full flex-col overflow-hidden"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && !sessionBusy && (
        <div className="pointer-events-none absolute inset-0 z-50 flex animate-[drop-zone-in_0.15s_ease_both] items-center justify-center bg-[rgba(37,99,235,0.06)] backdrop-blur-[1px]">
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {[0, 0.8, 1.6].map((delay) => (
              <div
                key={delay}
                className="absolute h-[720px] w-[720px] rounded-full border-[1.5px] border-solid border-[rgba(37,99,235,0.5)] animate-[drop-ripple_2.4s_ease-out_infinite_backwards]"
                style={{ transformOrigin: "center", animationDelay: `${delay}s` }}
              />
            ))}
          </div>
          <svg
            width="280" height="280" viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg"
            className="drop-shadow-[0_6px_18px_rgba(37,99,235,0.18)]"
          >
            <rect x="28" y="44" width="84" height="60" rx="8" fill="rgba(37,99,235,0.08)" stroke="rgba(37,99,235,0.50)" strokeWidth="1.8"/>
            <path d="M36 100 L54 72 L68 88 L80 74 L104 100Z" fill="rgba(37,99,235,0.16)" stroke="rgba(37,99,235,0.40)" strokeWidth="1.4" strokeLinejoin="round"/>
            <circle cx="96" cy="58" r="8" fill="rgba(37,99,235,0.22)" stroke="rgba(37,99,235,0.55)" strokeWidth="1.6"/>
            <g stroke="rgba(37,99,235,0.45)" strokeWidth="1.4" strokeLinecap="round">
              <line x1="96" y1="46" x2="96" y2="43"/>
              <line x1="96" y1="70" x2="96" y2="73"/>
              <line x1="84" y1="58" x2="81" y2="58"/>
              <line x1="108" y1="58" x2="111" y2="58"/>
              <line x1="87.5" y1="49.5" x2="85.4" y2="47.4"/>
              <line x1="104.5" y1="66.5" x2="106.6" y2="68.6"/>
              <line x1="104.5" y1="49.5" x2="106.6" y2="47.4"/>
              <line x1="87.5" y1="66.5" x2="85.4" y2="68.6"/>
            </g>
          </svg>
        </div>
      )}

      {extensionDialog?.method === "request_user_input" ? (
        <UserInputCard key={extensionDialog.id} request={extensionDialog} onRespond={respondToExtensionUi} />
      ) : extensionDialog ? (
        <ExtensionDialog request={extensionDialog} onRespond={respondToExtensionUi} />
      ) : null}

      {extensionCustomUi && (
        <ExtensionCustomPanel
          request={extensionCustomUi}
          onInput={sendExtensionCustomInput}
        />
      )}

      {!isMobile ? (
        <div
          {...chatColumnResizer.separatorProps}
          aria-label={t("layout.resizeChatColumnLeft")}
          className={`chat-column-resize-handle is-left${chatColumnResizer.isResizing ? " is-resizing" : ""}`}
          data-resize-growth-direction="left"
          title={`${t("layout.resizeChatColumnLeft")}: ${t("layout.resizeHint")}`}
        />
      ) : null}

      {isEmptyNew ? (
        <NewSessionLauncher
          cwd={messageCwd}
          projectLabel={newSessionProjectLabel}
          projectPath={isProjectlessChat ? null : messageCwd}
          onStarterSelect={handleEditContent}
        >
          <div>
            <NoticeShelf notices={notices} align="right" />
            {chatInputElement}
          </div>
        </NewSessionLauncher>
      ) : (
      <>
      <div className="relative flex flex-1 overflow-hidden">
        <div
          style={{
            position: "absolute",
            top: 12,
            left: 0,
            right: isMobile ? 0 : CHAT_MINIMAP_WIDTH,
            zIndex: 40,
            padding: `0 ${isMobile ? CHAT_COLUMN_PADDING : CHAT_COLUMN_RIGHT_PADDING}px 0 ${CHAT_COLUMN_LEFT_PADDING}px`,
            pointerEvents: "none",
          }}
        >
          <div className="chat-column">
            <NoticeShelf notices={notices} floating align="right" />
          </div>
        </div>
        <div id="chat-scroll-container" ref={scrollContainerRef} className="chat-scroll-container flex-1 overflow-y-auto pt-4">
          <div style={{ padding: `0 ${isMobile ? CHAT_COLUMN_PADDING : CHAT_COLUMN_RIGHT_PADDING}px 0 ${CHAT_COLUMN_LEFT_PADDING}px` }}>
            <div className="chat-column">
              <ExtensionWidgets widgets={aboveEditorWidgets} />

            <ChatHistory
              messages={messages} entryIds={entryIds} busy={sessionBusy} streaming={streamState.isStreaming}
              isNew={isNew} forkingEntryId={forkingEntryId} highlightedEntryId={highlightedEntryId}
              lastUserMsgRef={lastUserMsgRef} pendingScrollToUserRef={pendingScrollToUserRef} scrollContainer={scrollContainerRef} handleRef={historyRef}
              modelNames={modelNames} cwd={messageCwd} onOpenFile={onOpenFile}
              onFork={handleFork} onNavigate={handleNavigate} onEditContent={handleEditContent}
              sessionId={session?.id ?? sessionIdRef.current ?? undefined} onOpenAutomation={onOpenAutomation}
            />
            {streamState.isStreaming && streamState.streamingMessage && (
              <MessageView message={streamState.streamingMessage as AgentMessage} isStreaming modelNames={modelNames} cwd={messageCwd} onOpenFile={onOpenFile} onOpenAutomation={onOpenAutomation} />
            )}

            {agentRunning && (agentPhase?.kind === "stopping" || (!streamState.streamingMessage && visionStatus?.phase !== "failed")) && (
              visionStatus && agentPhase?.kind !== "stopping" ? (
                <VisionAgentStatus status={visionStatus} t={t} />
              ) : (
                <div className="py-2 text-text-muted" style={{ fontSize: "var(--text-base)" }} role="status" aria-live="polite">
                  <span className="animate-[pulse_1.5s_infinite]">{phaseLabel(agentPhase, t)}</span>
                </div>
              )
            )}

            {visionStatus?.phase === "failed" && (
              <VisionAgentStatus
                status={visionStatus}
                t={t}
                onRetry={visionRetryPayload ? retryVisionAnalysis : undefined}
                onConfigure={onOpenModels}
                retryDisabled={sessionBusy}
              />
            )}

            {bashRunning && !pendingBash && (
              <div className="py-2 text-text-muted" style={{ fontSize: "var(--text-base)" }}>
                 <span className="animate-[pulse_1.5s_infinite]">{t("chat.runningCommand")}</span>
              </div>
            )}

            {pendingBash && (
              <MessageView
                message={{
                  role: "bashExecution",
                  command: pendingBash.command,
                  output: pendingBash.output ?? "",
                  excludeFromContext: pendingBash.excludeFromContext,
                } as BashExecutionMessage}
                sessionId={session?.id ?? sessionIdRef.current ?? undefined}
              />
            )}

            {agentRunning && (
              <div
                data-chat-tail-spacer
                aria-hidden="true"
                style={{ height: scrollContainerRef.current ? scrollContainerRef.current.clientHeight : "80vh" }}
              />
            )}

            {commandEchoes.length > 0 && (
              <div className="command-echo-list" role="log" aria-label={t("chat.commands")}>
                {commandEchoes.map((echo) => (
                  <div key={echo.id} className={`command-echo-row${echo.error ? " is-error" : ""}`}>
                    <AliIcon name={echo.error ? "warning" : "check"} size={12} className="command-echo-icon" />
                    <span className="command-echo-command">{echo.text}</span>
                    <span className="command-echo-result">{echo.error ?? echo.message ?? t("chat.commandCompleted")}</span>
                  </div>
                ))}
              </div>
            )}

            <div ref={messagesEndRef} />
            </div>
          </div>
        </div>
        {isMobile ? null : (
          <div
            className="chat-scroll-rail-layout"
            style={{ right: CHAT_MINIMAP_WIDTH, padding: `0 ${CHAT_COLUMN_RIGHT_PADDING}px 0 ${CHAT_COLUMN_LEFT_PADDING}px` }}
          >
            <div className="chat-column chat-scroll-rail-anchor">
              <ChatScrollRail
                ariaLabel={t("chat.scrollRail")}
                scrollContainer={scrollContainerRef}
              />
            </div>
          </div>
        )}
        {isMobile ? null : (
          <RenderErrorBoundary
            resetKey={`minimap:${messages.length}:${messages.length > 0 ? messageFingerprint(messages[messages.length - 1], entryIds[entryIds.length - 1]) : "empty"}`}
            fallbackLabel={t("chat.messageRenderFailed")}
          >
            <ChatMinimap
              messages={messages}
              scrollContainer={scrollContainerRef}
              onRevealHistory={revealHistoryForMinimap}
            />
          </RenderErrorBoundary>
        )}
        {showScrollToBottom ? (
          <div
            className="chat-scroll-to-bottom-layer"
            style={{ right: isMobile ? 0 : CHAT_MINIMAP_WIDTH }}
          >
            <button
              type="button"
              className="chat-scroll-to-bottom"
              onClick={jumpToBottom}
              aria-label={t(liveOutputFollowPaused ? "chat.resumeAutoScroll" : "chat.scrollToBottom")}
              title={t(liveOutputFollowPaused ? "chat.resumeAutoScroll" : "chat.scrollToBottom")}
            >
              <AliIcon name="arrowdown" size={16} />
            </button>
          </div>
        ) : null}
      </div>

      <div className="relative">
        <div
          style={{
            padding: `0 ${CHAT_COLUMN_PADDING}px 0 ${CHAT_COLUMN_LEFT_PADDING}px`,
            paddingRight: isMobile ? CHAT_COLUMN_PADDING : CHAT_INPUT_RIGHT_PADDING,
          }}
        >
          <div className="chat-column">
            <ExtensionWidgets widgets={belowEditorWidgets} />
          </div>
        </div>
        {chatInputElement}
      </div>
      </>
      )}
    </div>
  );
}

function ExtensionWidgets({ widgets }: { widgets: Array<{ key: string; lines: string[] }> }) {
  if (widgets.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
      {widgets.map((widget) => (
        <div
          key={widget.key}
          style={{
            border: "1px solid var(--border)",
            borderRadius: 7,
            background: "var(--bg-panel)",
            overflow: "hidden",
          }}
        >
          <div style={{ padding: "5px 9px", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)" }}>
            {widget.key}
          </div>
          <pre style={{ margin: 0, padding: "8px 9px", color: "var(--text-muted)", fontSize: "var(--text-sm)", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-mono)" }}>
            {widget.lines.join("\n")}
          </pre>
        </div>
      ))}
    </div>
  );
}

function NoticeShelf({ notices, floating = false, align = "left" }: { notices: NoticeItem[]; floating?: boolean; align?: "left" | "right" }) {
  if (notices.length === 0) return null;
  return (
    <div className={`notice-shelf${floating ? " is-floating" : ""}${align === "right" ? " is-right" : ""}`}>
      {notices.map((notice, index) => {
        return (
          <div
            key={notice.id}
            className="notice-shelf-item"
            data-tone={notice.type}
            style={{
              marginBottom: index === notices.length - 1 ? 0 : 6,
              animation: notice.exiting
                ? "notice-shelf-out 0.18s ease-in forwards"
                : "notice-shelf-in 0.18s ease-out both",
            }}
          >
            <AliIcon name={notice.type === "error" || notice.type === "warning" ? "warning" : notice.type === "success" ? "check" : "info"} size={13} className="notice-shelf-icon" />
            <span className="notice-shelf-message">
              {notice.message}
            </span>
          </div>
        );
      })}
    </div>
  );
}

type ExtensionDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;

function ExtensionDialog({
  request,
  onRespond,
}: {
  request: ExtensionDialogRequest;
  onRespond: (request: ExtensionDialogRequest, response: { value: string } | { confirmed: boolean } | { cancelled: true }) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(request.method === "editor" ? request.prefill ?? "" : "");

  useEffect(() => {
    setValue(request.method === "editor" ? request.prefill ?? "" : "");
  }, [request]);

  const submitValue = () => {
    if (request.method === "confirm") {
      onRespond(request, { confirmed: true });
    } else {
      onRespond(request, { value });
    }
  };

  return (
    <div
      className="app-shell-dialog-backdrop"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 90,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.18)",
      }}
    >
      <div
        className="app-shell-dialog"
        role="dialog"
        aria-modal="true"
        style={{
          width: "min(560px, 100%)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-panel)",
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
        }}
      >
        <div className="extension-prompt-header" style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ color: "var(--text)", fontSize: "var(--text-base)", fontWeight: 650 }}>{request.title}</div>
          <div style={{ marginTop: 3, color: "var(--text-dim)", fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)" }}>{t("chat.extensionRequest")}</div>
        </div>

        <div className="extension-prompt-body" style={{ padding: 14 }}>
          {request.method === "confirm" && (
            <div style={{ color: "var(--text-muted)", fontSize: "var(--text-base)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{request.message}</div>
          )}
          {request.method === "select" && (
            <div style={{ display: "grid", gap: 8 }}>
              {request.options.map((option) => (
                <button
                  key={option}
                  className="extension-prompt-option"
                  onClick={() => onRespond(request, { value: option })}
                  style={{
                    width: "100%",
                    padding: "9px 10px",
                    borderRadius: 7,
                    border: "1px solid var(--border)",
                    background: "var(--bg-panel)",
                    color: "var(--text)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: "var(--text-base)",
                  }}
                >
                  {option}
                </button>
              ))}
            </div>
          )}
          {request.method === "input" && (
            <input
              className="extension-prompt-field"
              autoFocus
              value={value}
              placeholder={request.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitValue();
                if (e.key === "Escape") onRespond(request, { cancelled: true });
              }}
              style={{
                width: "100%",
                padding: "9px 10px",
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                fontSize: "var(--text-base)",
              }}
            />
          )}
          {request.method === "editor" && (
            <textarea
              className="extension-prompt-field"
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") onRespond(request, { cancelled: true });
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submitValue();
              }}
              style={{
                width: "100%",
                minHeight: 220,
                padding: 10,
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                resize: "vertical",
                fontSize: "var(--text-base)",
                lineHeight: 1.55,
                fontFamily: "var(--font-mono)",
              }}
            />
          )}
        </div>

        <div className="extension-prompt-footer" style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
          <button
            className="extension-prompt-button"
            onClick={() => onRespond(request, { cancelled: true })}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
             {t("chat.cancel")}
          </button>
          {request.method === "confirm" ? (
            <button
              className="extension-prompt-button is-primary"
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
               {t("chat.confirm")}
            </button>
          ) : request.method !== "select" ? (
            <button
              className="extension-prompt-button is-primary"
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
               {t("chat.submit")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type ExtensionCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;

function renderAnsiLine(line: string, keyPrefix: string): ReactNode[] {
  return parseAnsiLine(line).map((segment, index) => (
    Object.keys(segment.style).length > 0
      ? <span key={`${keyPrefix}-${index}`} style={segment.style}>{segment.text}</span>
      : segment.text
  ));
}

function ExtensionCustomPanel({
  request,
  onInput,
}: {
  request: ExtensionCustomRequest;
  onInput: (request: ExtensionCustomRequest, data: string) => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const displayLines = normalizeCustomPanelLines(request.lines);

  useEffect(() => {
    inputRef.current?.focus();
  }, [request.id]);

  return (
    <div
      className="app-shell-dialog-backdrop"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 95,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.18)",
      }}
    >
      <div
        className="app-shell-dialog"
        role="dialog"
        aria-modal="true"
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest("button")) inputRef.current?.focus();
        }}
        style={{
          position: "relative",
          width: "min(920px, 100%)",
          maxHeight: "min(760px, calc(100vh - 40px))",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-panel)",
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
          outline: "none",
        }}
      >
        <textarea
          ref={inputRef}
           aria-label={t("chat.extensionInput")}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const data = toTerminalKeyData(event);
            if (!data) return;
            event.preventDefault();
            event.stopPropagation();
            onInput(request, data);
          }}
          onInput={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const text = event.currentTarget.value;
            event.currentTarget.value = "";
            if (text) onInput(request, text);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            const input = event.currentTarget;
            queueMicrotask(() => {
              const text = input.value;
              input.value = "";
              if (text) onInput(request, text);
            });
          }}
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData("text");
            if (text) onInput(request, asBracketedPaste(text));
          }}
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            padding: 0,
            border: 0,
            opacity: 0,
            pointerEvents: "none",
          }}
        />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
           <div style={{ color: "var(--text)", fontSize: "var(--text-base)", fontWeight: 650 }}>{t("chat.extensionPanel")}</div>
          <button
            onClick={() => onInput(request, "\x03")}
            style={{
              padding: "5px 9px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: "var(--text-sm)",
            }}
          >
             {t("chat.close")}
          </button>
        </div>
        <pre
          style={{
            margin: 0,
            padding: 14,
            maxHeight: "calc(min(760px, 100vh - 40px) - 48px)",
            overflow: "auto",
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-base)",
            lineHeight: 1.45,
            whiteSpace: "pre",
          }}
        >
          {(displayLines.length ? displayLines : [""]).map((line, index, allLines) => (
            <Fragment key={index}>
              {renderAnsiLine(line, `line-${index}`)}
              {index < allLines.length - 1 ? "\n" : null}
            </Fragment>
          ))}
        </pre>
      </div>
    </div>
  );
}
