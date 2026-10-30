"use client";
import { DEFAULT_TOOL_PERMISSION_CHANGED, notifyDefaultToolPermissionChanged, saveDefaultToolPermission } from "./useDefaultToolPermission";
import { isPermissionMode, type PermissionMode, type ToolPermissionState } from "@/lib/tool-permission-policy";
import { NestedToolCallsStore } from "@/lib/nested-tool-calls";
import type { ToolReviewRecord } from "@/lib/tool-review-types";

import { createAgentEventDecoder } from "@/lib/agent-event-transport";
import { flushPendingAnswerState } from "@/lib/answer-output-client";
import { AnswerOutputPreviewStore } from "@/lib/answer-output-preview-client";
import { savePendingPrompt, dismissPendingPrompt, readPendingPrompts, mergePendingPrompts, replaceFailedPromptMessage, confirmPendingPrompts, type PendingPrompt } from "@/lib/prompt-recovery";

import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo, useReducer, useSyncExternalStore } from "react";
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
import type { DispatchReceipt } from "@/lib/session-message-types";
import { setDraft, type ChatDraft } from "@/lib/draft-store";
import { reduceAgentPhase, type AgentPhase } from "@/lib/agent-phase";
import { isRunProgressEvent, type RunStatusClock } from "@/lib/run-progress";
import { useI18n } from "@/hooks/useI18n";
import { useExtensionDialog } from "@/hooks/useExtensionDialog";
import { useChatCommandOperations } from "@/hooks/useChatCommandOperations";
import { createChatCommandCatalog, persistentChatInputOptions } from "@/lib/chat-command-input";
import type { ChatCommandCatalog, ChatInputOptions } from "@/lib/chat-command-types";
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
import { getContentScrollMetrics, getLiveTailScrollLimit, scrollLiveTailWheel } from "@/lib/chat-scroll";
import { followChatBottom } from "@/lib/chat-bottom-follow";
import type {
  SessionSystemPromptBinding,
  SystemPromptSelection,
} from "@/lib/system-prompt-types";

export type { AgentPhase } from "@/lib/agent-phase";

export interface SessionData {
  stats?: SessionStatsInfo;
  persistedPromptIds?: string[];
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
  stats?: SessionStatsInfo;
  model?: { provider: string; id: string };
  contextUsage?: ContextUsage | null;
  systemPrompt?: string;
  systemPromptBinding?: SessionSystemPromptBinding | null;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isPromptRunning?: boolean;
  isBashRunning?: boolean;
  isCompacting?: boolean;
  compactionStartedAt?: number | null;
  runtime?: string;
  runStartedAt?: number | null;
  statusPhaseKind?: RunStatusClock["phaseKind"];
  statusPhaseStartedAt?: number | null;
  lastProgressAt?: number | null;
  activeTools?: { id: string; name: string }[];
  extensionStatuses?: ExtensionStatusItem[];
  extensionWidgets?: ExtensionWidgetItem[];
  queuedMessages?: { steering?: string[]; followUp?: string[]; pendingInputs?: PendingInput[] } | null;
  capabilities?: SessionCapabilitiesState;
  toolPermission?: ToolPermissionState;
};

export interface PendingInput { id: string; commandId?: string; text: string; kind: "steer" | "followUp" }
export interface QueuedMessages {
  pendingInputs?: PendingInput[];
  steering: string[];
  followUp: string[];
}

function normalizeQueuedMessages(q?: { steering?: string[]; followUp?: string[]; pendingInputs?: PendingInput[] } | null): QueuedMessages {
  return { steering: q?.steering ?? [], followUp: q?.followUp ?? [], ...(q?.pendingInputs ? { pendingInputs: q.pendingInputs } : {}) };
}

function appendQueuedMessage(current: QueuedMessages, kind: "steering" | "followUp", message: string): QueuedMessages {
  return { ...current, [kind]: [...current[kind], message] };
}

function removeLastQueuedMessage(current: QueuedMessages, kind: "steering" | "followUp", message: string): QueuedMessages {
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
  newSessionInitialPermissionMode?: PermissionMode;
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
const MODEL_ERROR_VISIBLE_MS = 20_000;
const COMPACT_ERROR_VISIBLE_MS = 12_000;
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
  prependText: (text: string, retryOfPromptIds?: string[]) => void;
  addImages: (files: File[]) => void;
  restoreFailedPrompt: (text: string, files?: AttachedFile[], images?: AttachedImage[]) => void;
}

export interface AttachedImage {
  data: string;
  mimeType: string;
  previewUrl: string;
}

export type { AttachedFile } from "@/lib/file-attachments";
import { buildLocalFilePrompt, type AttachedFile } from "@/lib/file-attachments";

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
  catalog?: ChatCommandCatalog;
};

