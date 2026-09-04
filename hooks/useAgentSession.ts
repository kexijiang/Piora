"use client";

import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo, useReducer } from "react";
import { invalidatePrefetchedSession, peekPrefetchedSession, takePrefetchedSession } from "@/lib/session-prefetch";
import type {
  AgentMessage,
  ExtensionStatusItem,
  ExtensionUiRequest,
  ExtensionWidgetItem,
  SessionInfo,
  SessionTreeNode,
} from "@/lib/types";
import { normalizeToolCalls } from "@/lib/normalize";
import { AgentCommandError, createAgentSessionRequest, sendAgentCommand } from "@/lib/agent-client";
import { reduceAgentPhase, type AgentPhase } from "@/lib/agent-phase";
import { useI18n } from "@/hooks/useI18n";
import type { ContextUsage, SessionStatsInfo } from "@/lib/pi-types";
import { estimateSessionContextUsage, mergeContextUsageWithEstimate } from "@/lib/context-usage";
import { isPromptMaterialRuntimeMessage, type PromptMaterialReference } from "@/lib/prompt-material-format";
import { isProjectlessChatCwd } from "@/lib/projectless-chat-path";
import { fetchModelCatalog, type ModelCatalogEntry } from "@/lib/model-catalog-client";
import {
  applySessionCapabilitySelectionToState,
  createDefaultSessionCapabilitiesState,
  type SessionCapabilitiesState,
  type SessionCapabilitySelection,
} from "@/lib/session-capabilities";
import { runModelChange } from "@/lib/model-change-coordinator";
import { useLiveOutputAutoScrollPreference } from "@/hooks/useLiveOutputAutoScrollPreference";
import { getContentScrollMetrics, getLiveTailScrollLimit } from "@/lib/chat-scroll";
import type {
  SessionSystemPromptBinding,
  SystemPromptSelection,
} from "@/lib/system-prompt-types";

export type { AgentPhase } from "@/lib/agent-phase";

export interface SessionData {
  sessionId: string;
  filePath: string;
  info?: SessionInfo | null;
  tree: SessionTreeNode[];
  leafId: string | null;
  systemPromptBinding?: SessionSystemPromptBinding | null;
  context: {
    messages: AgentMessage[];
    entryIds: string[];
    thinkingLevel: string;
    model: { provider: string; modelId: string } | null;
  };
}

interface StreamingState {
  isStreaming: boolean;
  streamingMessage: Partial<AgentMessage> | null;
}

type StreamAction =
  | { type: "start" }
  | { type: "update"; message: Partial<AgentMessage> }
  | { type: "end" }
  | { type: "reset" };

function streamReducer(state: StreamingState, action: StreamAction): StreamingState {
  switch (action.type) {
    case "start":
      return { isStreaming: true, streamingMessage: null };
    case "update":
      return { isStreaming: true, streamingMessage: action.message };
    case "end":
    case "reset":
      return { isStreaming: false, streamingMessage: null };
    default:
      return state;
  }
}

interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

interface CompactCommandResult {
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}

interface LastAssistantTextResponse {
  text?: string;
}

type AgentStateResponse = {
  contextUsage?: ContextUsage | null;
  systemPrompt?: string;
  systemPromptBinding?: SessionSystemPromptBinding | null;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isPromptRunning?: boolean;
  isBashRunning?: boolean;
  isCompacting?: boolean;
  runtime?: string;
  activeTools?: { id: string; name: string }[];
  extensionStatuses?: ExtensionStatusItem[];
  extensionWidgets?: ExtensionWidgetItem[];
  queuedMessages?: { steering?: string[]; followUp?: string[] } | null;
  capabilities?: SessionCapabilitiesState;
};

export interface QueuedMessages {
  steering: string[];
  followUp: string[];
}

function normalizeQueuedMessages(q?: { steering?: string[]; followUp?: string[] } | null): QueuedMessages {
  return { steering: q?.steering ?? [], followUp: q?.followUp ?? [] };
}

function appendQueuedMessage(current: QueuedMessages, kind: keyof QueuedMessages, message: string): QueuedMessages {
  return { ...current, [kind]: [...current[kind], message] };
}

function removeLastQueuedMessage(current: QueuedMessages, kind: keyof QueuedMessages, message: string): QueuedMessages {
  const index = current[kind].lastIndexOf(message);
  if (index === -1) return current;
  return {
    ...current,
    [kind]: [...current[kind].slice(0, index), ...current[kind].slice(index + 1)],
  };
}

type ExtensionUiDialogRequest = Extract<ExtensionUiRequest, { method: "request_user_input" | "select" | "confirm" | "input" | "editor" }>;
type ExtensionUiCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;
export type NoticeType = "info" | "success" | "warning" | "error";

export type NoticeItem = {
  id: string;
  message: string;
  type: NoticeType;
  exiting?: boolean;
};

type NoticeState = {
  visible: NoticeItem[];
  pending: NoticeItem[];
};

type NoticeAction =
  | { type: "add"; notice: NoticeItem }
  | { type: "mark_oldest_exiting" }
  | { type: "remove"; id: string };

export interface CompactResultInfo {
  reason: "manual" | "threshold" | "overflow" | "auto" | string;
  tokensBefore: number;
  estimatedTokensAfter: number;
}

export interface SlashCommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo?: {
    path: string;
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
    baseDir?: string;
  };
}

export type BuiltinSlashCommandResult =
  | { handled: false }
  | { handled: true; message?: string; error?: string; action?: "openSessionStats" };

export interface UseAgentSessionOptions {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  newSessionInitialModel?: { provider: string; modelId: string } | null;
  newSessionInitialSystemPromptSelection?: SystemPromptSelection | null;
  onAgentEnd?: (sessionId: string) => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSessionStatsPanelOpen?: () => void;
}

function selectionFromSystemPromptBinding(binding: SessionSystemPromptBinding | null): SystemPromptSelection {
  if (!binding || binding.source === "default" || !binding.templateId) return { mode: "default" };
  return { mode: "template", templateId: binding.templateId };
}

export type ThinkingLevelOption = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const PROGRAMMATIC_SCROLL_IGNORE_MS = 700;
const USER_SCROLL_INTENT_MS = 1200;
const PROMPT_SETTLE_INITIAL_DELAY_MS = 800;
const PROMPT_SETTLE_POLL_MS = 600;
const PROMPT_SETTLE_MAX_MS = 20_000;
const AGENT_STATE_RECONCILE_MS = 15_000;
const CONTEXT_USAGE_REFRESH_MS = 1_500;
const BASH_STATE_RECONCILE_MS = 1_000;
// Cold sessions create their AgentSession on the server when the events route
// or the first command arrives; that setup (model runtime + resource loader)
// can take longer than a default fetch timeout. Keep the connect window wide
// so a slow first start never fails the send.
const EVENT_STREAM_CONNECT_TIMEOUT_MS = 30_000;
const MAX_NOTICES = 5;
const NOTICE_VISIBLE_MS = 5000;
const NOTICE_EXIT_ANIMATION_MS = 180;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Space", "Spacebar"]);

type EventStreamConnectionStatus = "connected" | "timeout" | "closed";

type EventStreamConnectionResult = {
  status: EventStreamConnectionStatus;
  source: EventSource;
};

class EventStreamConnectionError extends Error {
  constructor(public readonly status: Exclude<EventStreamConnectionStatus, "connected">) {
    super(status === "timeout"
      ? "Timed out connecting to the agent event stream. Please try again."
      : "Failed to connect to the agent event stream. Please try again.");
    this.name = "EventStreamConnectionError";
  }
}

function createNoticeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function markOldestNoticeExiting(notices: NoticeItem[]): NoticeItem[] {
  const index = notices.findIndex((notice) => !notice.exiting);
  if (index === -1) return notices;
  return notices.map((notice, i) => (
    i === index ? { ...notice, exiting: true } : notice
  ));
}

function fillPendingNotices(visible: NoticeItem[], pending: NoticeItem[]): NoticeState {
  let nextVisible = visible;
  let nextPending = pending;
  while (nextPending.length > 0 && nextVisible.length < MAX_NOTICES) {
    const [next, ...rest] = nextPending;
    nextVisible = [...nextVisible, next];
    nextPending = rest;
  }
  if (nextPending.length > 0 && !nextVisible.some((notice) => notice.exiting)) {
    nextVisible = markOldestNoticeExiting(nextVisible);
  }
  return { visible: nextVisible, pending: nextPending };
}

function noticeReducer(state: NoticeState, action: NoticeAction): NoticeState {
  switch (action.type) {
    case "add": {
      if (state.visible.some((notice) => notice.exiting) || state.visible.length >= MAX_NOTICES) {
        return {
          visible: state.visible.some((notice) => notice.exiting)
            ? state.visible
            : markOldestNoticeExiting(state.visible),
          pending: [...state.pending, action.notice],
        };
      }
      return { ...state, visible: [...state.visible, action.notice] };
    }
    case "mark_oldest_exiting":
      return { ...state, visible: markOldestNoticeExiting(state.visible) };
    case "remove": {
      const visible = state.visible.filter((notice) => notice.id !== action.id);
      return fillPendingNotices(visible, state.pending);
    }
    default:
      return state;
  }
}

function extractMessageText(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object"
        && (block as { type?: string }).type === "text"
        && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "")
    .filter(Boolean)
    .join("\n");
}

function imageSignature(block: unknown): string {
  if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "image") return "";
  const source = (block as { source?: unknown }).source;
  if (source && typeof source === "object") {
    const src = source as { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
    return [
      src.type === "url" ? "url" : "base64",
      typeof src.media_type === "string" ? src.media_type : "",
      typeof src.data === "string" ? src.data : "",
      typeof src.url === "string" ? src.url : "",
    ].join(":");
  }
  const flat = block as { data?: unknown; mimeType?: unknown };
  return [
    "base64",
    typeof flat.mimeType === "string" ? flat.mimeType : "",
    typeof flat.data === "string" ? flat.data : "",
    "",
  ].join(":");
}

function userMessageKey(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return JSON.stringify({ text: content, images: [] });
  if (!Array.isArray(content)) return JSON.stringify({ text: "", images: [] });
  return JSON.stringify({
    text: extractMessageText(message),
    images: content.map(imageSignature).filter(Boolean),
  });
}

function readCompactResult(result: unknown, reason: string): CompactResultInfo | null {
  if (!result || typeof result !== "object") return null;
  const r = result as CompactCommandResult;
  if (typeof r.tokensBefore !== "number" || typeof r.estimatedTokensAfter !== "number") return null;
  return { reason, tokensBefore: r.tokensBefore, estimatedTokensAfter: r.estimatedTokensAfter };
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (content: string) => void;
  prependText: (text: string) => void;
  addImages: (files: File[]) => void;
  restoreFailedPrompt: (text: string, files?: AttachedFile[], images?: AttachedImage[]) => void;
}

export interface AttachedImage {
  data: string;
  mimeType: string;
  previewUrl: string;
}

/** A non-image file attached from the composer. `text` is uploaded as a
 * prompt material; binary files only contribute their name. */
export interface AttachedFile {
  name: string;
  size: number;
  text: string | null;
  kind?: "file" | "paste";
}

function userMessageHasPromptMaterialMarker(message: AgentMessage): boolean {
  if (message.role !== "user") return false;
  if (isPromptMaterialRuntimeMessage(message.content)) return true;
  return Array.isArray(message.content) && message.content.some((block) => (
    block.type === "text" && isPromptMaterialRuntimeMessage(block.text)
  ));
}

async function sessionResponseError(response: Response): Promise<Error> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  const detail = typeof body?.error === "string" && body.error.trim() ? `: ${body.error}` : "";
  return new Error(`HTTP ${response.status}${detail}`);
}

async function uploadPromptMaterialFiles(files: AttachedFile[]): Promise<PromptMaterialReference[]> {
  if (!files.length) return [];
  const response = await fetch("/api/prompt-materials", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      materials: files.map((file) => ({ name: file.name, content: file.text ?? "" })),
    }),
  });
  const body = await response.json().catch(() => ({})) as {
    materials?: Array<{ id?: unknown }>;
    error?: unknown;
  };
  if (!response.ok || !Array.isArray(body.materials)) {
    throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
  }
  const references = body.materials
    .filter((material): material is { id: string } => typeof material.id === "string")
    .map(({ id }) => ({ id }));
  if (references.length !== files.length) throw new Error("Prompt material upload returned an incomplete result.");
  return references;
}

type SelectedModel = { provider: string; modelId: string };
type ModelEntry = ModelCatalogEntry;

type SlashCommandsResponse = {
  commands?: SlashCommandInfo[];
};