export function useAgentSession(opts: UseAgentSessionOptions) {
  const [commandConversationKey] = useState(() => crypto.randomUUID());
  const { t } = useI18n();
  const translateRef = useRef(t);
  translateRef.current = t;
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
  // Only explicit history navigation invalidates optional answer views. Normal
  // streaming/hydration advances the leaf without remounting focused controls.
  const [answerOutputScope, setAnswerOutputScope] = useState(0);
  const answerPreviewStore = useMemo(() => new AnswerOutputPreviewStore(), []);
  const answerOutputPreviews = useSyncExternalStore(answerPreviewStore.subscribe, answerPreviewStore.getSnapshot, answerPreviewStore.getSnapshot);
  const [messages, setMessages] = useState<AgentMessage[]>(initialSessionData?.context.messages ?? []);
  const [deletingMessage, setDeletingMessage] = useState(false);
  const messageMutationRef = useRef(false);
  const historyRevisionRef = useRef(0);
  const editedBranchRef = useRef<{ sid: string; target: string; previousLeaf: string | null } | null>(null);
  const [entryIds, setEntryIds] = useState<string[]>(initialSessionData?.context.entryIds ?? []);
  const [streamState, dispatch] = useReducer(streamReducer, { isStreaming: false, streamingMessage: null });
  const [agentRunning, setAgentRunning] = useState(false);
  const [replyHistorySettling, setReplyHistorySettling] = useState(false);
  const [liveOutputFollowPaused, setLiveOutputFollowPaused] = useState(false);
  const [bashRunning, setBashRunning] = useState(false);
  const [pendingBash, setPendingBash] = useState<{ command: string; excludeFromContext: boolean; output?: string } | null>(null);
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
  const [compactionStartedAt, setCompactionStartedAt] = useState<number | null>(null);
  const manualCompactionPendingRef = useRef(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [compactResult, setCompactResult] = useState<CompactResultInfo | null>(null);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>(null);
  const [statusClock, setStatusClock] = useState<RunStatusClock | null>(null);
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
  const [slashCommandsLoading, setSlashCommandsLoading] = useState(false);
  const [slashCommandsError, setSlashCommandsError] = useState<string | null>(null);
  const [commandCatalog, setCommandCatalog] = useState(() => createChatCommandCatalog([]));
  const commandCatalogRef = useRef(commandCatalog);
  const commandCatalogErrorRef = useRef<string | null>(null);
  const commandCatalogLoadRef = useRef(0);
  const commandCatalogScope = session?.id ?? `new:${newSessionCwd}`;
  useEffect(() => {
    commandCatalogLoadRef.current++;
    const catalog = createChatCommandCatalog([]);
    commandCatalogRef.current = catalog;
    commandCatalogErrorRef.current = null;
    setCommandCatalog(catalog);
    setSlashCommands([]);
    setSlashCommandsError(null);
    setSlashCommandsLoading(false);
  }, [commandCatalogScope]);
  const [noticeState, dispatchNotice] = useReducer(noticeReducer, { visible: [], pending: [] });
  const [sessionStatsOverride, setSessionStatsOverride] = useState<SessionStatsInfo | null>(initialSessionData?.stats ?? null);
  const statsRefreshSequence = useRef(0);
  const [nestedCallsStore] = useState(() => new NestedToolCallsStore());
  useEffect(() => () => nestedCallsStore.reset(), [nestedCallsStore]);
  const { dialog: extensionDialog, setDialog: setExtensionDialog, receiveDialog } = useExtensionDialog();
  const [extensionCustomUi, setExtensionCustomUi] = useState<ExtensionUiCustomRequest | null>(null);
  const [extensionStatuses, setExtensionStatuses] = useState<ExtensionStatusItem[]>([]);
  const [extensionWidgets, setExtensionWidgets] = useState<ExtensionWidgetItem[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessages>({ steering: [], followUp: [] });
  const [capabilities, setCapabilities] = useState<SessionCapabilitiesState>(() => createDefaultSessionCapabilitiesState());
  const [capabilitiesSaving, setCapabilitiesSaving] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  const sessionIdRef = useRef<string | null>(session?.id ?? null);
  const [toolReviews, setToolReviews] = useState<ToolReviewRecord[]>([]);
  const acceptToolReviews = useCallback((incoming: ToolReviewRecord[]) => {
    setToolReviews(current => {
      const records = new Map(current.map(record => [record.id, record]));
      for (const record of incoming) if (record.sessionId === sessionIdRef.current && (!records.has(record.id) || records.get(record.id)!.updatedAt <= record.updatedAt)) records.set(record.id, record);
      return [...records.values()].sort((a, b) => a.startedAt - b.startedAt).slice(-100);
    });
  }, []);
  useEffect(() => {
    setToolReviews([]);
    if (!session?.id) return;
    const controller = new AbortController();
    const refresh = () => {
      void fetch(`/api/sessions/${encodeURIComponent(session.id)}/tool-reviews`, { signal: controller.signal }).then(response => response.ok ? response.json() : null).then(data => {
        if (!controller.signal.aborted && Array.isArray(data?.reviews)) acceptToolReviews(data.reviews);
      }).catch(() => undefined);
    };
    refresh();
    const refreshVisible = () => { if (document.visibilityState !== "hidden") refresh(); };
    const timer = window.setInterval(refreshVisible, 5000);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => { controller.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", refreshVisible); };
  }, [session?.id, acceptToolReviews]);
  const [toolPermission, setToolPermission] = useState<ToolPermissionState | null>(() => opts.newSessionInitialPermissionMode
    ? { mode: opts.newSessionInitialPermissionMode, revision: 0 } : null);
  const acceptToolPermission = useCallback((next: ToolPermissionState) => {
    setToolPermission(current => !current || next.revision >= current.revision ? next : current);
  }, []);
  const [permissionSaving, setPermissionSaving] = useState(false);
  const permissionSavingRef = useRef(false);
  const permissionReadGeneration = useRef(0);
  const permissionOverrideRef = useRef<PermissionMode | undefined>(opts.newSessionInitialPermissionMode);
  const permissionOwnerRef = useRef<string | null>(session?.id ?? null);
  useEffect(() => {
    let disposed = false;
    if (session?.id && permissionOwnerRef.current !== session.id) {
      permissionOwnerRef.current = session.id;
      permissionOverrideRef.current = undefined;
      setToolPermission(null);
    }
    const refresh = async () => {
      const sid = session?.id ?? sessionIdRef.current;
      const generation = ++permissionReadGeneration.current;
      try {
        const res = await fetch(sid ? `/api/sessions/${encodeURIComponent(sid)}/permissions` : "/api/tool-permissions");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const value = await res.json();
        if (!isPermissionMode(value.mode)) throw new Error("Invalid permission state");
        if (!disposed && generation === permissionReadGeneration.current && !permissionSavingRef.current && sid === sessionIdRef.current && (sid || !permissionOverrideRef.current)) {
          acceptToolPermission({ ...value, revision: value.revision ?? 0 });
        }
      } catch { /* Keep the control disabled until authoritative state is available. */ }
    };
    void refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener(DEFAULT_TOOL_PERMISSION_CHANGED, refresh);
    return () => { disposed = true; window.removeEventListener("focus", refresh); window.removeEventListener(DEFAULT_TOOL_PERMISSION_CHANGED, refresh); };
  }, [session?.id, newSessionCwd, acceptToolPermission]);

  const agentRunningRef = useRef(false);
  const reconciliationRef = useRef<{ sid: string; runId: number; controller: AbortController } | null>(null);
  useEffect(() => {
    const receive = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!agentRunningRef.current && sessionIdRef.current && detail?.ids?.includes(sessionIdRef.current) && typeof detail.provider === "string" && typeof detail.modelId === "string") setCurrentModelOverride({ provider: detail.provider, modelId: detail.modelId });
    };
    window.addEventListener("piora:project-model-changed", receive);
    return () => window.removeEventListener("piora:project-model-changed", receive);
  }, []);
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
  const createdSessionIdRef = useRef<string | null>(null);
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
  const promptSubmissionRef = useRef<{ runId: number; sid: string; idempotencyKey: string; pending: boolean; commandId: string | null } | null>(null);
  const cancelPreparedPromptRef = useRef<(() => void) | null>(null);
  const abortRequestRunIdRef = useRef<number | null>(null);
  const queueAdmissionRevisionRef = useRef(0);

  const phaseEventRevisionRef = useRef(0);
  /** Last time the active run produced visible progress (stream, tool output, results). */
  const activityClockRef = useRef<number>(Date.now());
  const restoreStatusClock = useCallback((state: AgentStateResponse) => {
    setStatusClock({
      runStartedAt: state.runStartedAt ?? null,
      phaseKind: state.statusPhaseKind ?? null,
      phaseStartedAt: state.statusPhaseStartedAt ?? null,
      lastProgressAt: state.lastProgressAt ?? null,
    });
    if (typeof state.lastProgressAt === "number") activityClockRef.current = state.lastProgressAt;
  }, []);
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
    // A missing window stays 0 and the estimate is skipped. Do not substitute a
    // hidden size here; legacy resolution is documented in lib/model-limits.ts.
    const contextWindow = modelList.find((entry) => (
      entry.provider === displayModel.provider && entry.id === displayModel.modelId
    ))?.contextWindow ?? 0;
    return estimateSessionContextUsage(messages, contextWindow);
  }, [displayModel, messages, modelList]);
  const effectiveContextUsage = useMemo(() => {
    return mergeContextUsageWithEstimate(contextUsage, estimatedContextUsage);
  }, [contextUsage, estimatedContextUsage]);

  const sessionStats = useMemo(() => {
    if (!sessionStatsOverride || sessionStatsOverride.sessionId !== sessionIdRef.current) return null;
    return { ...sessionStatsOverride, ...(effectiveContextUsage ? { contextUsage: effectiveContextUsage } : {}) };
  }, [sessionStatsOverride, effectiveContextUsage]);

  const loadSession = useCallback(async (
    sid: string,
    showLoading = false,
    includeState = false,
    prefetchedData: Promise<unknown | null> | null = null,
  ) => {
    sessionLoadAbortRef.current?.abort();
    const controller = new AbortController();
    sessionLoadAbortRef.current = controller;
    const statsSequence = ++statsRefreshSequence.current;
    const runId = promptRunIdRef.current;
    let messagesLoaded = false;
    let timedOut = false;
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    });
    const wait = <T,>(value: T | PromiseLike<T>): Promise<T> => Promise.race([Promise.resolve(value), aborted]);
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      invalidatePrefetchedSession(sid);
    }, 30_000);
    try {
      if (showLoading) setLoading(true);
      let d = await wait(prefetchedData) as SessionData | null;
      if (controller.signal.aborted) return null;
      if (!d) {
        const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1" });
        const res = await wait(fetch(`/api/sessions/${encodeURIComponent(sid)}?${params}`, {
          signal: controller.signal,
        }));
        if (res.status === 404) {
          const recovered = mergePendingPrompts([], [], await wait(readPendingPrompts(sid)));
          if (controller.signal.aborted || sessionIdRef.current !== sid || promptRunIdRef.current !== runId) return null;
          if (recovered.messages.length) { setMessages(recovered.messages); setEntryIds(recovered.entryIds); }
          if (showLoading) {
            setData(null);
            setActiveLeafId(null);
            if (!recovered.messages.length) setMessages([]);
            setError(null);
          }
          return null;
        }
        if (!res.ok) throw await sessionResponseError(res);
        d = await wait(res.json()) as SessionData;
      }
      if (controller.signal.aborted || sessionIdRef.current !== sid || promptRunIdRef.current !== runId) return null;
      const editedBranch = editedBranchRef.current;
      if (editedBranch?.sid === sid && d.leafId === editedBranch.previousLeaf) {
        const response = await wait(fetch(`/api/sessions/${encodeURIComponent(sid)}/context?${new URLSearchParams({ leafId: editedBranch.target, deferThinking: "1", deferMedia: "1" })}`, { signal: controller.signal }));
        if (!response.ok) throw await sessionResponseError(response);
        const branch = await wait(response.json());
        d = { ...d, context: branch.context, leafId: editedBranch.target };
      } else if (editedBranch?.sid === sid && editedBranchRef.current === editedBranch) {
        editedBranchRef.current = null;
      }
      const recovered = mergePendingPrompts(d.context.messages, d.context.entryIds ?? [], await wait(readPendingPrompts(sid)), d.persistedPromptIds);
      if (controller.signal.aborted || sessionIdRef.current !== sid || promptRunIdRef.current !== runId) return null;
      nestedCallsStore.reset();
      setData(d);
      if (statsSequence === statsRefreshSequence.current) setSessionStatsOverride(d.stats ?? null);
      setActiveLeafId(d.leafId);
      setMessages(recovered.messages);
      setEntryIds(recovered.entryIds);
      void confirmPendingPrompts(recovered.confirmedIds).catch(console.error);
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
      if (sessionLoadAbortRef.current === controller) setLoading(false);
      if (!includeState) return null;

      try {
        const stateRes = await wait(fetch(`/api/sessions/${encodeURIComponent(sid)}/state`, {
          signal: controller.signal,
        }));
        if (!stateRes.ok) throw new Error(`HTTP ${stateRes.status}`);
        const agentState = await wait(stateRes.json()) as { running: boolean; state?: AgentStateResponse };
        if (controller.signal.aborted || sessionIdRef.current !== sid || promptRunIdRef.current !== runId) return null;

        const liveState = agentState.state;
        if (liveState) {
          if (liveState.stats && statsSequence === statsRefreshSequence.current) setSessionStatsOverride(liveState.stats);
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
          if (liveState.toolPermission !== undefined) acceptToolPermission(liveState.toolPermission);
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
      clearTimeout(timeout);
      if (sessionLoadAbortRef.current === controller) {
        sessionLoadAbortRef.current = null;
        if (timedOut && !messagesLoaded && sessionIdRef.current === sid && promptRunIdRef.current === runId) setError(translateRef.current("chat.loadSessionTimeout"));
        setLoading(false);
      }
    }
  }, [nestedCallsStore, acceptToolPermission]);

  const loadContext = useCallback(async (sid: string, leafId: string | null) => {
    const runId = promptRunIdRef.current;
    const revision = ++historyRevisionRef.current;
    try {
      const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1" });
      if (leafId) params.set("leafId", leafId);
      const url = `/api/sessions/${encodeURIComponent(sid)}/context?${params}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as { context: { messages: AgentMessage[]; entryIds: string[] }; persistedPromptIds?: string[] };
      const recovered = mergePendingPrompts(d.context.messages, d.context.entryIds ?? [], await readPendingPrompts(sid), d.persistedPromptIds);
      if (sessionIdRef.current !== sid || promptRunIdRef.current !== runId || historyRevisionRef.current !== revision) return;
      // An explicit historical position contains only its persisted ancestry.
      // Recovery copies stay stored and return in the normal conversation view.
      setMessages(leafId ? d.context.messages : recovered.messages);
      setEntryIds(leafId ? d.context.entryIds : recovered.entryIds);
      void confirmPendingPrompts(recovered.confirmedIds).catch(console.error);
      return true;
    } catch (e) {
      console.error("Failed to load context:", e);
      return false;
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
        ...(permissionOverrideRef.current ? { permissionMode: permissionOverrideRef.current } : {}),
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
      createdSessionIdRef.current = realId;
      sessionIdRef.current = realId;
      permissionOwnerRef.current = realId;
      if (permissionOverrideRef.current && result.toolPermission?.mode !== permissionOverrideRef.current) {
        result.toolPermission = await sendAgentCommand<ToolPermissionState>(realId, { type: "set_tool_permission", mode: permissionOverrideRef.current });
      }
      if (result.toolPermission) acceptToolPermission(result.toolPermission);
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
  }, [isNew, newSessionCwd, acceptToolPermission]);

  const loadSlashCommands = useCallback(async () => {
    const sequence = ++commandCatalogLoadRef.current;
    const sid = sessionIdRef.current ?? await ensureNewSession();
    if (!sid) {
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    }
    setSlashCommandsLoading(true);
    setSlashCommandsError(null);
    commandCatalogErrorRef.current = null;
    try {
      const data = await sendAgentCommand<SlashCommandsResponse>(sid, { type: "get_commands" });
      if (sequence !== commandCatalogLoadRef.current || sessionIdRef.current !== sid) return [] as SlashCommandInfo[];
      const commands = data?.commands ?? [];
      const catalog = data?.catalog ?? createChatCommandCatalog(commands);
      commandCatalogRef.current = catalog;
      setCommandCatalog(catalog);
      setSlashCommands(commands);
      return commands;
    } catch (e) {
      if (sequence !== commandCatalogLoadRef.current || sessionIdRef.current !== sid) return [] as SlashCommandInfo[];
      console.error("Failed to load slash commands:", e);
      const message = e instanceof Error ? e.message : String(e);
      setSlashCommandsError(message);
      commandCatalogErrorRef.current = message;
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    } finally {
      if (sequence === commandCatalogLoadRef.current && sessionIdRef.current === sid) setSlashCommandsLoading(false);
    }
  }, [ensureNewSession]);

  const closeEvents = useCallback(() => {
    answerPreviewStore.disconnect();
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, [answerPreviewStore]);

  const connectEvents = useCallback(function connectEvents(
    sid: string,
  ): Promise<EventStreamConnectionResult> {
    closeEvents();
    const es = new EventSource(`/api/agent/${encodeURIComponent(sid)}/events?transport=delta`);
    eventSourceRef.current = es;
    const decodeEvent = createAgentEventDecoder();
    const previewConnection = answerPreviewStore.connect(sid);

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
          const event = decodeEvent(JSON.parse(e.data) as AgentEvent);
          if (!event) return;
          if (event.type === "connected") {
            answerPreviewStore.restore(previewConnection, event.answerOutputPreviews);
            settle("connected");
          }
          if (event.type === "prompt_started") answerPreviewStore.started(previewConnection, event.sessionId, event.runId);
          if (event.type === "answer_output_preview") {
            answerPreviewStore.receive(previewConnection, event.preview);
            return;
          }
          if (event.type === "message_end" && (event.message as { role?: string } | undefined)?.role === "toolResult") {
            answerPreviewStore.handoff(previewConnection, (event.message as { toolCallId?: string }).toolCallId);
          }
          if (event.type === "tool_execution_update" && (event.partialResult as { details?: { answerOutput?: unknown } } | undefined)?.details?.answerOutput) {
            answerPreviewStore.handoff(previewConnection, event.toolCallId);
          }
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
  }, [closeEvents, answerPreviewStore]);

  const ensureEventsConnected = useCallback(async (sid: string) => {
    const current = eventSourceRef.current;
    if (current?.readyState === EventSource.OPEN && current.url.endsWith(`/api/agent/${encodeURIComponent(sid)}/events?transport=delta`)) return;
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
  }, [setExtensionDialog]);

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

  const handleToolPermission = useCallback(async (mode: PermissionMode) => {
    if (permissionSavingRef.current) return;
    const sid = sessionIdRef.current;
    if (!sid && !isNew) return;
    permissionSavingRef.current = true;
    ++permissionReadGeneration.current;
    setPermissionSaving(true);
    try {
      if (!sid) {
        const next = await saveDefaultToolPermission(mode);
        if (sessionIdRef.current === sid) {
          permissionOverrideRef.current = next.mode;
          setToolPermission(next);
        }
      } else {
        const next = await sendAgentCommand<ToolPermissionState>(sid, { type: "set_tool_permission", mode, rememberDefault: true });
        notifyDefaultToolPermissionChanged();
        if (sessionIdRef.current === sid) acceptToolPermission(next);
      }
    } catch (error) {
      addNotice({ type: "error", message: String(error) });
    } finally { permissionSavingRef.current = false; setPermissionSaving(false); }
  }, [addNotice, isNew, acceptToolPermission]);

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
      case "close":
        receiveDialog(request);
        if (request.method === "close" && request.reason === "timeout") {
          addNotice({ id: `question-timeout-${request.id}`, message: t("userInput.expired"), type: "info" });
        }
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
  }, [addNotice, opts.chatInputRef, receiveDialog, t]);

  const isPromptCommandSettled = useCallback((commandId: string | null, command: Pick<DispatchReceipt, "commandId" | "status"> | null | undefined) => {
    return !commandId || (command?.commandId === commandId
      && ["completed", "failed", "cancelled", "expired", "interrupted"].includes(command.status));
  }, []);

  const finishPromptWithoutStream = useCallback((sid: string | null = sessionIdRef.current, runId = promptRunIdRef.current) => {
    // End the visible run synchronously. History/state hydration is not part
    // of cancellation and can stall independently of the model transport.
    if (promptRunIdRef.current !== runId) return Promise.resolve();
    answerPreviewStore.stop();
    const wasRunning = agentRunningRef.current;
    agentRunningRef.current = false;
    nestedCallsStore.finish();
    closeEvents();
    optimisticUserMessageKeyRef.current = null;
    if (wasRunning) {
      setAgentRunning(false);
      setAgentPhase(null);
      setRetryInfo(null);
      setIsCompacting(false);
      setCompactionStartedAt(null);
      setExtensionDialog(null);
      setExtensionCustomUi(null);
      dispatch({ type: "end" });
      const shouldNotify = !suppressCompletionNotificationRef.current;
      suppressCompletionNotificationRef.current = false;
      if (shouldNotify && sid) onAgentEnd?.(sid);
    }
    const existing = promptSettlementByRunRef.current.get(runId);
    if (existing) return existing;
    setReplyHistorySettling(true);
    const settlement = (async () => {
      // Bail out before loadSession too: a stale finish for a previous run
      // must not overwrite the messages of the run currently streaming.
      if (promptRunIdRef.current !== runId) return;
      if (sid) await loadSession(sid, false, true);
    })().finally(() => { if (promptRunIdRef.current === runId) setReplyHistorySettling(false); });
    promptSettlementByRunRef.current.set(runId, settlement);
    return settlement;
  }, [closeEvents, loadSession, nestedCallsStore, onAgentEnd, setExtensionDialog, answerPreviewStore]);

  const waitForPromptSettlement = useCallback((sid: string, runId = promptRunIdRef.current) => {
    const existing = promptSettlementPollByRunRef.current.get(runId);
    if (existing) return existing;
    const polling = (async () => {
      await delay(PROMPT_SETTLE_INITIAL_DELAY_MS);
      const startedAt = Date.now();

      while (agentRunningRef.current && Date.now() - startedAt < PROMPT_SETTLE_MAX_MS) {
        if (promptRunIdRef.current !== runId) return;
        const submission = promptSubmissionRef.current;
        if (submission?.runId === runId && submission.pending) {
          await delay(PROMPT_SETTLE_POLL_MS);
          continue;
        }
        const commandId = submission?.runId === runId && submission.sid === sid ? submission.commandId : null;
        const commandQuery = commandId ? `?promptCommandId=${encodeURIComponent(commandId)}` : "";
        try {
          const res = await fetch(`/api/agent/${encodeURIComponent(sid)}${commandQuery}`, { signal: AbortSignal.timeout(10_000) });
          if (res.ok) {
            const data = await res.json() as { running?: boolean; state?: AgentStateResponse; promptCommand?: Pick<DispatchReceipt, "commandId" | "status"> | null };
            if (promptRunIdRef.current !== runId) return;
            if (promptSubmissionRef.current !== submission || submission?.pending) continue;
            const state = data.state;
            // Model completion can precede asynchronous prompt cleanup and its
            // terminal event. The server runtime still owns that running span.
            if (isPromptCommandSettled(commandId, data.promptCommand)
              && (!data.running || !state || (!state.isStreaming && !state.isPromptRunning && !state.isCompacting && state.runtime !== "running" && state.runtime !== "stopping"))) {
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
  }, [finishPromptWithoutStream, isPromptCommandSettled]);

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
        if (data.state?.isBashRunning) {
          restoreStatusClock(data.state);
          continue;
        }

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
  }, [loadSession, restoreStatusClock]);

  const refreshContextUsage = useCallback(async (sid: string) => {
    const runId = promptRunIdRef.current;
    const sequence = ++statsRefreshSequence.current;
    try {
      const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok || sessionIdRef.current !== sid) return;
      const data = await res.json() as { state?: AgentStateResponse };
      if (sessionIdRef.current !== sid || promptRunIdRef.current !== runId || sequence !== statsRefreshSequence.current) return;
      if (data.state?.stats) setSessionStatsOverride(data.state.stats);
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
    const submission = promptSubmissionRef.current;
    if (submission?.runId === runId && submission.pending) return;
    const commandId = submission?.runId === runId && submission.sid === sid ? submission.commandId : null;
    const commandQuery = commandId ? `?promptCommandId=${encodeURIComponent(commandId)}` : "";
    const pending = reconciliationRef.current;
    if (pending?.sid === sid && pending.runId === runId) return;
    // A slow old run must not block recovery of the newly selected run.
    pending?.controller.abort();
    const request = { sid, runId, controller: new AbortController() };
    reconciliationRef.current = request;
    const phaseRevision = phaseEventRevisionRef.current;
    const statsSequence = ++statsRefreshSequence.current;
    try {
      const res = await fetch(`/api/agent/${encodeURIComponent(sid)}${commandQuery}`, { signal: AbortSignal.any([request.controller.signal, AbortSignal.timeout(10_000)]) });
      if (!res.ok) return;
      const data = await res.json() as { running?: boolean; state?: AgentStateResponse; promptCommand?: Pick<DispatchReceipt, "commandId" | "status"> | null };
      // A slow response can straddle a run boundary (previous run finished
      // and the user already started the next one while this request was in
      // flight) — everything in it is stale, drop it.
      if (request.controller.signal.aborted || sessionIdRef.current !== sid || promptRunIdRef.current !== runId || !agentRunningRef.current) return;
      if (promptSubmissionRef.current !== submission || submission?.pending) return;
      const state = data.state;
      // Mirror compaction state unconditionally: a missed compaction_end
      // would otherwise leave the "Stop compaction" UI stuck. No state
      // (wrapper destroyed) means nothing is compacting.
      if (phaseEventRevisionRef.current === phaseRevision) {
        const compacting = cancelledPromptRunIdRef.current !== runId && (state?.isCompacting ?? false);
        setIsCompacting(compacting);
        setCompactionStartedAt(compacting ? state?.compactionStartedAt ?? null : null);
        if (state && data.running) restoreStatusClock(state);
      }
      setQueuedMessages(normalizeQueuedMessages(state?.queuedMessages));
      if (state?.capabilities !== undefined) setCapabilities(state.capabilities);
      if (state?.toolPermission !== undefined) acceptToolPermission(state.toolPermission);
      if (state?.model && phaseEventRevisionRef.current === phaseRevision) {
        setCurrentModelOverride({ provider: state.model.provider, modelId: state.model.id });
        if (state.thinkingLevel !== undefined) setThinkingLevel(state.thinkingLevel as ThinkingLevelOption);
      }
      const busy = data.running && state
        && (state.isStreaming || state.isPromptRunning || state.isCompacting || state.runtime === "running" || state.runtime === "stopping");
      if (state?.runtime === "stopping") setAgentPhase({ kind: "stopping" });
      else if (state?.activeTools && phaseEventRevisionRef.current === phaseRevision && cancelledPromptRunIdRef.current !== runId) {
        const tools = state.activeTools;
        if (state.statusPhaseKind === "agent") setAgentPhase(null);
        else if (state.statusPhaseKind === "waiting_model") setAgentPhase({ kind: "waiting_model" });
        else if (state.statusPhaseKind === "running_command") setAgentPhase({ kind: "running_command" });
        else setAgentPhase((phase) => tools.length
          ? { kind: "running_tools", tools }
          : phase?.kind === "running_tools" || phase?.kind === "stopping" ? { kind: "waiting_model" } : phase);
      }
      // Context usage is useful while the run is still active (especially
      // across multi-tool turns), so do not defer it until idle settlement.
      if (state?.stats && statsSequence === statsRefreshSequence.current) setSessionStatsOverride(state.stats);
      if (state?.contextUsage !== undefined) setContextUsage(state.contextUsage ?? null);
      if (busy || !agentRunningRef.current) return;
      if (!isPromptCommandSettled(commandId, data.promptCommand)) return;
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
        if (state.toolPermission !== undefined) acceptToolPermission(state.toolPermission);
      }
      await finishPromptWithoutStream(sid, runId);
    } catch {
      // Network still down — the next poll / visibility / online tick retries.
    } finally {
      if (reconciliationRef.current === request) reconciliationRef.current = null;
    }
  }, [finishPromptWithoutStream, isPromptCommandSettled, restoreStatusClock, acceptToolPermission]);

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
      reconciliationRef.current?.controller.abort();
      reconciliationRef.current = null;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", reconcile);
    };
  }, [agentRunning, reconcileAgentState]);

  // A manual compaction has no prompt run. Keep recovering its server state
  // after navigation too, including a missed end event between GET and SSE.
  useEffect(() => {
    if (!isCompacting || agentRunning) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    let disposed = false;
    let pending = false;
    const controller = new AbortController();
    const reconcile = async () => {
      if (disposed || pending) return;
      pending = true;
      const revision = phaseEventRevisionRef.current;
      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
        if (!res.ok) return;
        const data = await res.json() as { state?: AgentStateResponse };
        if (disposed || sessionIdRef.current !== sid || phaseEventRevisionRef.current !== revision || agentRunningRef.current) return;
        if (data.state?.isCompacting) {
          setCompactionStartedAt(data.state.compactionStartedAt ?? null);
        } else if (!manualCompactionPendingRef.current) {
          setIsCompacting(false);
          setCompactionStartedAt(null);
          if (!bashRunningRef.current) closeEvents();
          void loadSession(sid);
        }
      } catch {
        // Keep the current timer during a connection loss; retry on recovery.
      } finally {
        pending = false;
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void reconcile();
    };
    void reconcile();
    const interval = window.setInterval(() => void reconcile(), AGENT_STATE_RECONCILE_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", reconcile);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", reconcile);
    };
  }, [agentRunning, closeEvents, isCompacting, loadSession]);

  useEffect(() => {
    agentRunningRef.current = agentRunning;
  }, [agentRunning]);

  const handleAgentEvent = useCallback((event: AgentEvent) => {
    if (event.type === "tool_review" && event.review) { acceptToolReviews([event.review as ToolReviewRecord]); return; }
    // Stop intent wins over buffered agent_start/tool/retry events, even
    // while the abort HTTP request or server cleanup is still pending.
    if (cancelledPromptRunIdRef.current === promptRunIdRef.current) return;
    if (agentRunningRef.current) {
      nestedCallsStore.beginRun(promptRunIdRef.current);
      nestedCallsStore.record(event);
    }
    phaseEventRevisionRef.current += 1;
    if (isRunProgressEvent(event.type)) activityClockRef.current = Date.now();
    if (["agent_start", "agent_end", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_end"].includes(event.type)) {
      setStatusClock(null);
    }
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
        if (event.aborted) break;
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
        if (completed?.role === "toolResult") nestedCallsStore.finish(completed.toolCallId);
        if (completed?.role === "assistant" && completed.stopReason === "error") {
          suppressCompletionNotificationRef.current = true;
        }
        if (completed && completed.role === "user") {
          // Delivered steering/follow-up messages surface here as user
          // messages. The run's initial prompt also emits one, but handleSend
          // already displayed it optimistically. Consume only its matching
          // optimistic bubble; later same-text queue deliveries must render.
          const delivered = normalizeToolCalls(completed);
          const materializedDelivery = userMessageHasPromptMaterialMarker(delivered);
          const deliveredKey = userMessageKey(delivered);
          const optimisticKey = optimisticUserMessageKeyRef.current;
          optimisticUserMessageKeyRef.current = null;
          setMessages((prev) => {
            const optimisticIndex = prev.findIndex(message => message.role === "user"
              && userMessageKey(message) === optimisticKey
              && (!promptSubmissionRef.current?.idempotencyKey || message.clientPromptId === promptSubmissionRef.current.idempotencyKey));
            if (optimisticKey && optimisticIndex >= 0) {
              if (materializedDelivery) return prev;
              return optimisticKey === deliveredKey
                ? prev
                : prev.map((message, index) => index === optimisticIndex ? delivered : message);
            }
            if (materializedDelivery) return prev;
            return [...prev, delivered];
          });
        } else if (completed) {
          setMessages((prev) => {
            const normalized = normalizeToolCalls(completed);
            if (normalized.role === "toolResult") {
              const index = prev.findIndex((message) => message.role === "toolResult" && message.toolCallId === normalized.toolCallId);
              if (index >= 0) return prev.map((message, i) => i === index ? normalized : message);
            }
            return [...prev, normalized];
          });
        }
        dispatch({ type: "reset" });
        setAgentPhase((phase) => bashRunningRef.current ? null : reduceAgentPhase(phase, event));
        if ((completed?.role === "assistant" || completed?.role === "toolResult") && sessionIdRef.current) {
          void refreshContextUsage(sessionIdRef.current);
        }
        break;
      }
      case "bash_output": {
        if (!bashRunningRef.current || typeof event.output !== "string") break;
        const chunk = event.output;
        setPendingBash((current) => current ? { ...current, output: `${current.output ?? ""}${chunk}`.slice(-100_000) } : current);
        break;
      }
      case "tool_execution_update": {
        if (!agentRunningRef.current) break;
        if (typeof event.parentToolCallId === "string") break;
        const partial = event.partialResult as { content?: unknown; details?: unknown } | undefined;
        if (typeof event.toolCallId !== "string" || !Array.isArray(partial?.content)) break;
        const update: AgentMessage = {
          role: "toolResult", toolCallId: event.toolCallId,
          isStreaming: true,
          toolName: typeof event.toolName === "string" ? event.toolName : undefined,
          content: partial.content,
          details: partial.details,
        };
        setMessages((current) => {
          const index = current.findIndex((message) => message.role === "toolResult" && message.toolCallId === update.toolCallId);
          return index < 0 ? [...current, update] : current.map((message, i) => i === index ? update : message);
        });
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
          pendingInputs: event.pendingInputs as PendingInput[] | undefined,
          steering: [...((event.steering as string[] | undefined) ?? [])],
          followUp: [...((event.followUp as string[] | undefined) ?? [])],
        });
        break;
      case "tool_permission_changed":
        notifyDefaultToolPermissionChanged();
        if (event.permission) acceptToolPermission(event.permission as ToolPermissionState);
        break;
      case "capabilities_changed":
        if (event.capabilities) setCapabilities(event.capabilities as SessionCapabilitiesState);
        break;
      case "project_model_changed": {
        if (typeof event.provider === "string" && typeof event.modelId === "string") setCurrentModelOverride({ provider: event.provider, modelId: event.modelId });
        break;
      }
      case "model_fallback": {
        const model = event.model as { provider?: string; id?: string } | undefined;
        if (model?.provider && model.id) setCurrentModelOverride({ provider: model.provider, modelId: model.id });
        if (typeof event.thinkingLevel === "string") setThinkingLevel(event.thinkingLevel as ThinkingLevelOption);
        break;
      }
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
        setCompactionStartedAt(typeof event.compactionStartedAt === "number" ? event.compactionStartedAt : null);
        setCompactError(null);
        setCompactResult(null);
        break;
      case "auto_compaction_end":
      case "compaction_end":
        // The initiating view still owns a blocking POST; keep its command
        // locked until that response settles, even when SSE finishes first.
        setIsCompacting(manualCompactionPendingRef.current);
        setCompactionStartedAt(null);
        if (!agentRunningRef.current && !bashRunningRef.current) closeEvents();
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
  }, [addNotice, closeEvents, handleExtensionUiRequest, loadSession, nestedCallsStore, refreshContextUsage, setExtensionDialog, waitForPromptSettlement, acceptToolPermission, acceptToolReviews]);
  handleAgentEventRef.current = handleAgentEvent;

  const captureAnswerStateSubmissionGuard = useCallback((expectedSessionId?: string): ((admittedSessionId?: string) => Promise<boolean>) => {
    const sid = sessionIdRef.current;
    const previousCreatedSessionId = createdSessionIdRef.current;
    const runId = promptRunIdRef.current;
    const revision = queueAdmissionRevisionRef.current;
    let admittedSid = sid;
    const isCurrent = () => (!expectedSessionId || expectedSessionId === sid)
      && sessionIdRef.current === admittedSid && promptRunIdRef.current === runId && queueAdmissionRevisionRef.current === revision;
    // Capture before durable recovery starts, but defer saves until it commits.
    return async (createdSessionId?: string) => {
      // Only this hook's own ensure result may promote the initial new chat.
      // A switched-to existing chat must never inherit a pending submission.
      if (admittedSid === null && createdSessionId && createdSessionId !== previousCreatedSessionId
        && createdSessionIdRef.current === createdSessionId && sessionIdRef.current === createdSessionId) admittedSid = createdSessionId;
      if (!isCurrent()) return false;
      if (admittedSid) await flushPendingAnswerState(admittedSid);
      return isCurrent();
    };
  }, []);

  const prepareAnswerStateForSubmission = useCallback((expectedSessionId?: string): Promise<boolean> => {
    if (!sessionIdRef.current) return Promise.resolve(false);
    return captureAnswerStateSubmissionGuard(expectedSessionId)();
  }, [captureAnswerStateSubmissionGuard]);

  const chatCommands = useChatCommandOperations({
    conversationKey: commandConversationKey,
    sessionId: session?.id ?? null,
    scope: session?.id ?? `new:${newSessionCwd}`,
    catalog: commandCatalog,
    captureSubmissionGuard: captureAnswerStateSubmissionGuard,
    ensureSession: async () => sessionIdRef.current ?? await ensureNewSession(),
    loadCatalog: async () => {
      await loadSlashCommands();
      if (commandCatalogErrorRef.current) throw new Error(commandCatalogErrorRef.current);
      return commandCatalogRef.current;
    },
    connectModelEvents: ensureEventsConnected,
    uploadFiles: uploadPromptMaterialFiles,
    onAccepted: () => { if (isNew) promoteNewSession(); },
    onFinished: record => {
      if (record.targetSessionId !== sessionIdRef.current) return;
      if (record.operation?.result?.stats) setSessionStatsOverride(record.operation.result.stats);
      if (record.status === "completed" && record.operation?.command.name === "session") onSessionStatsPanelOpen?.();
      if (record.status === "completed" && record.operation?.command.name === "reload") {
        void loadSlashCommands();
        void loadModels();
        void sendAgentCommand<SessionCapabilitiesState>(record.targetSessionId, { type: "get_capabilities" }).then(setCapabilities).catch(() => {});
      }
      // Queue acknowledgement is not the end of the active model run.
      // Its disk snapshot may lag behind messages already delivered over SSE.
      if (agentRunningRef.current) void waitForPromptSettlement(record.targetSessionId, promptRunIdRef.current);
      else void loadSession(record.targetSessionId, false, true);
    },
  });

  const submitChatCommand = chatCommands.submit;
  const handleSend = useCallback(async (
    message: string,
    images?: AttachedImage[],
    files?: AttachedFile[],
    onDurable?: (clientPromptId?: string) => void,
    retryOfPromptIds?: string[],
    inputOptions?: ChatInputOptions,
    resumedQueuePromptId?: string,
  ) => {
    if (permissionSavingRef.current) return false;
    inputOptions = resumedQueuePromptId && message.trimStart().startsWith("/") ? { ...inputOptions, inputMode: "text" } : inputOptions;
    const trimmedMessage = message.trim();
    if (!trimmedMessage && !images?.length && !files?.length) return false;
    if (files?.some((file) => !file.path && file.text == null)) {
      setError(translateRef.current("chat.attachmentMissingPath"));
      return false;
    }
    if (inputOptions?.inputMode !== "text" && trimmedMessage.startsWith("/")) {
      return submitChatCommand(message, images, files, onDurable, inputOptions, retryOfPromptIds);
    }
    if (agentRunningRef.current || bashRunningRef.current || messageMutationRef.current) return false;
    const isSlashCommandPrompt = !images?.length && !files?.length && trimmedMessage.startsWith("/");

    const isBashCommand = !resumedQueuePromptId && !images?.length && !files?.length && trimmedMessage.startsWith("!");
    if (isBashCommand) {
      const isExcluded = trimmedMessage.startsWith("!!");
      const bashCmd = (isExcluded ? trimmedMessage.slice(2) : trimmedMessage.slice(1)).trim();
      if (!bashCmd) return false;
      await executeBashRef.current?.(bashCmd, isExcluded);
      return true;
    }

    const promptRunId = promptRunIdRef.current + 1;
    sessionLoadAbortRef.current?.abort();
    preparingPromptRunIdRef.current = promptRunId;
    cancelledPromptRunIdRef.current = null;
    const isCurrentPrompt = () => promptRunIdRef.current === promptRunId
      && cancelledPromptRunIdRef.current !== promptRunId;
    promptSettlementByRunRef.current.clear();
    promptSettlementPollByRunRef.current.clear();

    const materialFiles = (files ?? []).filter((file) => !file.path && file.text != null);
    const pasteFiles = materialFiles.filter((file) => file.kind === "paste");
    const attachedTextFiles = materialFiles.filter((file) => file.kind !== "paste");
    const localFiles = (files ?? []).filter((file) => file.path);
    const effectiveMessage = buildLocalFilePrompt(message, localFiles);
    const displayMessage = [
      message.trim(),
      ...localFiles.map((file) => `附件: ${file.name}（${file.size} 字节）\n${file.path}`),
      ...attachedTextFiles.map((file) => `附件: ${file.name}（${file.size} 字节）`),
      ...pasteFiles.map((file) => file.text!.trim()),
    ]
      .filter(Boolean)
      .join("\n\n");

    const imageBlocks = images?.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mimeType, data: img.data } }));
    const clientPromptId = resumedQueuePromptId ?? inputOptions?.submissionId ?? crypto.randomUUID();
    const recoveryDraft = { value: message, files: (files ?? []).map((file) => ({ ...file })), images: (images ?? []).map(({ data, mimeType }) => ({ data, mimeType })),
      ...(inputOptions ? { commandInput: persistentChatInputOptions(inputOptions) } : {}),
      ...(retryOfPromptIds?.length ? { retryOfPromptIds: [...new Set(retryOfPromptIds)] } : {}),
    };
    const userMsg: import("@/lib/types").UserMessage = {
      role: "user",
      clientPromptId,
      recoveryDraft,
      content: imageBlocks?.length
        ? [...(displayMessage ? [{ type: "text" as const, text: displayMessage }] : []), ...imageBlocks]
        : displayMessage,
      timestamp: Date.now(),
    };
    const replacement = replaceFailedPromptMessage(messages, entryIds, userMsg);
    setMessages(replacement.messages);
    setEntryIds(replacement.entryIds);
    optimisticUserMessageKeyRef.current = userMessageKey(userMsg);
    cancelPreparedPromptRef.current = () => {
      setMessages((current) => current.map((entry) => entry === userMsg ? { ...entry, sendError: t("chat.sendCancelled") } : entry));
    };
    promptRunIdRef.current = promptRunId;
    promptSubmissionRef.current = null;
    setReplyHistorySettling(false);
    suppressCompletionNotificationRef.current = false;
    agentRunningRef.current = true;
    setStatusClock(null);
    activityClockRef.current = Date.now();
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
    const recovery: PendingPrompt = { branchAnchorId: entryIds.filter(Boolean).at(-1), id: clientPromptId, scope: sessionIdRef.current ?? `new:${newSessionCwd}`, message: userMsg, draft: recoveryDraft };
    const sendPrompt = async (sid: string, promptMaterials: PromptMaterialReference[]) => {
      // Preparation has ended, so Stop must reach the server. Admission is
      // still pending until the POST returns its exact queued command receipt.
      const submission = { runId: promptRunId, sid, idempotencyKey: clientPromptId, pending: true, commandId: null as string | null };
      promptSubmissionRef.current = submission;
      promptRequestStarted = true;
      try {
        const receipt = await sendAgentCommand<DispatchReceipt>(sid, {
          type: "prompt",
          ...(inputOptions?.inputMode === "text" ? { type: "submit_input", inputMode: "text" } : {}),
          idempotencyKey: clientPromptId,
          message: effectiveMessage,
          ...(promptMaterials.length ? { materials: promptMaterials } : {}),
          ...(piImages?.length ? { images: piImages } : {}),
        });
        // A late acknowledgement belongs only to this submission object.
        // Stop's exact-key cancellation intent also covers admission after it.
        if (receipt?.sessionId === sid) {
          submission.commandId = receipt.commandId;
        }
      } finally {
        submission.pending = false;
      }
    };

    try {
      // Commit original text and attachment bytes before starting network work.
      await savePendingPrompt(recovery);
      if (!isCurrentPrompt()) return false;
      onDurable?.(clientPromptId);
      // Optional answer modules must durably save controls before a follow-up
      // can read them. A save failure keeps the original prompt recoverable.
      const stateSessionId = sessionIdRef.current;
      if (stateSessionId) await flushPendingAnswerState(stateSessionId);
      if (!isCurrentPrompt()) return false;
      const promptMaterials = materialFiles.length ? await uploadPromptMaterialFiles(materialFiles) : [];
      if (!isCurrentPrompt()) return false;
      if (isNew && newSessionCwd) {
        const existingSid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
        const sid = existingSid ?? await ensureNewSession();
        if (!isCurrentPrompt()) return false;

        if (sid) {
          sentSessionId = sid;
          await savePendingPrompt({ ...recovery, scope: sid });
          if (!isCurrentPrompt()) return false;
          promoteNewSession(0, displayMessage.slice(0, 2_000));
          await ensureEventsConnected(sid);
          if (!isCurrentPrompt()) return false;
          preparingPromptRunIdRef.current = null;
          cancelPreparedPromptRef.current = null;
          await sendPrompt(sid, promptMaterials);
        }
      } else if (session) {
        sentSessionId = session.id;
        await ensureEventsConnected(session.id);
        if (!isCurrentPrompt()) return false;
        preparingPromptRunIdRef.current = null;
        cancelPreparedPromptRef.current = null;
        await sendPrompt(session.id, promptMaterials);
      }
      if (isCurrentPrompt() && isSlashCommandPrompt && sentSessionId) {
        void waitForPromptSettlement(sentSessionId, promptRunId);
      }
      return isCurrentPrompt() && promptRequestStarted;
    } catch (e) {
      if (!isCurrentPrompt()) return false;
      console.error("Failed to send message:", e);
      // A failed prompt POST is ambiguous: the server may have accepted it
      // before the response connection was lost. Keep SSE alive until the
      // server confirms idle so a real run cannot continue unseen.
      const definitivelyRejected = e instanceof AgentCommandError && e.status >= 400 && e.status < 500;
      if (promptRequestStarted && sentSessionId && !definitivelyRejected) {
        void waitForPromptSettlement(sentSessionId, promptRunId);
        return false;
      }
      agentRunningRef.current = false;
      closeEvents();
      const optimisticKey = optimisticUserMessageKeyRef.current;
      const sendError = e instanceof EventStreamConnectionError
        ? e.message
        : e instanceof Error ? e.message : String(e);
      if (optimisticKey) {
        setMessages((prev) => {
          return prev.map(entry => entry.role === "user" && entry.clientPromptId === clientPromptId
            ? { ...entry, sendError } : entry);
        });
      }
      // Surface startup, session, and event-stream failures instead of leaving
      // the composer apparently inert. The prompt never reached the agent in
      // this branch, so put the text back without clobbering newer input.
      addNotice({
        type: "error",
        message: sendError,
      });
      optimisticUserMessageKeyRef.current = null;
      setAgentRunning(false);
      setAgentPhase(null);
      dispatch({ type: "end" });
      return false;
    } finally {
      if (preparingPromptRunIdRef.current === promptRunId) {
        preparingPromptRunIdRef.current = null;
        cancelPreparedPromptRef.current = null;
      }
    }
  }, [messages, entryIds, isNew, newSessionCwd, session, ensureNewSession, ensureEventsConnected, promoteNewSession, waitForPromptSettlement, addNotice, closeEvents, t, submitChatCommand]);

  const executeBash = useCallback(async (command: string, excludeFromContext: boolean) => {
    if (agentRunningRef.current || bashRunningRef.current) return;
    const inputText = `${excludeFromContext ? "!!" : "!"}${command}`;
    bashRunningRef.current = true;
    setStatusClock(null);
    activityClockRef.current = Date.now();
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
    queueAdmissionRevisionRef.current++;
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
    answerPreviewStore.stop();
    setAgentPhase({ kind: "stopping" });
    setRetryInfo(null);
    setIsCompacting(false);
    setCompactionStartedAt(null);
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
      const submission = promptSubmissionRef.current;
      const command = submission?.runId === runId && submission.sid === sid
        ? { type: "cancel_prompt_submission", idempotencyKey: submission.idempotencyKey,
          ...(submission.commandId ? { promptCommandId: submission.commandId } : {}) }
        : { type: "abort" };
      await sendAgentCommand(sid, command, { timeoutMs: 10_000 });
      // Unconsumed inputs remain separate durable paused commands. Stopping
      // neither starts another run nor changes the user's current draft.
      if (promptRunIdRef.current !== runId || sessionIdRef.current !== sid) return;
      setQueuedMessages({ steering: [], followUp: [] });
      void finishPromptWithoutStream(sid, runId);
    } catch (e) {
      if (promptRunIdRef.current !== runId) return;
      addNotice({ type: "error", message: t("chat.stopFailed", { reason: e instanceof Error ? e.message : String(e) }) });
    } finally {
      if (abortRequestRunIdRef.current === runId) abortRequestRunIdRef.current = null;
    }
  }, [addNotice, finishPromptWithoutStream, setExtensionDialog, t, answerPreviewStore]);

  const handleDeleteMessage = useCallback(async (message: AgentMessage, entryId?: string) => {
    if (messageMutationRef.current || agentRunningRef.current || bashRunningRef.current || isCompacting) throw new Error(t("chat.deleteMessageBusy"));
    const sid = sessionIdRef.current;
    const promptId = message.role === "user" ? message.clientPromptId : undefined;
    if (!entryId && !promptId) throw new Error(t("chat.deleteMessageUnavailable"));
    messageMutationRef.current = true;
    setDeletingMessage(true);
    historyRevisionRef.current++;
    sessionLoadAbortRef.current?.abort();
    try {
      let deletedIds: string[] = [];
      if (entryId) {
        if (!sid) throw new Error(t("chat.deleteMessageUnavailable"));
        const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}/messages/${encodeURIComponent(entryId)}`, { method: "DELETE", signal: AbortSignal.timeout(30_000) });
        const result = await res.json() as { success?: boolean; error?: string; deletedIds?: string[] };
        if (!res.ok || !result.success) throw new Error(result.error ?? `HTTP ${res.status}`);
        deletedIds = result.deletedIds ?? [entryId];
      }
      // An explicit user deletion can retire a recovery copy without a receipt.
      if (promptId) await confirmPendingPrompts([...new Set([promptId, ...(message.role === "user" ? message.recoveryDraft?.retryOfPromptIds ?? [] : [])])]);
      if (sessionIdRef.current !== sid) return;
      if (entryId) { answerPreviewStore.stop(); setAnswerOutputScope(scope => scope + 1); }
      const remove = new Set(deletedIds);
      const keep = messages.map((entry, index) => !remove.has(entryIds[index]) && !(promptId && entry.role === "user" && entry.clientPromptId === promptId));
      setMessages(messages.filter((_entry, index) => keep[index]));
      setEntryIds(entryIds.filter((_entry, index) => keep[index]));
      if (sid) invalidatePrefetchedSession(sid);
      if (entryId && sid) {
        await loadSession(sid);
        if (activeLeafId) { setActiveLeafId(activeLeafId); await loadContext(sid, activeLeafId); }
      }
    } finally { messageMutationRef.current = false; setDeletingMessage(false); }
  }, [activeLeafId, entryIds, isCompacting, loadContext, loadSession, messages, t, answerPreviewStore]);

  const handleFork = useCallback(async (entryId: string) => {
    if (bashRunningRef.current) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    setForkingEntryId(entryId);
    try {
      await flushPendingAnswerState(sid);
      if (sessionIdRef.current !== sid) return;
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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setForkingEntryId(null);
    }
  }, [onSessionForked]);

  const handleNavigate = useCallback(async (entryId: string): Promise<boolean> => {
    const sid = sessionIdRef.current;
    if (!sid || agentRunningRef.current || bashRunningRef.current || isCompacting) throw new Error(t("history.busy"));
    await flushPendingAnswerState(sid);
    if (sessionIdRef.current !== sid) return false;
    // Older recovery records predate branch association; retain them on the
    // branch being left rather than injecting them into every future branch.
    if (activeLeafId) {
      const pending = await readPendingPrompts(sid);
      await Promise.all(pending.filter(record => !record.branchAnchorId).map(record => savePendingPrompt({ ...record, branchAnchorId: activeLeafId })));
    }
    const result = await sendAgentCommand<{ cancelled?: boolean }>(sid, { type: "navigate_tree", targetId: entryId });
    if (result?.cancelled || sessionIdRef.current !== sid) return false;
    editedBranchRef.current = { sid, target: entryId, previousLeaf: editedBranchRef.current?.sid === sid ? editedBranchRef.current.previousLeaf : data?.leafId ?? activeLeafId };
    if (!await loadContext(sid, entryId)) throw new Error(t("history.loadError"));
    if (activeLeafId !== entryId) { answerPreviewStore.stop(); setAnswerOutputScope(scope => scope + 1); }
    setActiveLeafId(entryId);
    return true;
  }, [activeLeafId, data?.leafId, isCompacting, loadContext, t, answerPreviewStore]);

  const handleRewindRecovery = useCallback(async (message: import("@/lib/types").UserMessage) => {
    if (agentRunningRef.current || bashRunningRef.current || isCompacting) throw new Error(t("history.busy"));
    const index = messages.findIndex(entry => entry.role === "user" && entry.clientPromptId === message.clientPromptId);
    if (index < 0 || !message.clientPromptId || entryIds[index]) throw new Error(t("history.loadError"));
    const sid = sessionIdRef.current;
    const prefix = messages.slice(0, index);
    const prefixIds = entryIds.slice(0, index);
    const target = prefixIds.filter(Boolean).at(-1);
    // A local failure has no tree entry. Navigate only if later persisted
    // history exists; otherwise the runtime is already at its parent.
    if (!target && entryIds.slice(index).some(Boolean)) throw new Error(t("history.loadError"));
    if (target && entryIds.slice(index).some(Boolean) && !await handleNavigate(target)) return false;
    if (sessionIdRef.current !== sid) return false;
    const retired = messages.slice(index).flatMap((entry, offset) => entry.role === "user" && !entryIds[index + offset] && entry.clientPromptId
      ? [entry.clientPromptId, ...(entry.recoveryDraft?.retryOfPromptIds ?? [])] : []);
    await Promise.all([...new Set(retired)].map(dismissPendingPrompt));
    if (sessionIdRef.current !== sid) return false;
    historyRevisionRef.current++;
    sessionLoadAbortRef.current?.abort();
    setMessages(prefix);
    setEntryIds(prefixIds);
    return true;
  }, [messages, entryIds, isCompacting, handleNavigate, t]);

  const handleLeafChange = useCallback(async (leafId: string | null) => {
    if (agentRunningRef.current || bashRunningRef.current || isCompacting) { setError(t("history.busy")); return; }
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await flushPendingAnswerState(sid);
      if (sessionIdRef.current !== sid) return;
      // Resolve the server's selected branch before optional outputs read it.
      if (leafId) {
        const result = await sendAgentCommand<{ cancelled?: boolean }>(sid, { type: "navigate_tree", targetId: leafId });
        if (result?.cancelled || sessionIdRef.current !== sid) return;
      }
      if (!await loadContext(sid, leafId)) throw new Error(t("history.loadError"));
      if (sessionIdRef.current !== sid) return;
      editedBranchRef.current = null;
      if (activeLeafId !== leafId) { answerPreviewStore.stop(); setAnswerOutputScope(scope => scope + 1); }
      setActiveLeafId(leafId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [activeLeafId, isCompacting, loadContext, t, answerPreviewStore]);

  const switchHistoryBranch = useCallback(async (leafId: string): Promise<boolean> => {
    const sid = sessionIdRef.current;
    if (!sid || agentRunningRef.current || bashRunningRef.current || isCompacting) throw new Error(t("history.busy"));
    await flushPendingAnswerState(sid);
    if (sessionIdRef.current !== sid) return false;
    const result = await sendAgentCommand<{ cancelled?: boolean }>(sid, { type: "navigate_tree", targetId: leafId });
    if (result?.cancelled || sessionIdRef.current !== sid) return false;
    if (!await loadContext(sid, leafId)) throw new Error(t("history.loadError"));
    editedBranchRef.current = null;
    if (activeLeafId !== leafId) { answerPreviewStore.stop(); setAnswerOutputScope(scope => scope + 1); }
    setActiveLeafId(leafId);
    return true;
  }, [activeLeafId, isCompacting, loadContext, t, answerPreviewStore]);

  const forkHistoryQuestion = useCallback(async (entryId: string, draft: ChatDraft): Promise<boolean> => {
    const sid = sessionIdRef.current;
    if (!sid || agentRunningRef.current || bashRunningRef.current || isCompacting) throw new Error(t("history.busy"));
    await flushPendingAnswerState(sid);
    if (sessionIdRef.current !== sid) return false;
    const result = await sendAgentCommand<{ cancelled?: boolean; newSessionId?: string }>(sid, { type: "fork", entryId });
    if (result?.cancelled || !result?.newSessionId) return false;
    // Seed only the newly-created conversation. The originating draft is untouched.
    setDraft(result.newSessionId, draft);
    if (sessionIdRef.current === sid) onSessionForked?.(result.newSessionId);
    return true;
  }, [isCompacting, onSessionForked, t]);

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
        await ensureEventsConnected(sid);
        try {
          let result: { compacted?: boolean } | undefined;
          try {
            result = await sendAgentCommand<{ compacted?: boolean }>(sid, { type: "set_model", provider, modelId });
          } catch (error) {
            // Compaction may already have changed the transcript even if the
            // smaller model could not be selected.
            await loadSession(sid, true).catch(() => undefined);
            throw error;
          }
          setCurrentModelOverride({ provider, modelId });
          if (result?.compacted) await loadSession(sid, true).catch(() => undefined);
          await refreshContextUsage(sid);
        } finally {
          if (!agentRunningRef.current && !bashRunningRef.current) closeEvents();
        }
      },
      (e) => {
        console.error("Failed to set model:", e);
        addNotice({ type: "error", message: t("modelCompaction.switchFailed", { error: e instanceof Error ? e.message : String(e) }) });
      },
    );
  }, [addNotice, closeEvents, ensureEventsConnected, isNew, loadSession, newSessionDefaultModel, refreshContextUsage, setNewSessionModel, t]);

  const handleCompact = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || isCompacting || manualCompactionPendingRef.current) return;
    manualCompactionPendingRef.current = true;
    setIsCompacting(true);
    setCompactionStartedAt(null);
    setCompactError(null);
    setCompactResult(null);
    try {
      await ensureEventsConnected(sid);
      const result = await sendAgentCommand<CompactCommandResult>(sid, { type: "compact" });
      setCompactResult(readCompactResult(result, "manual"));
      await loadSession(sid, true);
    } catch (e) {
      setCompactError(e instanceof Error ? e.message : String(e));
      setCompactResult(null);
    } finally {
      manualCompactionPendingRef.current = false;
      setIsCompacting(false);
      setCompactionStartedAt(null);
      if (!agentRunningRef.current && !bashRunningRef.current) closeEvents();
    }
  }, [closeEvents, ensureEventsConnected, isCompacting, loadSession]);

  const handleDismissCompactError = useCallback(() => {
    setCompactError(null);
  }, []);

  const handleDismissCompactResult = useCallback(() => {
    setCompactResult(null);
  }, []);

  const modelLoadIdRef = useRef(0);
  const loadModels = useCallback(async (signal?: AbortSignal, forceRefresh = false) => {
    const loadId = ++modelLoadIdRef.current;
    const modelCwd = newSessionCwd ?? session?.cwd ?? "";
    const d = await fetchModelCatalog({
      forceRefresh,
      ...(modelCwd ? { cwd: modelCwd } : {}),
      ...(signal ? { signal } : {}),
    });
    if (signal?.aborted || loadId !== modelLoadIdRef.current) return;
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

    let ownsCompaction = false;
    try {
      switch (commandName) {
        case "compact": {
          if (!sid || isCompacting || manualCompactionPendingRef.current) return complete({ handled: true, error: "No active session to compact" });
          ownsCompaction = true;
          manualCompactionPendingRef.current = true;
          setIsCompacting(true);
          setCompactionStartedAt(null);
          setCompactError(null);
          setCompactResult(null);
          await ensureEventsConnected(sid);
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
          const sequence = ++statsRefreshSequence.current;
          const runId = promptRunIdRef.current;
          const response = await fetch(`/api/sessions/${encodeURIComponent(sid)}/stats`);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const stats = await response.json() as SessionStatsInfo;
          if (sessionIdRef.current === sid && promptRunIdRef.current === runId && sequence === statsRefreshSequence.current) {
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
      if (ownsCompaction) {
        manualCompactionPendingRef.current = false;
        setIsCompacting(false);
        setCompactionStartedAt(null);
        if (!agentRunningRef.current && !bashRunningRef.current) closeEvents();
      }
    }
  }, [addNotice, closeEvents, ensureEventsConnected, ensureNewSession, isCompacting, loadModels, loadSession, loadSlashCommands, promoteNewSession, onSessionStatsPanelOpen]);

  // Queued (undelivered) messages live in the queue panel only; the chat gets
  // the real user message when pi delivers it (user message_end event). An
  // optimistic chat bubble here would duplicate the queue panel and turn into
  // a ghost message if the queue is recalled.
  const handleSteer = useCallback(async (message: string, images?: AttachedImage[]) => {
    const sid = sessionIdRef.current;
    if (!sid) return false;
    const runId = promptRunIdRef.current;
    const revision = queueAdmissionRevisionRef.current;
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    setQueuedMessages((current) => appendQueuedMessage(current, "steering", message));
    try {
      await flushPendingAnswerState(sid);
      if (sessionIdRef.current !== sid) return false;
      if (promptRunIdRef.current !== runId || queueAdmissionRevisionRef.current !== revision) {
        setQueuedMessages((current) => removeLastQueuedMessage(current, "steering", message));
        return false;
      }
      await sendAgentCommand(sid, {
        type: "steer",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
      return true;
    } catch (e) {
      if (sessionIdRef.current === sid) setQueuedMessages((current) => removeLastQueuedMessage(current, "steering", message));
      console.error("Failed to steer:", e);
      if (sessionIdRef.current === sid) setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }, []);

  const handlePromptWithStreamingBehavior = useCallback(async (
    message: string,
    behavior: "steer" | "followUp",
    images?: AttachedImage[],
  ) => {
    const sid = sessionIdRef.current;
    if (!sid) return false;
    const runId = promptRunIdRef.current;
    const revision = queueAdmissionRevisionRef.current;
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    const queueKind = behavior === "steer" ? "steering" : "followUp";
    setQueuedMessages((current) => appendQueuedMessage(current, queueKind, message));
    try {
      await flushPendingAnswerState(sid);
      if (sessionIdRef.current !== sid) return false;
      if (promptRunIdRef.current !== runId || queueAdmissionRevisionRef.current !== revision) {
        setQueuedMessages((current) => removeLastQueuedMessage(current, queueKind, message));
        return false;
      }
      await sendAgentCommand(sid, {
        type: "prompt",
        message,
        streamingBehavior: behavior,
        ...(piImages?.length ? { images: piImages } : {}),
      });
      return true;
    } catch (e) {
      if (sessionIdRef.current === sid) setQueuedMessages((current) => removeLastQueuedMessage(current, queueKind, message));
      console.error("Failed to queue prompt:", e);
      if (sessionIdRef.current === sid) setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }, []);

  const handleFollowUp = useCallback(async (message: string, images?: AttachedImage[]) => {
    const sid = sessionIdRef.current;
    if (!sid) return false;
    const runId = promptRunIdRef.current;
    const revision = queueAdmissionRevisionRef.current;
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    setQueuedMessages((current) => appendQueuedMessage(current, "followUp", message));
    try {
      await flushPendingAnswerState(sid);
      if (sessionIdRef.current !== sid) return false;
      if (promptRunIdRef.current !== runId || queueAdmissionRevisionRef.current !== revision) {
        setQueuedMessages((current) => removeLastQueuedMessage(current, "followUp", message));
        return false;
      }
      await sendAgentCommand(sid, {
        type: "follow_up",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
      return true;
    } catch (e) {
      if (sessionIdRef.current === sid) setQueuedMessages((current) => removeLastQueuedMessage(current, "followUp", message));
      console.error("Failed to follow up:", e);
      if (sessionIdRef.current === sid) setError(e instanceof Error ? e.message : String(e));
      return false;
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

  const handlePendingInputAction = useCallback(async (inputId: string, action: "queue" | "delete") => {
    const sid = sessionIdRef.current;
    if (!sid) throw new Error("Session unavailable");
    // Moving guidance into the next-turn inbox can start a model request.
    // Deleting it remains available even when optional answer saves fail.
    if (action === "queue" && !await prepareAnswerStateForSubmission(sid)) throw new Error("Queue action cancelled");
    await sendAgentCommand(sid, { type: "pending_input_action", inputId, action });
  }, [prepareAnswerStateForSubmission]);

  const handleRecallQueue = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    queueAdmissionRevisionRef.current++;
    try {
      // The server persists each full message as a paused queue entry before
      // clearing SDK input. Command SSE/polling restores even a lost HTTP reply.
      await sendAgentCommand(sid, { type: "recall_queued_inputs" });
    } catch (e) {
      console.error("Failed to recall queued messages:", e);
      addNotice({ type: "error", message: "Failed to recall queued messages" });
    }
  }, [addNotice]);

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

  const pauseHistoryFollow = useCallback(() => {
    stopInitialBottomPin();
    completionScrollAllowedRef.current = false;
    liveOutputFollowRef.current = false;
    liveTailPinnedScrollTopRef.current = null;
    setLiveOutputFollowPaused(true);
  }, [stopInitialBottomPin]);

  const startInitialBottomPin = useCallback(() => {
    stopInitialBottomPin();
    const container = scrollContainerRef.current;
    if (!container) return;

    const stopFollowing = followChatBottom(container, () => scrollToBottom("instant"));
    const cleanup = () => {
      stopFollowing();
      if (initialBottomPinCleanupRef.current === cleanup) {
        initialBottomPinCleanupRef.current = null;
      }
    };
    initialBottomPinCleanupRef.current = cleanup;

  }, [scrollToBottom, stopInitialBottomPin]);

  const handleScrollToBottom = useCallback(() => {
    stopInitialBottomPin();
    completionScrollAllowedRef.current = true;
    liveOutputFollowRef.current = true;
    setLiveOutputFollowPaused(false);
    startInitialBottomPin();
  }, [startInitialBottomPin, stopInitialBottomPin]);

  const scrollUserMsgToTop = useCallback(() => {
    stopInitialBottomPin();
    const container = scrollContainerRef.current;
    const el = lastUserMsgRef.current;
    if (!container || !el) return false;
    const elAbsTop = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    const targetScrollTop = Math.max(0, elAbsTop - 16);
    liveTailPinnedScrollTopRef.current = targetScrollTop;
    ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
    // Virtual rows publish measured heights in the next frame. A smooth
    // animation still sits at the old viewport when that frame captures its
    // reading anchor, so the correction can cancel the send jump entirely.
    container.scrollTo({ top: targetScrollTop, behavior: "instant" });
    return true;
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
    const target = event.target instanceof Element ? event.target : null;
    const isConversationViewport = Boolean(target?.closest("#chat-scroll-container, .chat-column-scroll-rail"));
    if (event instanceof KeyboardEvent) {
      if (!SCROLL_KEYS.has(event.key)) return;
      if (target?.closest("input, textarea, [contenteditable='true'], button, a, select, [role='button']")) return;
      if (!isConversationViewport && target !== document.body && target !== document.documentElement) return;
    } else if (!isConversationViewport) {
      // Opening a side panel changes wrapping, but is not a request to scroll
      // the conversation. Keep its bottom anchor through those layout changes.
      return;
    }
    stopInitialBottomPin();
    userScrollIntentUntilRef.current = Date.now() + USER_SCROLL_INTENT_MS;
    const isDirectScrollIntent = event instanceof KeyboardEvent
      || (event instanceof WheelEvent && isConversationViewport)
      || (event instanceof TouchEvent && isConversationViewport)
      || (event instanceof PointerEvent && Boolean(target?.closest(".chat-column-scroll-rail")));
    if ((agentRunningRef.current || bashRunningRef.current) && isDirectScrollIntent) completionScrollAllowedRef.current = false;
    if (liveOutputAutoScrollEnabled && (agentRunningRef.current || bashRunningRef.current) && isDirectScrollIntent) {
      liveOutputFollowRef.current = false;
      setLiveOutputFollowPaused(true);
    }
  }, [liveOutputAutoScrollEnabled, stopInitialBottomPin]);

  const handleScrollPositionChange = useCallback(() => {
    if (clampLiveTailScroll()) return;
    if (!agentRunningRef.current && !bashRunningRef.current) return;
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
          if (agentState.state && agentState.state.runtime !== "idle") restoreStatusClock(agentState.state);
          invalidatePrefetchedSession(session.id);
          if (agentState.state?.isCompacting) void connectEvents(session.id);
          if (agentState.state?.isStreaming || agentState.state?.isPromptRunning || agentState.state?.runtime === "running" || agentState.state?.runtime === "stopping") {
            agentRunningRef.current = true;
            setAgentRunning(true);
            setAgentPhase(agentState.state.runtime === "stopping" ? { kind: "stopping" }
              : agentState.state.activeTools?.length ? { kind: "running_tools", tools: agentState.state.activeTools }
                : agentState.state.statusPhaseKind === "agent" ? null
                  : agentState.state.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" });
            dispatch({ type: "start" });
            if (!agentState.state.isCompacting) void connectEvents(session.id);
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
          setCompactionStartedAt(agentState.state.isCompacting ? agentState.state.compactionStartedAt ?? null : null);
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
          if (agentState.state.toolPermission !== undefined) acceptToolPermission(agentState.state.toolPermission);
        }
      });
    } else if (newSessionCwd) {
      const initialRun = promptRunIdRef.current;
      void readPendingPrompts(`new:${newSessionCwd}`).then((pending) => {
        if (promptRunIdRef.current !== initialRun || sessionIdRef.current) return;
        const recovered = mergePendingPrompts([], [], pending);
        setMessages(recovered.messages);
        setEntryIds(recovered.entryIds);
      }).catch((error) => setError(String(error)));
    }
    return () => {
      bashRecoveryIdRef.current += 1;
      sessionLoadAbortRef.current?.abort();
      sessionLoadAbortRef.current = null;
      if (session) invalidatePrefetchedSession(session.id);
      answerPreviewStore.stop();
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
    const onWheel = (event: WheelEvent) => {
      markUserScrollIntent(event);
      scrollLiveTailWheel(container, event, liveTailPinnedScrollTopRef.current);
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    container.addEventListener("touchstart", markUserScrollIntent, { passive: true });
    container.addEventListener("scroll", handleScrollPositionChange, { passive: true });
    return () => {
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("touchstart", markUserScrollIntent);
      container.removeEventListener("scroll", handleScrollPositionChange);
    };
  }, [messages.length, loading, handleScrollPositionChange, markUserScrollIntent]);

  useEffect(() => stopInitialBottomPin, [stopInitialBottomPin]);

  useLayoutEffect(() => {
    if (!liveOutputAutoScrollEnabled || (!agentRunning && !bashRunning) || loading) return;
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
  }, [agentRunning, bashRunning, liveOutputAutoScrollEnabled, loading, scrollToBottom]);

  useLayoutEffect(() => {
    // Loading may publish the message array before the loading shell is
    // replaced by the scroll container. Do not consume the one-shot initial
    // scroll until that container is mounted, otherwise switching sessions
    // can leave the newly selected conversation at the top.
    if (loading || messages.length === 0) return;

    if (pendingScrollToUserRef.current) {
      if (scrollUserMsgToTop()) {
        pendingScrollToUserRef.current = false;
        initialScrollDoneRef.current = true;
      }
    } else if (!initialScrollDoneRef.current) {
      initialScrollDoneRef.current = true;
      startInitialBottomPin();
    } else if (!agentRunningRef.current && !bashRunningRef.current && completionScrollAllowedRef.current && liveOutputAutoScrollEnabled) {
      scrollToBottom("smooth");
    }
  }, [messages.length, agentRunning, liveOutputAutoScrollEnabled, loading, scrollToBottom, scrollUserMsgToTop, startInitialBottomPin]);

  // Load model list
  useEffect(() => {
    const controller = new AbortController();
    loadModels(controller.signal, (modelsRefreshKey ?? 0) > 0).catch((e) => {
      if (e instanceof DOMException && e.name === "AbortError") return;
    });
    return () => controller.abort();
  }, [loadModels, modelsRefreshKey]);

  // A file edited outside Settings produces no refresh notification. Recheck
  // errors until the config recovers, without touching the running session.
  useEffect(() => {
    if (!modelError) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let loading = false;
    const retry = async () => {
      clearTimeout(timer);
      if (controller.signal.aborted || loading) return;
      if (document.visibilityState === "visible") {
        loading = true;
        try {
          await loadModels(controller.signal, true);
        } catch {
          // Keep the last actionable error until a successful response.
        } finally {
          loading = false;
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(retry, 5_000);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void retry();
    };
    timer = setTimeout(retry, 5_000);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [modelError, loadModels, modelsRefreshKey]);

  // Model/runtime errors are actionable when they first appear, but a failed
  // model switch (for example to a model whose context window is too small)
  // must not leave the composer blocked by a permanent banner.
  useEffect(() => {
    if (!modelError) return;
    const timer = setTimeout(() => setModelError(null), MODEL_ERROR_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [modelError]);

  useEffect(() => {
    if (!compactResult) return;
    const t = setTimeout(() => setCompactResult(null), 6000);
    return () => clearTimeout(t);
  }, [compactResult]);

  useEffect(() => {
    if (!compactError) return;
    const timer = setTimeout(() => setCompactError(null), COMPACT_ERROR_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [compactError]);

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

  return {
    // State
    toolPermission, permissionSaving, handleToolPermission, toolReviews,
    nestedCallsStore, data, loading, error, activeLeafId, answerOutputScope, answerOutputPreviews, messages, entryIds, streamState, replyHistorySettling,
    agentRunning, modelNames, modelList, modelError, modelThinkingLevels, modelThinkingLevelMaps, newSessionModel, thinkingLevel,
    retryInfo, contextUsage: effectiveContextUsage, systemPrompt, systemPromptBinding, systemPromptSelection, systemPromptSaving, forkingEntryId,
    isCompacting, compactionStartedAt, compactError, compactResult, currentModel, displayModel, sessionStats,
    slashCommands, slashCommandsLoading, slashCommandsError, commandCatalog, chatCommands, queuedMessages, capabilities, capabilitiesSaving,
    liveOutputFollowPaused: liveOutputAutoScrollEnabled && agentRunning && liveOutputFollowPaused,
    notices: noticeState.visible, extensionDialog, extensionCustomUi, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput,
    isAutoModelSelection: isNew && displayModel === null,
    agentPhase,
    isNew,
    // Refs
    sessionIdRef, eventSourceRef, messagesEndRef, scrollContainerRef, activityClockRef, statusClock,
    lastUserMsgRef, pendingScrollToUserRef, initialScrollDoneRef,
    // Actions
    handleSend, handleAbort, handleFork, handleNavigate, handleRewindRecovery, handleModelChange, handleDeleteMessage, deletingMessage,
    handleScrollToBottom, pauseHistoryFollow,
    switchHistoryBranch, forkHistoryQuestion,
    handleCompact, handleDismissCompactError, handleDismissCompactResult, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    handleRecallQueue, handlePendingInputAction, prepareAnswerStateForSubmission,
    handleBuiltinSlashCommand,
    handleThinkingLevelChange, handleCapabilitySelection, handleSystemPromptSelection, loadSlashCommands, setActiveLeafId, setData, setMessages,
    dispatch, setAgentRunning, setForkingEntryId,
    bashRunning, pendingBash,
    // Subscriptions
    handleAgentEventRef,
  };
}