export function useAgentSession(opts: UseAgentSessionOptions) {
  const { t } = useI18n();
  const {
    session, newSessionCwd, newSessionInitialModel, newSessionInitialSystemPromptSelection, onAgentEnd, onSessionCreated, onSessionForked,
    modelsRefreshKey, onBranchDataChange, onSystemPromptChange, onSessionStatsPanelOpen,
  } = opts;

  const isNew = session === null && newSessionCwd !== null;
  const { enabled: liveOutputAutoScrollEnabled } = useLiveOutputAutoScrollPreference();

  // Task rows prefetch on hover/pointer-down. Seed the remounted chat from a
  // completed snapshot so a normal switch never paints the full loading shell
  // before showing content that is already available in memory.
  const [initialSessionData] = useState<SessionData | null>(() => (
    session ? peekPrefetchedSession(session) as SessionData | null : null
  ));

  const [data, setData] = useState<SessionData | null>(initialSessionData);
  const [loading, setLoading] = useState(!isNew && initialSessionData === null);
  const [error, setError] = useState<string | null>(null);
  const [activeLeafId, setActiveLeafId] = useState<string | null>(initialSessionData?.leafId ?? null);
  const [messages, setMessages] = useState<AgentMessage[]>(initialSessionData?.context.messages ?? []);
  const [entryIds, setEntryIds] = useState<string[]>(initialSessionData?.context.entryIds ?? []);
  const [streamState, dispatch] = useReducer(streamReducer, { isStreaming: false, streamingMessage: null });
  const [agentRunning, setAgentRunning] = useState(false);
  const [liveOutputFollowPaused, setLiveOutputFollowPaused] = useState(false);
  const [bashRunning, setBashRunning] = useState(false);
  const [pendingBash, setPendingBash] = useState<{ command: string; excludeFromContext: boolean } | null>(null);
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [modelList, setModelList] = useState<ModelEntry[]>([]);
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelThinkingLevels, setModelThinkingLevels] = useState<Record<string, string[]>>({});
  const [modelThinkingLevelMaps, setModelThinkingLevelMaps] = useState<Record<string, Record<string, string | null>>>({});
  const [newSessionModel, setNewSessionModel] = useState<SelectedModel | null>(() => newSessionInitialModel ?? null);
  const [newSessionDefaultModel, setNewSessionDefaultModel] = useState<SelectedModel | null>(null);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevelOption>("auto");
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>(null);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [systemPromptBinding, setSystemPromptBinding] = useState<SessionSystemPromptBinding | null>(initialSessionData?.systemPromptBinding ?? null);
  const [systemPromptSelection, setSystemPromptSelection] = useState<SystemPromptSelection>(() => (
    newSessionInitialSystemPromptSelection ?? selectionFromSystemPromptBinding(initialSessionData?.systemPromptBinding ?? null)
  ));
  const [systemPromptSaving, setSystemPromptSaving] = useState(false);
  const [forkingEntryId, setForkingEntryId] = useState<string | null>(null);
  const [currentModelOverride, setCurrentModelOverride] = useState<{ provider: string; modelId: string } | null>(null);
  const [pendingModel, setPendingModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [compactResult, setCompactResult] = useState<CompactResultInfo | null>(null);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>(null);
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
  const [slashCommandsLoading, setSlashCommandsLoading] = useState(false);
  const [noticeState, dispatchNotice] = useReducer(noticeReducer, { visible: [], pending: [] });
  const [sessionStatsOverride, setSessionStatsOverride] = useState<SessionStatsInfo | null>(null);
  const [extensionDialog, setExtensionDialog] = useState<ExtensionUiDialogRequest | null>(null);
  const [extensionCustomUi, setExtensionCustomUi] = useState<ExtensionUiCustomRequest | null>(null);
  const [extensionStatuses, setExtensionStatuses] = useState<ExtensionStatusItem[]>([]);
  const [extensionWidgets, setExtensionWidgets] = useState<ExtensionWidgetItem[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessages>({ steering: [], followUp: [] });
  const [capabilities, setCapabilities] = useState<SessionCapabilitiesState>(() => createDefaultSessionCapabilitiesState());
  const [capabilitiesSaving, setCapabilitiesSaving] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  const sessionIdRef = useRef<string | null>(session?.id ?? null);
  const agentRunningRef = useRef(false);
  const bashRunningRef = useRef(false);
  const bashRecoveryIdRef = useRef(0);
  const handleAgentEventRef = useRef<((event: AgentEvent) => void) | null>(null);
  const initialScrollDoneRef = useRef(false);
  const lastUserMsgRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollToUserRef = useRef(false);
  const completionScrollAllowedRef = useRef(true);
  const liveOutputFollowRef = useRef(true);
  const executeBashRef = useRef<(command: string, excludeFromContext: boolean) => Promise<void> | undefined>(undefined);
  const userScrollIntentUntilRef = useRef(0);
  const ignoreProgrammaticScrollUntilRef = useRef(0);
  const liveTailPinnedScrollTopRef = useRef<number | null>(null);
  const initialBottomPinCleanupRef = useRef<(() => void) | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const ensuringNewSessionRef = useRef<Promise<string | null> | null>(null);
  const newSessionPromotedRef = useRef(false);
  const newSessionModelOverrideRef = useRef<SelectedModel | null>(newSessionInitialModel ?? null);
  const systemPromptSelectionRef = useRef<SystemPromptSelection>(
    newSessionInitialSystemPromptSelection ?? selectionFromSystemPromptBinding(initialSessionData?.systemPromptBinding ?? null),
  );
  const systemPromptSavingRef = useRef(false);
  const thinkingLevelOverrideRef = useRef<Exclude<ThinkingLevelOption, "auto"> | null>(null);
  const promptRunIdRef = useRef(0);
  const cancelledPromptRunIdRef = useRef<number | null>(null);
  const preparingPromptRunIdRef = useRef<number | null>(null);
  const cancelPreparedPromptRef = useRef<(() => void) | null>(null);
  const abortRequestRunIdRef = useRef<number | null>(null);
  const phaseEventRevisionRef = useRef(0);
  const promptSettlementByRunRef = useRef(new Map<number, Promise<void>>());
  const promptSettlementPollByRunRef = useRef(new Map<number, Promise<void>>());
  const sessionLoadAbortRef = useRef<AbortController | null>(null);
  const optimisticUserMessageKeyRef = useRef<string | null>(null);
  const suppressCompletionNotificationRef = useRef(false);
  const lastContextUsageRefreshAtRef = useRef(0);
  const capabilitySelectionDirtyRef = useRef(false);
  const capabilitiesRef = useRef(capabilities);
  capabilitiesRef.current = capabilities;

  const currentModel = currentModelOverride ?? data?.context.model ?? pendingModel ?? null;
  const displayModel = isNew ? (newSessionModel ?? newSessionDefaultModel) : currentModel;
  const estimatedContextUsage = useMemo(() => {
    if (!displayModel) return null;
    const contextWindow = modelList.find((entry) => (
      entry.provider === displayModel.provider && entry.id === displayModel.modelId
    ))?.contextWindow ?? 0;
    return estimateSessionContextUsage(messages, contextWindow);
  }, [displayModel, messages, modelList]);
  const effectiveContextUsage = useMemo(() => {
    return mergeContextUsageWithEstimate(contextUsage, estimatedContextUsage);
  }, [contextUsage, estimatedContextUsage]);

  const sessionStats = useMemo(() => {
    if (sessionStatsOverride) return sessionStatsOverride;
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    let cost = 0;
    let userMessages = 0;
    let assistantMessages = 0;
    let toolResults = 0;
    let toolCalls = 0;
    for (const msg of messages) {
      if (msg.role === "user") userMessages += 1;
      if (msg.role === "toolResult") toolResults += 1;
      if (msg.role !== "assistant") continue;
      assistantMessages += 1;
      const u = (msg as import("@/lib/types").AssistantMessage).usage;
      toolCalls += (msg as import("@/lib/types").AssistantMessage).content.filter((c) => c.type === "toolCall").length;
      if (!u) continue;
      tokens.input += u.input ?? 0;
      tokens.output += u.output ?? 0;
      tokens.cacheRead += u.cacheRead ?? 0;
      tokens.cacheWrite += u.cacheWrite ?? 0;
      cost += u.cost?.total ?? 0;
    }
    tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    if (tokens.total === 0 && messages.length === 0) return null;
    return {
      sessionFile: data?.filePath || undefined,
      sessionId: sessionIdRef.current ?? session?.id ?? "",
      sessionName: session?.name,
      userMessages,
      assistantMessages,
      toolCalls,
      toolResults,
      totalMessages: messages.length,
      tokens,
      cost,
      ...(effectiveContextUsage ? { contextUsage: effectiveContextUsage } : {}),
    } satisfies SessionStatsInfo;
  }, [messages, sessionStatsOverride, effectiveContextUsage, data?.filePath, session?.id, session?.name]);

  const loadSession = useCallback(async (
    sid: string,
    showLoading = false,
    includeState = false,
    prefetchedData: Promise<unknown | null> | null = null,
  ) => {
    sessionLoadAbortRef.current?.abort();
    const controller = new AbortController();
    sessionLoadAbortRef.current = controller;
    const runId = promptRunIdRef.current;
    let messagesLoaded = false;
    try {
      if (showLoading) setLoading(true);
      let d = await prefetchedData as SessionData | null;
      if (controller.signal.aborted) return null;
      if (!d) {
        const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1" });
        const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}?${params}`, {
          signal: controller.signal,
        });
        if (res.status === 404) {
          if (showLoading) {
            setData(null);
            setActiveLeafId(null);
            setMessages([]);
            setError(null);
          }
          return null;
        }
        if (!res.ok) throw await sessionResponseError(res);
        d = await res.json() as SessionData;
      }
      if (controller.signal.aborted || sessionIdRef.current !== sid || promptRunIdRef.current !== runId) return null;
      setData(d);
      setActiveLeafId(d.leafId);
      setMessages(d.context.messages);
      setEntryIds(d.context.entryIds ?? []);
      setSystemPromptBinding(d.systemPromptBinding ?? null);
      const restoredSystemPromptSelection = selectionFromSystemPromptBinding(d.systemPromptBinding ?? null);
      systemPromptSelectionRef.current = restoredSystemPromptSelection;
      setSystemPromptSelection(restoredSystemPromptSelection);
      setCurrentModelOverride(null);
      setError(null);
      if (d.context.thinkingLevel && d.context.thinkingLevel !== "off") {
        setThinkingLevel(d.context.thinkingLevel as ThinkingLevelOption);
      }

      messagesLoaded = true;
      if (showLoading && sessionLoadAbortRef.current === controller) setLoading(false);
      if (!includeState) return null;

      try {
        const stateRes = await fetch(`/api/sessions/${encodeURIComponent(sid)}/state`, {
          signal: controller.signal,
        });
        if (!stateRes.ok) throw new Error(`HTTP ${stateRes.status}`);
        const agentState = await stateRes.json() as { running: boolean; state?: AgentStateResponse };
        if (controller.signal.aborted || sessionIdRef.current !== sid || promptRunIdRef.current !== runId) return null;

        const liveState = agentState.state;
        if (liveState) {
          if (liveState.contextUsage !== undefined) setContextUsage(liveState.contextUsage ?? null);
          if (liveState.systemPrompt !== undefined) setSystemPrompt(liveState.systemPrompt ?? null);
          if (liveState.systemPromptBinding !== undefined) {
            setSystemPromptBinding(liveState.systemPromptBinding ?? null);
            const restoredSelection = selectionFromSystemPromptBinding(liveState.systemPromptBinding ?? null);
            systemPromptSelectionRef.current = restoredSelection;
            setSystemPromptSelection(restoredSelection);
          }
          if (liveState.thinkingLevel !== undefined) setThinkingLevel((liveState.thinkingLevel as ThinkingLevelOption) ?? "auto");
          if (liveState.extensionStatuses !== undefined) setExtensionStatuses(liveState.extensionStatuses ?? []);
          if (liveState.extensionWidgets !== undefined) setExtensionWidgets(liveState.extensionWidgets ?? []);
          if (liveState.queuedMessages !== undefined) setQueuedMessages(normalizeQueuedMessages(liveState.queuedMessages));
          if (liveState.capabilities !== undefined) setCapabilities(liveState.capabilities);
        } else if (!agentState.running) {
          setQueuedMessages({ steering: [], followUp: [] });
        }
        return agentState;
      } catch (e) {
        if (controller.signal.aborted) return null;
        console.error("Failed to load agent state:", e);
        return null;
      }
    } catch (e) {
      if (controller.signal.aborted) return null;
      setError(String(e));
      return null;
    } finally {
      if (sessionLoadAbortRef.current === controller) {
        sessionLoadAbortRef.current = null;
        if (showLoading && !messagesLoaded) setLoading(false);
      }
    }
  }, []);

  const loadContext = useCallback(async (sid: string, leafId: string | null) => {
    try {
      const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1" });
      if (leafId) params.set("leafId", leafId);
      const url = `/api/sessions/${encodeURIComponent(sid)}/context?${params}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as { context: { messages: AgentMessage[]; entryIds: string[] } };
      setMessages(d.context.messages);
      setEntryIds(d.context.entryIds ?? []);
    } catch (e) {
      console.error("Failed to load context:", e);
    }
  }, []);

  const promoteNewSession = useCallback((messageCount = 0, firstMessage = "") => {
    const sid = sessionIdRef.current;
    if (!isNew || !newSessionCwd || !sid || newSessionPromotedRef.current) return;
    newSessionPromotedRef.current = true;
    onSessionCreated?.({
      id: sid,
      path: "",
      cwd: newSessionCwd,
      name: undefined,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount,
      firstMessage,
      ...(isProjectlessChatCwd(newSessionCwd) ? { projectless: true } : {}),
    });
  }, [isNew, newSessionCwd, onSessionCreated]);

  const ensureNewSession = useCallback(async () => {
    if (sessionIdRef.current) return sessionIdRef.current;
    if (!isNew || !newSessionCwd) return sessionIdRef.current;
    if (ensuringNewSessionRef.current) return ensuringNewSessionRef.current;

    const promise = (async () => {
      // Only send explicit user overrides. The server resolves the current
      // enabledModels scope atomically with AgentSession construction.
      const selectedModel = newSessionModelOverrideRef.current;
      const selectedThinkingLevel = thinkingLevelOverrideRef.current;
      if (selectedModel) setPendingModel(selectedModel);
      const result = await createAgentSessionRequest({
        cwd: newSessionCwd,
        type: "ensure_session",
        ...(capabilitySelectionDirtyRef.current ? {
          capabilitySelection: {
            preset: capabilitiesRef.current.policy.preset,
            enabledCapabilityIds: capabilitiesRef.current.policy.enabledCapabilityIds,
          },
        } : {}),
        ...(selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : {}),
        ...(selectedThinkingLevel
          ? { thinkingLevel: selectedThinkingLevel }
          : {}),
        systemPromptSelection: systemPromptSelectionRef.current,
      });
      const realId = result.sessionId;
      sessionIdRef.current = realId;
      if (result.capabilities) setCapabilities(result.capabilities);
      if (result.model && newSessionModelOverrideRef.current === selectedModel) {
        setPendingModel(result.model);
        if (!selectedModel) setNewSessionDefaultModel(result.model);
      }
      if (
        result.thinkingLevel
        && thinkingLevelOverrideRef.current === selectedThinkingLevel
      ) {
        setThinkingLevel(result.thinkingLevel);
      }
      return realId;
    })();

    ensuringNewSessionRef.current = promise;
    try {
      return await promise;
    } finally {
      ensuringNewSessionRef.current = null;
    }
  }, [isNew, newSessionCwd]);

  const loadSlashCommands = useCallback(async () => {
    const sid = sessionIdRef.current ?? await ensureNewSession();
    if (!sid) {
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    }
    setSlashCommandsLoading(true);
    try {
      const data = await sendAgentCommand<SlashCommandsResponse>(sid, { type: "get_commands" });
      const commands = data?.commands ?? [];
      setSlashCommands(commands);
      return commands;
    } catch (e) {
      console.error("Failed to load slash commands:", e);
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    } finally {
      setSlashCommandsLoading(false);
    }
  }, [ensureNewSession]);

  const closeEvents = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, []);

  const connectEvents = useCallback(function connectEvents(
    sid: string,
  ): Promise<EventStreamConnectionResult> {
    closeEvents();
    const es = new EventSource(`/api/agent/${encodeURIComponent(sid)}/events`);
    eventSourceRef.current = es;

    return new Promise((resolve) => {
      let settled = false;
      const settle = (status: EventStreamConnectionStatus) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({ status, source: es });
      };
      const timeout = setTimeout(() => settle("timeout"), EVENT_STREAM_CONNECT_TIMEOUT_MS);

      es.onmessage = (e) => {
        if (eventSourceRef.current !== es) return;
        try {
          const event = JSON.parse(e.data) as AgentEvent;
          if (event.type === "connected") settle("connected");
          handleAgentEventRef.current?.(event);
        } catch {
          // ignore
        }
      };
      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) {
          // Fatal error (404/500/content-type mismatch): browser won't
          // auto-reconnect. Settle the Promise and manually reconnect for
          // already-running sessions.
          settle("closed");
          if (eventSourceRef.current === es && agentRunningRef.current) {
            eventSourceRef.current = null;
            setTimeout(() => {
              if (agentRunningRef.current && !eventSourceRef.current && sessionIdRef.current === sid) void connectEvents(sid);
            }, 1000);
          }
        }
        // Recoverable errors (CONNECTING): let EventSource auto-reconnect.
        // The timeout above resolves only to let callers decide whether this
        // connection must be ready before they continue.
      };
    });
  }, [closeEvents]);

  const ensureEventsConnected = useCallback(async (sid: string) => {
    const result = await connectEvents(sid);
    if (result.status === "connected" || result.source.readyState === EventSource.OPEN) return;
    if (eventSourceRef.current === result.source) eventSourceRef.current = null;
    result.source.close();
    throw new EventStreamConnectionError(result.status);
  }, [connectEvents]);

  const respondToExtensionUi = useCallback(async (
    request: ExtensionUiDialogRequest,
    response: { value: string } | { confirmed: boolean } | { answers: Record<string, string[]> } | { cancelled: true },
  ) => {
    const sid = sessionIdRef.current;
    setExtensionDialog((current) => current?.id === request.id ? null : current);
    if (!sid) return;
    try {
      await sendAgentCommand(sid, {
        type: "extension_ui_response",
        id: request.id,
        ...response,
      });
    } catch (e) {
      console.error("Failed to send extension UI response:", e);
    }
  }, []);

  const sendExtensionCustomInput = useCallback(async (request: ExtensionUiCustomRequest, data: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, {
        type: "extension_ui_input",
        id: request.id,
        data,
      });
    } catch (e) {
      console.error("Failed to send extension custom UI input:", e);
    }
  }, []);

  const addNotice = useCallback((notice: { id?: string; message: string; type?: NoticeType }) => {
    const message = notice.message.trim();
    if (!message) return;
    dispatchNotice({
      type: "add",
      notice: {
        id: notice.id ?? createNoticeId(),
        message,
        type: notice.type ?? "info",
      },
    });
  }, []);

  const handleSystemPromptSelection = useCallback(async (selection: SystemPromptSelection): Promise<void> => {
    if (agentRunningRef.current || bashRunningRef.current || systemPromptSavingRef.current) return;
    const previousSelection = systemPromptSelectionRef.current;
    systemPromptSelectionRef.current = selection;
    setSystemPromptSelection(selection);
    const sid = sessionIdRef.current;
    if (!sid) return;

    systemPromptSavingRef.current = true;
    setSystemPromptSaving(true);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sid)}/system-prompt`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selection }),
      });
      const data = await response.json().catch(() => ({})) as {
        binding?: SessionSystemPromptBinding;
        selection?: SystemPromptSelection;
        systemPrompt?: string | null;
        error?: string;
      };
      if (!response.ok || data.error || !data.binding || !data.selection) {
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }
      systemPromptSelectionRef.current = data.selection;
      setSystemPromptSelection(data.selection);
      setSystemPromptBinding(data.binding);
      if (data.systemPrompt !== undefined) setSystemPrompt(data.systemPrompt);
    } catch (selectionError) {
      systemPromptSelectionRef.current = previousSelection;
      setSystemPromptSelection(previousSelection);
      addNotice({
        type: "error",
        message: selectionError instanceof Error ? selectionError.message : String(selectionError),
      });
    } finally {
      systemPromptSavingRef.current = false;
      setSystemPromptSaving(false);
    }
  }, [addNotice]);

  const handleCapabilitySelection = useCallback(async (selection: SessionCapabilitySelection): Promise<void> => {
    if (agentRunningRef.current || bashRunningRef.current) return;
    const sid = sessionIdRef.current;
    if (isNew && !sid) {
      capabilitySelectionDirtyRef.current = true;
      setCapabilities((current) => applySessionCapabilitySelectionToState(current, selection));
      return;
    }
    if (!sid) return;
    setCapabilitiesSaving(true);
    try {
      const current = capabilitiesRef.current;
      const next = await sendAgentCommand<SessionCapabilitiesState>(sid, {
        type: "set_capabilities",
        preset: selection.preset,
        ...(selection.enabledCapabilityIds ? { enabledCapabilityIds: selection.enabledCapabilityIds } : {}),
        expectedRevision: current.policy.revision,
      });
      setCapabilities(next);
    } catch (capabilityError) {
      addNotice({
        type: "error",
        message: capabilityError instanceof Error ? capabilityError.message : String(capabilityError),
      });
    } finally {
      setCapabilitiesSaving(false);
    }
  }, [addNotice, isNew]);

  const handleExtensionUiRequest = useCallback((request: ExtensionUiRequest) => {
    switch (request.method) {
      case "request_user_input":
      case "select":
      case "confirm":
      case "input":
      case "editor":
        setExtensionDialog(request);
        break;
      case "notify": {
        addNotice({
          id: request.id,
          message: request.message,
          type: request.notifyType ?? "info",
        });
        break;
      }
      case "setStatus":
        setExtensionStatuses((prev) => {
          const rest = prev.filter((item) => item.key !== request.statusKey);
          return request.statusText !== undefined
            ? [...rest, { key: request.statusKey, text: request.statusText }]
            : rest;
        });
        break;
      case "setWidget":
        setExtensionWidgets((prev) => {
          const rest = prev.filter((item) => item.key !== request.widgetKey);
          return request.widgetLines
            ? [...rest, {
                key: request.widgetKey,
                lines: request.widgetLines,
                placement: request.widgetPlacement ?? "aboveEditor",
              }]
            : rest;
        });
        break;
      case "setTitle":
        if (request.title) document.title = request.title;
        break;
      case "set_editor_text":
        opts.chatInputRef?.current?.insertText(request.text);
        break;
      case "custom":
        setExtensionCustomUi((current) => {
          if (request.closed) return current?.id === request.id ? null : current;
          return request;
        });
        break;
    }
  }, [addNotice, opts.chatInputRef]);

  const finishPromptWithoutStream = useCallback((sid: string | null = sessionIdRef.current, runId = promptRunIdRef.current) => {
    // End the visible run synchronously. History/state hydration is not part
    // of cancellation and can stall independently of the model transport.
    if (promptRunIdRef.current !== runId) return Promise.resolve();
    const wasRunning = agentRunningRef.current;
    agentRunningRef.current = false;
    closeEvents();
    optimisticUserMessageKeyRef.current = null;
    if (wasRunning) {
      setAgentRunning(false);
      setAgentPhase(null);
      setRetryInfo(null);
      setIsCompacting(false);
      setExtensionDialog(null);
      setExtensionCustomUi(null);
      dispatch({ type: "end" });
      const shouldNotify = !suppressCompletionNotificationRef.current;
      suppressCompletionNotificationRef.current = false;
      if (shouldNotify && sid) onAgentEnd?.(sid);
    }
    const existing = promptSettlementByRunRef.current.get(runId);
    if (existing) return existing;
    const settlement = (async () => {
      // Bail out before loadSession too: a stale finish for a previous run
      // must not overwrite the messages of the run currently streaming.
      if (promptRunIdRef.current !== runId) return;
      if (sid) await loadSession(sid, false, true);
    })();
    promptSettlementByRunRef.current.set(runId, settlement);
    return settlement;
  }, [closeEvents, loadSession, onAgentEnd]);

  const waitForPromptSettlement = useCallback((sid: string, runId = promptRunIdRef.current) => {
    const existing = promptSettlementPollByRunRef.current.get(runId);
    if (existing) return existing;
    const polling = (async () => {
      await delay(PROMPT_SETTLE_INITIAL_DELAY_MS);
      const startedAt = Date.now();

      while (agentRunningRef.current && Date.now() - startedAt < PROMPT_SETTLE_MAX_MS) {
        if (promptRunIdRef.current !== runId) return;
        try {
          const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`, { signal: AbortSignal.timeout(10_000) });
          if (res.ok) {
            const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
            if (promptRunIdRef.current !== runId) return;
            const state = data.state;
            if (!data.running || !state || (!state.isStreaming && !state.isPromptRunning && !state.isCompacting && state.runtime !== "stopping")) {
              await finishPromptWithoutStream(sid, runId);
              return;
            }
          }
        } catch {
          // SSE remains the primary completion path.
        }
        await delay(PROMPT_SETTLE_POLL_MS);
      }
    })().finally(() => {
      if (promptSettlementPollByRunRef.current.get(runId) === polling) {
        promptSettlementPollByRunRef.current.delete(runId);
      }
    });
    promptSettlementPollByRunRef.current.set(runId, polling);
    return polling;
  }, [finishPromptWithoutStream]);

  const waitForBashSettlement = useCallback(async (sid: string) => {
    const recoveryId = bashRecoveryIdRef.current + 1;
    bashRecoveryIdRef.current = recoveryId;

    while (
      bashRunningRef.current
      && bashRecoveryIdRef.current === recoveryId
      && sessionIdRef.current === sid
    ) {
      await delay(BASH_STATE_RECONCILE_MS);
      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
        if (!res.ok) continue;
        const data = await res.json() as { state?: AgentStateResponse };
        if (data.state?.isBashRunning) continue;

        await loadSession(sid);
        if (bashRecoveryIdRef.current !== recoveryId || sessionIdRef.current !== sid) return;
        bashRunningRef.current = false;
        setBashRunning(false);
        setPendingBash(null);
        return;
      } catch {
        // Keep polling while the page is mounted; network recovery is transparent.
      }
    }
  }, [loadSession]);

  const refreshContextUsage = useCallback(async (sid: string) => {
    try {
      const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok || sessionIdRef.current !== sid) return;
      const data = await res.json() as { state?: AgentStateResponse };
      if (sessionIdRef.current !== sid) return;
      if (data.state?.contextUsage !== undefined) {
        setContextUsage(data.state.contextUsage ?? null);
      }
    } catch {
      // The next message completion or reconciliation tick will retry.
    }
  }, []);

  // Reconcile client streaming state with the server. When SSE events are
  // missed (network drop, mobile tab backgrounded, half-open connection),
  // agent_end never arrives and the UI stays in streaming state forever.
  // If the server reports idle while we still think it's running, finish
  // through the same settlement path used by non-streaming prompts.
  const reconcileAgentState = useCallback(async (sid: string) => {
    if (!agentRunningRef.current) return;
    if (preparingPromptRunIdRef.current === promptRunIdRef.current) return;
    const runId = promptRunIdRef.current;
    const phaseRevision = phaseEventRevisionRef.current;
    try {
      const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return;
      const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
      // A slow response can straddle a run boundary (previous run finished
      // and the user already started the next one while this request was in
      // flight) — everything in it is stale, drop it.
      if (promptRunIdRef.current !== runId || !agentRunningRef.current) return;
      const state = data.state;
      // Mirror compaction state unconditionally: a missed compaction_end
      // would otherwise leave the "Stop compaction" UI stuck. No state
      // (wrapper destroyed) means nothing is compacting.
      setIsCompacting(cancelledPromptRunIdRef.current === runId ? false : state?.isCompacting ?? false);
      setQueuedMessages(normalizeQueuedMessages(state?.queuedMessages));
      if (state?.capabilities !== undefined) setCapabilities(state.capabilities);
      const busy = data.running && state
        && (state.isStreaming || state.isPromptRunning || state.isCompacting || state.runtime === "stopping");
      if (state?.runtime === "stopping") setAgentPhase({ kind: "stopping" });
      else if (state?.activeTools && phaseEventRevisionRef.current === phaseRevision && cancelledPromptRunIdRef.current !== runId) {
        const tools = state.activeTools;
        setAgentPhase((phase) => tools.length
          ? { kind: "running_tools", tools }
          : phase?.kind === "running_tools" || phase?.kind === "stopping" ? { kind: "waiting_model" } : phase);
      }
      // Context usage is useful while the run is still active (especially
      // across multi-tool turns), so do not defer it until idle settlement.
      if (state?.contextUsage !== undefined) setContextUsage(state.contextUsage ?? null);
      if (busy || !agentRunningRef.current) return;
      if (state) {
        if (state.systemPrompt !== undefined) setSystemPrompt(state.systemPrompt ?? null);
        if (state.systemPromptBinding !== undefined) {
          setSystemPromptBinding(state.systemPromptBinding ?? null);
          const restoredSelection = selectionFromSystemPromptBinding(state.systemPromptBinding ?? null);
          systemPromptSelectionRef.current = restoredSelection;
          setSystemPromptSelection(restoredSelection);
        }
        if (state.extensionStatuses !== undefined) setExtensionStatuses(state.extensionStatuses ?? []);
        if (state.extensionWidgets !== undefined) setExtensionWidgets(state.extensionWidgets ?? []);
        if (state.capabilities !== undefined) setCapabilities(state.capabilities);
      }
      await finishPromptWithoutStream(sid, runId);
    } catch {
      // Network still down — the next poll / visibility / online tick retries.
    }
  }, [finishPromptWithoutStream]);

  // Recovery net for missed SSE events: while the agent is running, verify
  // against the server periodically and whenever the tab returns to the
  // foreground or the network comes back.
  useEffect(() => {
    if (!agentRunning) return;
    const reconcile = () => {
      // Read the ref on every tick: for brand-new sessions the id is
      // assigned only after ensure_session returns.
      const sid = sessionIdRef.current;
      if (sid) void reconcileAgentState(sid);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") reconcile();
    };
    const interval = setInterval(reconcile, AGENT_STATE_RECONCILE_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", reconcile);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", reconcile);
    };
  }, [agentRunning, reconcileAgentState]);

  useEffect(() => {
    agentRunningRef.current = agentRunning;
  }, [agentRunning]);

  const handleAgentEvent = useCallback((event: AgentEvent) => {
    // Stop intent wins over buffered agent_start/tool/retry events, even
    // while the abort HTTP request or server cleanup is still pending.
    if (cancelledPromptRunIdRef.current === promptRunIdRef.current) return;
    phaseEventRevisionRef.current += 1;
    switch (event.type) {
      case "agent_start":
        liveOutputFollowRef.current = true;
        setLiveOutputFollowPaused(false);
        agentRunningRef.current = true;
        setAgentRunning(true);
        setAgentPhase((phase) => reduceAgentPhase(phase, event));
        dispatch({ type: "start" });
        break;
      case "agent_end":
        // One logical prompt can emit multiple agent_end events before retrying,
        // compacting, or continuing messages queued by extension handlers.
        // Keep the stream open until prompt_done and server-idle settlement.
        if (!agentRunningRef.current && !bashRunningRef.current) break;
        setAgentPhase((phase) => reduceAgentPhase(phase, event));
        setRetryInfo(null);
        setExtensionDialog(null);
        dispatch({ type: "end" });
        break;
      case "prompt_done":
        if (!agentRunningRef.current && !bashRunningRef.current) break;
        // Extension commands can call pi.sendUserMessage(), which starts its
        // agent run asynchronously. In that case prompt_done for the command
        // arrives before agent_start for the injected message. Give that run
        // time to start and settle against server state instead of ending the
        // UI immediately and dropping its subsequent streaming events.
        if (sessionIdRef.current) {
          void waitForPromptSettlement(sessionIdRef.current, promptRunIdRef.current);
        }
        break;
      case "prompt_error":
        suppressCompletionNotificationRef.current = true;
        addNotice({ type: "error", message: (event.errorMessage as string | undefined) ?? "Command failed" });
        break;
      case "extension_error":
        suppressCompletionNotificationRef.current = true;
        addNotice({
          type: "error",
          message: (event.error as string | undefined) ?? "Extension command failed",
        });
        break;
      case "message_start":
      case "message_update": {
        // Ignore streaming events arriving after this run already finished
        // (e.g. SSE data buffered while the tab was frozen, flushed after
        // reconcile) — they would resurrect a ghost streaming bubble.
        if (!agentRunningRef.current) break;
        const msg = event.message as Partial<AgentMessage> | undefined;
        if (msg?.role === "user") {
          break;
        }
        if (msg) {
          dispatch({ type: "update", message: normalizeToolCalls(msg as AgentMessage) });
          const now = Date.now();
          if (
            msg.role === "assistant"
            && sessionIdRef.current
            && now - lastContextUsageRefreshAtRef.current >= CONTEXT_USAGE_REFRESH_MS
          ) {
            lastContextUsageRefreshAtRef.current = now;
            void refreshContextUsage(sessionIdRef.current);
          }
        }
        setAgentPhase((phase) => reduceAgentPhase(phase, event));
        break;
      }
      case "message_end": {
        // Same late-event guard: after reconcile finished this run,
        // loadSession already loaded this message from the session file —
        // appending it again would duplicate it.
        if (!agentRunningRef.current) break;
        const completed = event.message as AgentMessage | undefined;
        if (completed?.role === "assistant" && completed.stopReason === "error") {
          suppressCompletionNotificationRef.current = true;
        }
        if (completed && completed.role === "user") {
          // Delivered steering/follow-up messages surface here as user
          // messages. The run's initial prompt also emits one, but handleSend
          // already appended it optimistically. Consume only the still-adjacent
          // optimistic bubble; later same-text queue deliveries must render.
          const delivered = normalizeToolCalls(completed);
          const materializedDelivery = userMessageHasPromptMaterialMarker(delivered);
          const deliveredKey = userMessageKey(delivered);
          const optimisticKey = optimisticUserMessageKeyRef.current;
          optimisticUserMessageKeyRef.current = null;
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (optimisticKey && last?.role === "user" && userMessageKey(last) === optimisticKey) {
              if (materializedDelivery) return prev;
              return optimisticKey === deliveredKey
                ? prev
                : [...prev.slice(0, -1), delivered];
            }
            if (materializedDelivery) return prev;
            return [...prev, delivered];
          });
        } else if (completed) {
          setMessages((prev) => [...prev, normalizeToolCalls(completed)]);
        }
        dispatch({ type: "reset" });
        setAgentPhase((phase) => bashRunningRef.current ? null : reduceAgentPhase(phase, event));
        if (completed?.role === "assistant" && sessionIdRef.current) {
          void refreshContextUsage(sessionIdRef.current);
        }
        break;
      }
      case "tool_execution_start": {
        if (!agentRunningRef.current) break;
        setAgentPhase((phase) => reduceAgentPhase(phase, event));
        break;
      }
      case "tool_execution_end": {
        if (!agentRunningRef.current) break;
        setAgentPhase((phase) => reduceAgentPhase(phase, event));
        break;
      }
      case "queue_update":
        setQueuedMessages({
          steering: [...((event.steering as string[] | undefined) ?? [])],
          followUp: [...((event.followUp as string[] | undefined) ?? [])],
        });
        break;
      case "capabilities_changed":
        if (event.capabilities) setCapabilities(event.capabilities as SessionCapabilitiesState);
        break;
      case "system_prompt_reloaded":
        if (typeof event.systemPrompt === "string") setSystemPrompt(event.systemPrompt);
        break;
      case "auto_retry_start":
        setRetryInfo({ attempt: event.attempt as number, maxAttempts: event.maxAttempts as number, errorMessage: event.errorMessage as string | undefined });
        break;
      case "auto_retry_end":
        setRetryInfo(null);
        break;
      case "auto_compaction_start":
      case "compaction_start":
        setIsCompacting(true);
        setCompactError(null);
        setCompactResult(null);
        break;
      case "auto_compaction_end":
      case "compaction_end":
        setIsCompacting(false);
        if (event.errorMessage) {
          setCompactError(event.errorMessage as string);
          setCompactResult(null);
        } else if (!event.aborted) {
          setCompactResult(readCompactResult(event.result, (event.reason as string | undefined) ?? "auto"));
          if (sessionIdRef.current) loadSession(sessionIdRef.current);
        }
        break;
      case "extension_ui_request":
        handleExtensionUiRequest(event as ExtensionUiRequest);
        break;
    }
  }, [addNotice, handleExtensionUiRequest, loadSession, refreshContextUsage, waitForPromptSettlement]);
  handleAgentEventRef.current = handleAgentEvent;

  const handleSend = useCallback(async (
    message: string,
    images?: AttachedImage[],
    files?: AttachedFile[],
  ) => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage && !images?.length && !files?.length) return;
    if (agentRunningRef.current || bashRunningRef.current) return;
    const isSlashCommandPrompt = !images?.length && !files?.length && trimmedMessage.startsWith("/");

    const isBashCommand = !images?.length && !files?.length && trimmedMessage.startsWith("!");
    if (isBashCommand) {
      const isExcluded = trimmedMessage.startsWith("!!");
      const bashCmd = (isExcluded ? trimmedMessage.slice(2) : trimmedMessage.slice(1)).trim();
      if (!bashCmd) return;
      await executeBashRef.current?.(bashCmd, isExcluded);
      return;
    }

    const promptRunId = promptRunIdRef.current + 1;
    sessionLoadAbortRef.current?.abort();
    preparingPromptRunIdRef.current = promptRunId;
    cancelledPromptRunIdRef.current = null;
    const isCurrentPrompt = () => promptRunIdRef.current === promptRunId
      && cancelledPromptRunIdRef.current !== promptRunId;
    promptSettlementByRunRef.current.clear();
    promptSettlementPollByRunRef.current.clear();

    const materialFiles = (files ?? []).filter((file) => file.text != null);
    const pasteFiles = materialFiles.filter((file) => file.kind === "paste");
    const attachedTextFiles = materialFiles.filter((file) => file.kind !== "paste");
    const nameOnlyFiles = (files ?? []).filter((file) => file.text == null);
    const fileTexts = nameOnlyFiles.map((file) => `附件: ${file.name}（二进制文件，仅提供文件名）`).join("\n\n");
    const effectiveMessage = fileTexts ? `${fileTexts}\n\n${message}` : message;
    const displayMessage = [
      effectiveMessage.trim(),
      ...attachedTextFiles.map((file) => `附件: ${file.name}（${file.size} 字节）`),
      ...pasteFiles.map((file) => file.text!.trim()),
    ]
      .filter(Boolean)
      .join("\n\n");

    const imageBlocks = images?.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mimeType, data: img.data } }));
    const userMsg: AgentMessage = {
      role: "user",
      content: imageBlocks?.length
        ? [...(displayMessage ? [{ type: "text" as const, text: displayMessage }] : []), ...imageBlocks]
        : displayMessage,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    optimisticUserMessageKeyRef.current = userMessageKey(userMsg);
    cancelPreparedPromptRef.current = () => {
      setMessages((current) => current.map((entry) => entry === userMsg ? { ...entry, sendError: t("chat.sendCancelled") } : entry));
      opts.chatInputRef?.current?.restoreFailedPrompt(message, files, images);
    };
    promptRunIdRef.current = promptRunId;
    suppressCompletionNotificationRef.current = false;
    agentRunningRef.current = true;
    setAgentRunning(true);
    setAgentPhase(isSlashCommandPrompt ? { kind: "running_command" } : { kind: "waiting_model" });
    dispatch({ type: "start" });
    pendingScrollToUserRef.current = true;
    completionScrollAllowedRef.current = true;
    liveOutputFollowRef.current = true;
    setLiveOutputFollowPaused(false);

    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    let sentSessionId: string | null = null;
    let promptRequestStarted = false;

    try {
      const promptMaterials = materialFiles.length ? await uploadPromptMaterialFiles(materialFiles) : [];
      if (!isCurrentPrompt()) return;
      if (isNew && newSessionCwd) {
        const existingSid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
        const sid = existingSid ?? await ensureNewSession();
        if (!isCurrentPrompt()) return;

        if (sid) {
          sentSessionId = sid;
          promoteNewSession(0, displayMessage.slice(0, 2_000));
          await ensureEventsConnected(sid);
          if (!isCurrentPrompt()) return;
          preparingPromptRunIdRef.current = null;
          cancelPreparedPromptRef.current = null;
          promptRequestStarted = true;
          await sendAgentCommand(sid, {
            type: "prompt",
            message: effectiveMessage,
            ...(promptMaterials.length ? { materials: promptMaterials } : {}),
            ...(piImages?.length ? { images: piImages } : {}),
          });
        }
      } else if (session) {
        sentSessionId = session.id;
        await ensureEventsConnected(session.id);
        if (!isCurrentPrompt()) return;
        preparingPromptRunIdRef.current = null;
        cancelPreparedPromptRef.current = null;
        promptRequestStarted = true;
        await sendAgentCommand(session.id, {
          type: "prompt",
          message: effectiveMessage,
          ...(promptMaterials.length ? { materials: promptMaterials } : {}),
          ...(piImages?.length ? { images: piImages } : {}),
        });
      }
      if (isCurrentPrompt() && isSlashCommandPrompt && sentSessionId) {
        void waitForPromptSettlement(sentSessionId, promptRunId);
      }
    } catch (e) {
      if (!isCurrentPrompt()) return;
      console.error("Failed to send message:", e);
      // A failed prompt POST is ambiguous: the server may have accepted it
      // before the response connection was lost. Keep SSE alive until the
      // server confirms idle so a real run cannot continue unseen.
      const definitivelyRejected = e instanceof AgentCommandError && e.status >= 400 && e.status < 500;
      if (promptRequestStarted && sentSessionId && !definitivelyRejected) {
        void waitForPromptSettlement(sentSessionId, promptRunId);
        return;
      }
      agentRunningRef.current = false;
      closeEvents();
      const optimisticKey = optimisticUserMessageKeyRef.current;
      const sendError = e instanceof EventStreamConnectionError
        ? e.message
        : e instanceof Error ? e.message : String(e);
      if (optimisticKey) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          return last?.role === "user" && userMessageKey(last) === optimisticKey
            ? [...prev.slice(0, -1), { ...last, sendError }]
            : prev;
        });
      }
      // Surface startup, session, and event-stream failures instead of leaving
      // the composer apparently inert. The prompt never reached the agent in
      // this branch, so put the text back without clobbering newer input.
      addNotice({
        type: "error",
        message: sendError,
      });
      opts.chatInputRef?.current?.restoreFailedPrompt(message, files, images);
      optimisticUserMessageKeyRef.current = null;
      setAgentRunning(false);
      setAgentPhase(null);
      dispatch({ type: "end" });
    } finally {
      if (preparingPromptRunIdRef.current === promptRunId) {
        preparingPromptRunIdRef.current = null;
        cancelPreparedPromptRef.current = null;
      }
    }
  }, [isNew, newSessionCwd, session, ensureNewSession, ensureEventsConnected, promoteNewSession, waitForPromptSettlement, addNotice, closeEvents, opts.chatInputRef, t]);

  const executeBash = useCallback(async (command: string, excludeFromContext: boolean) => {
    if (agentRunningRef.current || bashRunningRef.current) return;
    const inputText = `${excludeFromContext ? "!!" : "!"}${command}`;
    bashRunningRef.current = true;
    setPendingBash({ command, excludeFromContext });
    setBashRunning(true);
    try {
      const sid = sessionIdRef.current ?? session?.id ?? await ensureNewSession();
      if (!sid) throw new Error("Unable to create a session for the shell command");
      await ensureEventsConnected(sid);
      await sendAgentCommand(sid, {
        type: "bash",
        command,
        excludeFromContext,
      });
      await loadSession(sid);
      promoteNewSession(1, inputText);
    } catch (e) {
      console.error("Failed to execute shell command:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      opts.chatInputRef?.current?.insertIfEmpty(inputText);
    } finally {
      bashRunningRef.current = false;
      setPendingBash(null);
      setBashRunning(false);
      closeEvents();
    }
  }, [addNotice, closeEvents, ensureEventsConnected, ensureNewSession, loadSession, opts.chatInputRef, promoteNewSession, session]);
  executeBashRef.current = executeBash;

  const handleAbort = useCallback(async () => {
    const sid = sessionIdRef.current;
    const runId = promptRunIdRef.current;
    if (abortRequestRunIdRef.current === runId) return;
    suppressCompletionNotificationRef.current = true;
    if (bashRunningRef.current) {
      if (!sid) return;
      try {
        await sendAgentCommand(sid, { type: "abort_bash" }, { timeoutMs: 10_000 });
      } catch (e) {
        addNotice({ type: "error", message: t("chat.stopFailed", { reason: e instanceof Error ? e.message : String(e) }) });
      }
      return;
    }
    if (!agentRunningRef.current) return;
    cancelledPromptRunIdRef.current = runId;
    setAgentPhase({ kind: "stopping" });
    setRetryInfo(null);
    setIsCompacting(false);
    setExtensionDialog(null);
    setExtensionCustomUi(null);
    if (preparingPromptRunIdRef.current === runId) {
      cancelPreparedPromptRef.current?.();
      cancelPreparedPromptRef.current = null;
      void finishPromptWithoutStream(null, runId);
      return;
    }
    if (!sid) return;
    abortRequestRunIdRef.current = runId;
    try {
      await sendAgentCommand(sid, { type: "abort" }, { timeoutMs: 10_000 });
      // The server acknowledges as soon as the SDK cancellation signal has
      // been delivered. End the local stream now instead of waiting for slow
      // model-transport or extension cleanup to emit prompt_done.
      if (promptRunIdRef.current !== runId) return;
      setQueuedMessages({ steering: [], followUp: [] });
      void finishPromptWithoutStream(sid, runId);
    } catch (e) {
      if (promptRunIdRef.current !== runId) return;
      addNotice({ type: "error", message: t("chat.stopFailed", { reason: e instanceof Error ? e.message : String(e) }) });
    } finally {
      if (abortRequestRunIdRef.current === runId) abortRequestRunIdRef.current = null;
    }
  }, [addNotice, finishPromptWithoutStream, t]);

  const handleFork = useCallback(async (entryId: string) => {
    if (bashRunningRef.current) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    setForkingEntryId(entryId);
    try {
      const result = await sendAgentCommand<{ cancelled?: boolean; newSessionId?: string }>(sid, {
        type: "fork",
        entryId,
      });
      const { cancelled, newSessionId } = result ?? {};
      if (!cancelled && newSessionId) {
        onSessionForked?.(newSessionId);
      }
    } catch (e) {
      console.error("Fork failed:", e);
    } finally {
      setForkingEntryId(null);
    }
  }, [onSessionForked]);

  const handleNavigate = useCallback(async (entryId: string) => {
    if (bashRunningRef.current) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    sendAgentCommand(sid, { type: "navigate_tree", targetId: entryId }).catch(() => {});
    setActiveLeafId(entryId);
    await loadContext(sid, entryId);
  }, [loadContext]);

  const handleLeafChange = useCallback(async (leafId: string | null) => {
    if (bashRunningRef.current) return;
    setActiveLeafId(leafId);
    const sid = sessionIdRef.current;
    if (!sid) return;
    await loadContext(sid, leafId);
    if (leafId) {
      sendAgentCommand(sid, { type: "navigate_tree", targetId: leafId }).catch(() => {});
    }
  }, [loadContext]);

  const handleModelChange = useCallback(async (provider: string, modelId: string): Promise<boolean> => {
    if (isNew) {
      const selectedModel = { provider, modelId };
      const previousOverride = newSessionModelOverrideRef.current;
      const previousDisplayModel = previousOverride ?? newSessionDefaultModel;
      newSessionModelOverrideRef.current = selectedModel;
      setNewSessionModel(selectedModel);
      setPendingModel(selectedModel);
      const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
      if (!sid) return true;
      return runModelChange(
        async () => {
          await sendAgentCommand(sid, { type: "set_model", provider, modelId });
        },
        (e) => {
          console.error("Failed to set model:", e);
          if (newSessionModelOverrideRef.current === selectedModel) {
            newSessionModelOverrideRef.current = previousOverride;
            setNewSessionModel(previousOverride);
            setPendingModel(previousDisplayModel);
            addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
          }
        },
      );
    }
    const sid = sessionIdRef.current;
    if (!sid) return false;
    return runModelChange(
      async () => {
        await sendAgentCommand(sid, { type: "set_model", provider, modelId });
        setCurrentModelOverride({ provider, modelId });
      },
      (e) => {
        console.error("Failed to set model:", e);
        addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      },
    );
  }, [addNotice, isNew, newSessionDefaultModel, setNewSessionModel]);

  const handleCompact = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || isCompacting) return;
    setIsCompacting(true);
    setCompactError(null);
    setCompactResult(null);
    try {
      const result = await sendAgentCommand<CompactCommandResult>(sid, { type: "compact" });
      setCompactResult(readCompactResult(result, "manual"));
      await loadSession(sid, true);
    } catch (e) {
      setCompactError(e instanceof Error ? e.message : String(e));
      setCompactResult(null);
    } finally {
      setIsCompacting(false);
    }
  }, [isCompacting, loadSession]);

  const loadModels = useCallback(async (signal?: AbortSignal) => {
    const modelCwd = newSessionCwd ?? session?.cwd ?? "";
    const d = await fetchModelCatalog({
      ...(modelCwd ? { cwd: modelCwd } : {}),
      ...(signal ? { signal } : {}),
    });
    setModelNames(d.models);
    setModelError(d.modelError ?? null);
    setModelThinkingLevels(d.thinkingLevels ?? {});
    setModelThinkingLevelMaps(d.thinkingLevelMaps ?? {});
    const nextModelList = d.modelList ?? [];
    setModelList(nextModelList);
    if (isNew && !sessionIdRef.current) {
      const match = d.defaultModel
        ? nextModelList.find((m) => m.id === d.defaultModel?.modelId && m.provider === d.defaultModel?.provider)
        : undefined;
      const displayModel = match ?? nextModelList[0];
      setNewSessionDefaultModel(displayModel ? { provider: displayModel.provider, modelId: displayModel.id } : null);
      // An `enabledModels` pattern may pin a thinking level (`anthropic/*:high`).
      // Like pi, apply it to the model a new session starts with.
      const pinned = displayModel && d.thinkingLevelPins?.[`${displayModel.provider}/${displayModel.id}`];
      if (thinkingLevelOverrideRef.current === null) {
        setThinkingLevel((pinned as ThinkingLevelOption | undefined) ?? "auto");
      }
    }
  }, [isNew, newSessionCwd, session?.cwd]);

  const handleBuiltinSlashCommand = useCallback(async (text: string): Promise<BuiltinSlashCommandResult> => {
    if (!text.startsWith("/")) return { handled: false };
    const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (!match) return { handled: false };

    const [, commandName, rawArgs = ""] = match;
    const args = rawArgs.trim();
    const sid = sessionIdRef.current ?? await ensureNewSession();
    const complete = (result: BuiltinSlashCommandResult): BuiltinSlashCommandResult => {
      if (!result.handled) return result;
      if (result.error) {
        addNotice({ type: "error", message: result.error });
      } else if (result.action !== "openSessionStats") {
        addNotice({ type: "success", message: result.message ?? "Command completed" });
      }
      return result;
    };

    try {
      switch (commandName) {
        case "compact": {
          if (!sid || isCompacting) return complete({ handled: true, error: "No active session to compact" });
          setIsCompacting(true);
          setCompactError(null);
          setCompactResult(null);
          const result = await sendAgentCommand<CompactCommandResult>(sid, {
            type: "compact",
            ...(args ? { customInstructions: args } : {}),
          });
          setCompactResult(readCompactResult(result, "manual"));
          if (await loadSession(sid, true)) promoteNewSession();
          return complete({ handled: true, message: "Compacted context" });
        }

        case "reload": {
          if (!sid) return complete({ handled: true, error: "No active session to reload" });
          await sendAgentCommand(sid, { type: "reload" });
          const [, , , refreshedCapabilities] = await Promise.all([
            loadSession(sid, false, true),
            loadSlashCommands(),
            loadModels(),
            sendAgentCommand<SessionCapabilitiesState>(sid, { type: "get_capabilities" }),
          ]);
          setCapabilities(refreshedCapabilities);
          return complete({ handled: true, message: "Reloaded session resources" });
        }

        case "name": {
          if (!sid) return complete({ handled: true, error: "No active session to name" });
          if (!args) return complete({ handled: true, error: "Usage: /name <name>" });
          await sendAgentCommand(sid, { type: "set_session_name", name: args });
          if (await loadSession(sid)) promoteNewSession();
          return complete({ handled: true, message: `Session renamed to ${args}` });
        }

        case "session": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const stats = await sendAgentCommand<SessionStatsInfo>(sid, { type: "get_session_stats" });
          if (stats) {
            setSessionStatsOverride(stats);
          }
          onSessionStatsPanelOpen?.();
          return complete({ handled: true, action: "openSessionStats" });
        }

        case "copy": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const data = await sendAgentCommand<LastAssistantTextResponse>(sid, { type: "get_last_assistant_text" });
          const textToCopy = data?.text ?? "";
          if (!textToCopy) return complete({ handled: true, error: "No assistant message to copy" });
          await navigator.clipboard.writeText(textToCopy);
          return complete({ handled: true, message: "Copied last assistant message" });
        }

        default:
          return { handled: false };
      }
    } catch (e) {
      return complete({ handled: true, error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (commandName === "compact") setIsCompacting(false);
    }
  }, [addNotice, ensureNewSession, isCompacting, loadModels, loadSession, loadSlashCommands, promoteNewSession, onSessionStatsPanelOpen]);

  // Queued (undelivered) messages live in the queue panel only; the chat gets
  // the real user message when pi delivers it (user message_end event). An
  // optimistic chat bubble here would duplicate the queue panel and turn into
  // a ghost message if the queue is recalled.
  const handleSteer = useCallback(async (message: string, images?: AttachedImage[]) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    setQueuedMessages((current) => appendQueuedMessage(current, "steering", message));
    try {
      await sendAgentCommand(sid, {
        type: "steer",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      setQueuedMessages((current) => removeLastQueuedMessage(current, "steering", message));
      console.error("Failed to steer:", e);
    }
  }, []);

  const handlePromptWithStreamingBehavior = useCallback(async (
    message: string,
    behavior: "steer" | "followUp",
    images?: AttachedImage[],
  ) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    const queueKind = behavior === "steer" ? "steering" : "followUp";
    setQueuedMessages((current) => appendQueuedMessage(current, queueKind, message));
    try {
      await sendAgentCommand(sid, {
        type: "prompt",
        message,
        streamingBehavior: behavior,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      setQueuedMessages((current) => removeLastQueuedMessage(current, queueKind, message));
      console.error("Failed to queue prompt:", e);
    }
  }, []);

  const handleFollowUp = useCallback(async (message: string, images?: AttachedImage[]) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    setQueuedMessages((current) => appendQueuedMessage(current, "followUp", message));
    try {
      await sendAgentCommand(sid, {
        type: "follow_up",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      setQueuedMessages((current) => removeLastQueuedMessage(current, "followUp", message));
      console.error("Failed to follow up:", e);
    }
  }, []);

  const handleAbortCompaction = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "abort_compaction" });
    } catch (e) {
      console.error("Failed to abort compaction:", e);
    }
  }, []);

  const handleRecallQueue = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      const result = await sendAgentCommand<{ steering?: string[]; followUp?: string[] }>(sid, { type: "clear_queue" });
      // clearQueue also emits an empty queue_update, but that only reaches us
      // while SSE is connected — clear locally so idle recalls update the UI.
      setQueuedMessages({ steering: [], followUp: [] });
      const texts = [...(result?.steering ?? []), ...(result?.followUp ?? [])];
      if (texts.length > 0) {
        opts.chatInputRef?.current?.prependText(texts.join("\n\n"));
      }
    } catch (e) {
      console.error("Failed to recall queued messages:", e);
      addNotice({ type: "error", message: "Failed to recall queued messages" });
    }
  }, [opts.chatInputRef, addNotice]);

  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    setThinkingLevel(level);
    if (isNew && !sessionIdRef.current) {
      thinkingLevelOverrideRef.current = level === "auto" ? null : level;
    }
    if (level === "auto") return; // "auto" leaves pi's current setting untouched
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_thinking_level", level });
    } catch (e) {
      console.error("Failed to set thinking level:", e);
    }
  }, [isNew]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
    const container = scrollContainerRef.current;
    if (!container) return;
    // The live-tail spacer is a scrolling aid, not message content, so jumping
    // to the container bottom would land on a blank viewport. Scroll to the
    // real content bottom instead: the last message sits at the viewport
    // bottom, and when the conversation is shorter than the viewport the
    // content stays pinned to the top (max(0, …)).
    const spacer = container.querySelector<HTMLElement>("[data-chat-tail-spacer]");
    const spacerHeight = spacer?.offsetHeight ?? 0;
    const metrics = getContentScrollMetrics({
      scrollHeight: container.scrollHeight,
      scrollTop: container.scrollTop,
      clientHeight: container.clientHeight,
      transientTailHeight: spacerHeight,
    });
    liveTailPinnedScrollTopRef.current = spacer ? metrics.maxScrollTop : null;
    container.scrollTo({
      top: metrics.maxScrollTop,
      behavior,
    });
  }, []);

  const stopInitialBottomPin = useCallback(() => {
    initialBottomPinCleanupRef.current?.();
  }, []);

  const startInitialBottomPin = useCallback(() => {
    stopInitialBottomPin();
    const container = scrollContainerRef.current;
    if (!container) return;

    let frame = 0;
    let stopped = false;
    const pinToBottom = () => {
      frame = 0;
      if (!stopped) scrollToBottom("instant");
    };
    const schedulePin = () => {
      if (stopped || frame !== 0) return;
      frame = requestAnimationFrame(pinToBottom);
    };
    const resizeObserver = new ResizeObserver(schedulePin);
    resizeObserver.observe(container);
    const content = container.firstElementChild;
    if (content) resizeObserver.observe(content);
    // Lazy markdown images can finish after the first layout/resize pass.
    container.addEventListener("load", schedulePin, true);

    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      resizeObserver.disconnect();
      container.removeEventListener("load", schedulePin, true);
      if (frame !== 0) cancelAnimationFrame(frame);
      if (initialBottomPinCleanupRef.current === cleanup) {
        initialBottomPinCleanupRef.current = null;
      }
    };
    initialBottomPinCleanupRef.current = cleanup;

    // Set the position synchronously, then verify it after layout. The observer
    // keeps it correct while markdown, Mermaid, fonts, or lazy media settle.
    pinToBottom();
    schedulePin();
  }, [scrollToBottom, stopInitialBottomPin]);

  const handleScrollToBottom = useCallback(() => {
    stopInitialBottomPin();
    completionScrollAllowedRef.current = true;
    liveOutputFollowRef.current = true;
    setLiveOutputFollowPaused(false);
    scrollToBottom("smooth");
  }, [scrollToBottom, stopInitialBottomPin]);

  const scrollUserMsgToTop = useCallback(() => {
    stopInitialBottomPin();
    const container = scrollContainerRef.current;
    const el = lastUserMsgRef.current;
    if (!container || !el) return;
    const elAbsTop = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    const targetScrollTop = Math.max(0, elAbsTop - 16);
    liveTailPinnedScrollTopRef.current = targetScrollTop;
    ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
    container.scrollTo({ top: targetScrollTop, behavior: "smooth" });
  }, [stopInitialBottomPin]);

  const clampLiveTailScroll = useCallback((): boolean => {
    const container = scrollContainerRef.current;
    if (!container) return false;
    const spacer = container.querySelector<HTMLElement>("[data-chat-tail-spacer]");
    if (!spacer) {
      liveTailPinnedScrollTopRef.current = null;
      return false;
    }
    const maxScrollTop = getLiveTailScrollLimit({
      scrollHeight: container.scrollHeight,
      scrollTop: container.scrollTop,
      clientHeight: container.clientHeight,
      transientTailHeight: spacer.offsetHeight,
      pinnedScrollTop: liveTailPinnedScrollTopRef.current,
    });
    if (container.scrollTop <= maxScrollTop + 1) return false;
    ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
    container.scrollTop = maxScrollTop;
    return true;
  }, []);

  const markUserScrollIntent = useCallback((event: Event) => {
    if (event instanceof KeyboardEvent) {
      if (!SCROLL_KEYS.has(event.key)) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable='true']")) return;
    }
    stopInitialBottomPin();
    userScrollIntentUntilRef.current = Date.now() + USER_SCROLL_INTENT_MS;
    const target = event.target instanceof Element ? event.target : null;
    const isConversationViewport = Boolean(target?.closest("#chat-scroll-container, .chat-column-scroll-rail"));
    const isDirectScrollIntent = event instanceof KeyboardEvent
      || (event instanceof WheelEvent && isConversationViewport)
      || (event instanceof TouchEvent && isConversationViewport)
      || (event instanceof PointerEvent && Boolean(target?.closest(".chat-column-scroll-rail")));
    if (liveOutputAutoScrollEnabled && agentRunningRef.current && isDirectScrollIntent) {
      liveOutputFollowRef.current = false;
      setLiveOutputFollowPaused(true);
    }
  }, [liveOutputAutoScrollEnabled, stopInitialBottomPin]);

  const handleScrollPositionChange = useCallback(() => {
    if (clampLiveTailScroll()) return;
    if (!agentRunningRef.current) return;
    if (Date.now() < ignoreProgrammaticScrollUntilRef.current) return;
    if (Date.now() > userScrollIntentUntilRef.current) return;
    completionScrollAllowedRef.current = false;
    if (liveOutputAutoScrollEnabled) {
      liveOutputFollowRef.current = false;
      setLiveOutputFollowPaused(true);
    }
  }, [clampLiveTailScroll, liveOutputAutoScrollEnabled]);

  // Load session on mount
  useEffect(() => {
    if (session) {
      sessionIdRef.current = session.id;
      loadSession(session.id, initialSessionData === null, true, takePrefetchedSession(session)).then((agentState) => {
        if (agentState?.running) {
          invalidatePrefetchedSession(session.id);
          if (agentState.state?.isStreaming || agentState.state?.isPromptRunning || agentState.state?.runtime === "stopping") {
            agentRunningRef.current = true;
            setAgentRunning(true);
            setAgentPhase(agentState.state.runtime === "stopping" ? { kind: "stopping" }
              : agentState.state.activeTools?.length ? { kind: "running_tools", tools: agentState.state.activeTools }
                : agentState.state.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" });
            dispatch({ type: "start" });
            void connectEvents(session.id);
            if (!agentState.state.isStreaming && agentState.state.isPromptRunning) {
              void waitForPromptSettlement(session.id);
            }
          }
          if (agentState.state?.isBashRunning) {
            bashRunningRef.current = true;
            setBashRunning(true);
            void waitForBashSettlement(session.id);
          }
        }
        if (agentState?.state) {
          if (agentState.state.isCompacting !== undefined) setIsCompacting(agentState.state.isCompacting);
          if (agentState.state.contextUsage !== undefined) setContextUsage(agentState.state.contextUsage ?? null);
          if (agentState.state.systemPrompt !== undefined) setSystemPrompt(agentState.state.systemPrompt ?? null);
          if (agentState.state.systemPromptBinding !== undefined) {
            setSystemPromptBinding(agentState.state.systemPromptBinding ?? null);
            const restoredSelection = selectionFromSystemPromptBinding(agentState.state.systemPromptBinding ?? null);
            systemPromptSelectionRef.current = restoredSelection;
            setSystemPromptSelection(restoredSelection);
          }
          if (agentState.state.thinkingLevel !== undefined) setThinkingLevel((agentState.state.thinkingLevel as ThinkingLevelOption) ?? "auto");
          if (agentState.state.extensionStatuses !== undefined) setExtensionStatuses(agentState.state.extensionStatuses ?? []);
          if (agentState.state.extensionWidgets !== undefined) setExtensionWidgets(agentState.state.extensionWidgets ?? []);
          if (agentState.state.queuedMessages !== undefined) setQueuedMessages(normalizeQueuedMessages(agentState.state.queuedMessages));
          if (agentState.state.capabilities !== undefined) setCapabilities(agentState.state.capabilities);
        }
      });
    }
    return () => {
      bashRecoveryIdRef.current += 1;
      sessionLoadAbortRef.current?.abort();
      sessionLoadAbortRef.current = null;
      if (session) invalidatePrefetchedSession(session.id);
      closeEvents();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const sid = sessionIdRef.current;
    if (sid && (agentRunning || bashRunning || streamState.isStreaming)) {
      invalidatePrefetchedSession(sid);
    }
  }, [agentRunning, bashRunning, streamState.isStreaming]);

  useEffect(() => {
    onSystemPromptChange?.(systemPrompt);
  }, [systemPrompt, onSystemPromptChange]);

  useEffect(() => {
    if (!onBranchDataChange) return;
    onBranchDataChange(data?.tree ?? [], activeLeafId, handleLeafChange);
  }, [data?.tree, activeLeafId, handleLeafChange, onBranchDataChange]);

  useEffect(() => {
    window.addEventListener("keydown", markUserScrollIntent);
    // Capture the custom rail before its drag handler stops propagation, and
    // capture wheel input on the rail before it scrolls the chat viewport.
    window.addEventListener("pointerdown", markUserScrollIntent, { capture: true, passive: true });
    window.addEventListener("wheel", markUserScrollIntent, { capture: true, passive: true });
    return () => {
      window.removeEventListener("keydown", markUserScrollIntent);
      window.removeEventListener("pointerdown", markUserScrollIntent, true);
      window.removeEventListener("wheel", markUserScrollIntent, true);
    };
  }, [markUserScrollIntent]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener("wheel", markUserScrollIntent, { passive: true });
    container.addEventListener("touchstart", markUserScrollIntent, { passive: true });
    container.addEventListener("scroll", handleScrollPositionChange, { passive: true });
    return () => {
      container.removeEventListener("wheel", markUserScrollIntent);
      container.removeEventListener("touchstart", markUserScrollIntent);
      container.removeEventListener("scroll", handleScrollPositionChange);
    };
  }, [messages.length, loading, handleScrollPositionChange, markUserScrollIntent]);

  useEffect(() => stopInitialBottomPin, [stopInitialBottomPin]);

  useLayoutEffect(() => {
    if (!liveOutputAutoScrollEnabled || !agentRunning || loading) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    let frame = 0;
    const pinLiveOutputToBottom = () => {
      frame = 0;
      if (!liveOutputFollowRef.current) return;
      scrollToBottom("instant");
    };
    const schedulePin = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(pinLiveOutputToBottom);
    };
    const resizeObserver = new ResizeObserver(schedulePin);
    resizeObserver.observe(container);
    const content = container.firstElementChild;
    if (content) resizeObserver.observe(content);
    // Images, diagrams, and extension UI can finish layout after their
    // streaming event. Keep the newest output visible when that happens too.
    container.addEventListener("load", schedulePin, true);
    pinLiveOutputToBottom();
    schedulePin();

    return () => {
      resizeObserver.disconnect();
      container.removeEventListener("load", schedulePin, true);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [agentRunning, liveOutputAutoScrollEnabled, loading, scrollToBottom]);

  useLayoutEffect(() => {
    // Loading may publish the message array before the loading shell is
    // replaced by the scroll container. Do not consume the one-shot initial
    // scroll until that container is mounted, otherwise switching sessions
    // can leave the newly selected conversation at the top.
    if (loading || messages.length === 0) return;

    if (pendingScrollToUserRef.current) {
      pendingScrollToUserRef.current = false;
      initialScrollDoneRef.current = true;
      scrollUserMsgToTop();
    } else if (!initialScrollDoneRef.current) {
      initialScrollDoneRef.current = true;
      startInitialBottomPin();
    } else if (!agentRunningRef.current && completionScrollAllowedRef.current && liveOutputAutoScrollEnabled) {
      scrollToBottom("smooth");
    }
  }, [messages.length, agentRunning, liveOutputAutoScrollEnabled, loading, scrollToBottom, scrollUserMsgToTop, startInitialBottomPin]);

  // Load model list
  useEffect(() => {
    const controller = new AbortController();
    loadModels(controller.signal).catch((e) => {
      if (e instanceof DOMException && e.name === "AbortError") return;
    });
    return () => controller.abort();
  }, [loadModels, modelsRefreshKey]);

  useEffect(() => {
    if (!compactResult) return;
    const t = setTimeout(() => setCompactResult(null), 6000);
    return () => clearTimeout(t);
  }, [compactResult]);

  useEffect(() => {
    if (noticeState.visible.length === 0) return;
    const exiting = noticeState.visible.find((notice) => notice.exiting);
    if (exiting) {
      const t = setTimeout(() => {
        dispatchNotice({ type: "remove", id: exiting.id });
      }, NOTICE_EXIT_ANIMATION_MS);
      return () => clearTimeout(t);
    }
    const oldest = noticeState.visible[0];
    if (!oldest) return;
    const t = setTimeout(() => {
      dispatchNotice({ type: "mark_oldest_exiting" });
    }, NOTICE_VISIBLE_MS);
    return () => clearTimeout(t);
  }, [noticeState.visible]);

  useEffect(() => {
    setSessionStatsOverride(null);
  }, [messages.length, contextUsage?.tokens, contextUsage?.percent, contextUsage?.contextWindow]);

  return {
    // State
    data, loading, error, activeLeafId, messages, entryIds, streamState,
    agentRunning, modelNames, modelList, modelError, modelThinkingLevels, modelThinkingLevelMaps, newSessionModel, thinkingLevel,
    retryInfo, contextUsage: effectiveContextUsage, systemPrompt, systemPromptBinding, systemPromptSelection, systemPromptSaving, forkingEntryId,
    isCompacting, compactError, compactResult, currentModel, displayModel, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages, capabilities, capabilitiesSaving,
    liveOutputFollowPaused: liveOutputAutoScrollEnabled && agentRunning && liveOutputFollowPaused,
    notices: noticeState.visible, extensionDialog, extensionCustomUi, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput,
    isAutoModelSelection: isNew && displayModel === null,
    agentPhase,
    isNew,
    // Refs
    sessionIdRef, eventSourceRef, messagesEndRef, scrollContainerRef,
    lastUserMsgRef, pendingScrollToUserRef, initialScrollDoneRef,
    // Actions
    handleSend, handleAbort, handleFork, handleNavigate, handleModelChange,
    handleScrollToBottom,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    handleRecallQueue,
    handleBuiltinSlashCommand,
    handleThinkingLevelChange, handleCapabilitySelection, handleSystemPromptSelection, loadSlashCommands, setActiveLeafId, setData, setMessages,
    dispatch, setAgentRunning, setForkingEntryId,
    bashRunning, pendingBash,
    // Subscriptions
    handleAgentEventRef,
  };
}
