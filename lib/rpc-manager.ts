import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { createAgentSessionFromServices, createAgentSessionServices, getAgentDir, initTheme, SessionManager, SettingsManager, type AgentSessionServices } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { validateAgentImages } from "./image-attachments";
import { invalidateModelsCache } from "./models-cache";
import { resolveVisibleModels, selectInitialModelScope } from "./model-scope";
import { applyConfiguredImageInput } from "./model-capabilities";
import { resolveDefaultModelPreference } from "./model-policy";
import {
  applyExtensionLoadPlan,
  resolveExtensionLoadPlan,
} from "./extension-config";
import { cacheSessionPath, invalidateSessionListCache } from "./session-reader";
import { ensureWindowsBashShellPath } from "./windows-bash";
import { persistLazySessionManager } from "./session-persistence";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike, ExtensionUiContextLike, ToolInfo } from "./pi-types";
import type { ExtensionUiRequest, ExtensionUiResponse, ExtensionWidgetItem } from "./types";
import { createHeadlessCustomUiTui, DEFAULT_CUSTOM_UI_COLUMNS } from "./custom-ui-terminal";
import type { Runtime, TaskRuntimeActivity, TaskRuntimeActivityKind, TaskRuntimeSnapshot } from "./task-status";
import { projectTaskRun } from "./task-run";
import {
  assertCurrentAgentRuntimeProfile,
  getAgentRuntimeProfile,
  type AgentRuntimeProfile,
} from "./agent-runtime-profile";
import {
  bindSessionAgentRuntimeProfile,
  quarantineUnboundSessionFile,
  readAgentProfileStore,
  resolveSessionAgentRuntimeProfile,
} from "./agent-profile-store";
import {
  beginPromptRun,
  finishPromptRun,
  type PromptRunIdentity,
} from "./prompt-run-registry";
import { bindTeamPromptContext, validateTeamExecutionContext } from "./team-prompt-context";
import type { TeamExecutionContext } from "./team-types";
import type { SessionMessageSourceKind, SessionRoomContext } from "./session-message-types";
import { captureTeamRuntimeToolResult } from "./team-runtime-evidence";
import { getRoom } from "./room-store";
import { TeamError } from "./team-errors";
import {
  DEVICE_CONTROL_AGENT_TOOLS,
  resolveAgentToolsForRuntimeProfile,
} from "./tool-presets";
import {
  TASK_ACTIVITY_STREAM_INTERVAL_MS,
  activityFromMessage,
  compactTaskActivityText,
} from "./rpc-task-activity";
import { CUSTOM_UI_KEYBINDINGS, PLAIN_TEXT_THEME } from "./rpc-ui-adapter";
import { readSystemPromptConfig } from "./system-prompt-config";
import {
  appendSessionSystemPromptBinding,
  copySessionSystemPromptBinding,
  createSessionSystemPromptBinding,
  readLatestSessionSystemPromptBinding,
  resolveSessionSystemPrompt,
} from "./session-system-prompt";
import type { SessionSystemPromptBinding, SystemPromptSelection } from "./system-prompt-types";
import { buildPromptWithMaterials, resolvePromptMaterialReferences, restorePromptMaterialDisplayPreview } from "./prompt-materials";
import type { PromptMaterialReference } from "./prompt-material-format";
import type { UserInputResult } from "./user-input";
import { estimateContextUsageBreakdown } from "./context-usage";
import {
  fitToolNamesWithinDefinitionBudget,
  estimateToolDefinitionPromptTokens,
  TOOL_DEFINITION_PROMPT_TOKEN_LIMIT,
} from "./tool-definition-budget";
import {
  appendSessionCapabilityPolicy,
  buildSessionCapabilitiesState,
  buildSessionCapabilityCatalog,
  copySessionCapabilityPolicy,
  createSessionCapabilityPolicy,
  resolveSessionCapabilityToolNames,
  restoreSessionCapabilityPolicy,
  selectionFromToolNames,
  type SessionCapabilitiesState,
  type SessionCapabilityPolicy,
  type SessionCapabilitySelection,
} from "./session-capabilities";
import {
  projectToolSelection,
  readProjectToolSettings,
  type ProjectToolSettingsRecord,
} from "./project-tool-settings";
import { resolveProject } from "./worktree";

// ============================================================================
// Types
// ============================================================================

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

type EventListener = (event: AgentEvent) => void;

type PendingUiResponse = {
  resolve: (response: ExtensionUiResponse) => void;
  cancel: () => void;
};

type CustomUiComponent = {
  render: (width: number) => string[];
  handleInput?: (data: string) => void;
  dispose?: () => void;
  invalidate?: () => void;
};

type ActiveCustomUi = {
  component: CustomUiComponent;
  width: number;
  resolve: (value: unknown) => void;
  settled: boolean;
};

type ExtensionUiRequestBody = Record<string, unknown> & {
  method: ExtensionUiRequest["method"];
  timeout?: number;
  expiresAt?: number;
};

type ExtensionCommandContextActionsLike = {
  waitForIdle: () => Promise<void>;
  newSession: () => Promise<{ cancelled: boolean }>;
  fork: () => Promise<{ cancelled: boolean }>;
  navigateTree: (targetId: string, options?: { summarize?: boolean }) => Promise<{ cancelled: boolean }>;
  switchSession: () => Promise<{ cancelled: boolean }>;
  reload: () => Promise<void>;
};

type ExtensionBindingOptions = {
  forceEmptySystemPrompt?: boolean;
};

export interface RpcSessionStartOptions {
  toolNames?: string[];
  capabilitySelection?: SessionCapabilitySelection;
  initialModel?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  systemPromptSelection?: SystemPromptSelection;
  runtimeProfile?: AgentRuntimeProfile;
}

const DEVICE_CONTROL_DENIED_RPC_COMMANDS = new Set(["bash", "abort_bash"]);

// ============================================================================
// AgentSessionWrapper
// Wraps AgentSession with the same interface the rest of the app expects
// ============================================================================

export class AgentSessionWrapper {
  private listeners: EventListener[] = [];
  private pendingUiResponses = new Map<string, PendingUiResponse>();
  private pendingUiRequests = new Map<string, AgentEvent>();
  private activeCustomUis = new Map<string, ActiveCustomUi>();
  private extensionStatuses = new Map<string, string>();
  private extensionWidgets = new Map<string, ExtensionWidgetItem>();
  private promptRunning = false;
  // Synchronous admission guard shared by UI and routed prompts. The guard is
  // set before the async SDK call so two callers cannot both observe idle.
  private promptAdmissionBusy = false;
  private stopping = false;
  private abortGeneration = 0;
  private promptTasks = new Set<Promise<void>>();
  private lastPromptFailed = false;
  private lastPromptErrorSummary: string | undefined;
  private runStartedAt: number | null = null;
  private taskActivity: TaskRuntimeActivity | null = null;
  private cachedSessionTitle: string | null = null;
  private fallbackTaskTitle: string | null = null;
  private lastStreamActivityAt = 0;
  private extensionsBound = false;
  private extensionBindingPromise: Promise<void> | null = null;
  private extensionBindingError: unknown = null;
  private forceEmptySystemPrompt = false;
  private unsubscribe: (() => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private systemPromptReloadTimer: ReturnType<typeof setTimeout> | null = null;
  private systemPromptReloadRequested = 0;
  private systemPromptReloadApplied = 0;
  private systemPromptReloading = false;
  private onDestroyCallbacks = new Set<() => void>();
  private activePromptRun: PromptRunIdentity | undefined;
  private activeCommandId: string | undefined;
  private runtimeToolCalls = new Map<string, { toolName: string; args: unknown }>();
  private capabilityPolicy: SessionCapabilityPolicy;
  private capabilityCatalog: ReturnType<typeof buildSessionCapabilityCatalog>;
  private toolNameCeiling: Set<string> | undefined;
  private pendingProjectCapabilityPolicy: SessionCapabilityPolicy | null = null;
  private pendingProjectAllowedToolNames: Set<string> | null = null;
  private projectAllowedToolNames: Set<string> | undefined;
  private projectManaged: boolean;
  private readonly _projectRoot: string;
  private _alive = true;

  constructor(
    public readonly inner: AgentSessionLike,
    public readonly runtimeProfile: AgentRuntimeProfile = "normal",
    capabilityOptions: {
      policy?: SessionCapabilityPolicy;
      toolNameCeiling?: readonly string[];
      projectRoot?: string;
      projectManaged?: boolean;
    } = {},
  ) {
    this.cachedSessionTitle = inner.sessionManager.getSessionName()?.trim() || null;
    this.capabilityCatalog = buildSessionCapabilityCatalog(inner.getAllTools(), runtimeProfile);
    this.capabilityPolicy = capabilityOptions.policy
      ?? restoreSessionCapabilityPolicy(inner.sessionManager.getEntries(), this.capabilityCatalog, runtimeProfile);
    this.toolNameCeiling = capabilityOptions.toolNameCeiling
      ? new Set(capabilityOptions.toolNameCeiling)
      : undefined;
    this._projectRoot = capabilityOptions.projectRoot ?? inner.sessionManager.getCwd();
    this.projectManaged = capabilityOptions.projectManaged === true;
    if (this.projectManaged) {
      this.projectAllowedToolNames = new Set(resolveSessionCapabilityToolNames(
        this.capabilityCatalog,
        this.capabilityPolicy,
        inner.getAllTools().map((tool) => tool.name),
      ));
    }
  }

  get sessionId(): string {
    return this.inner.sessionId;
  }

  get sessionFile(): string {
    return this.inner.sessionFile ?? "";
  }

  get cwd(): string {
    return this.inner.sessionManager.getCwd();
  }

  get projectRoot(): string {
    // Hot reload can retain a wrapper created before project-scoped tools were
    // introduced. Fall back to its cwd until that wrapper naturally restarts.
    return this._projectRoot ?? this.cwd;
  }

  isAlive(): boolean {
    return this._alive;
  }

  isRunning(): boolean {
    return this._alive && this.getRuntime() !== "idle";
  }

  private refreshCapabilityCatalog(): void {
    this.capabilityCatalog = buildSessionCapabilityCatalog(this.inner.getAllTools(), this.runtimeProfile);
  }

  private resolveCapabilityToolBudget(
    policy: SessionCapabilityPolicy,
    rejectOverBudget: boolean,
  ): { policy: SessionCapabilityPolicy; toolNames: string[]; trimmed: boolean } {
    const allTools = this.inner.getAllTools();
    const requestedToolNames = resolveSessionCapabilityToolNames(
      this.capabilityCatalog,
      policy,
      allTools.map((tool) => tool.name),
      this.toolNameCeiling,
    );
    const budget = fitToolNamesWithinDefinitionBudget(allTools, requestedToolNames);
    if (budget.droppedToolNames.length === 0) {
      return { policy, toolNames: budget.toolNames, trimmed: false };
    }

    if (rejectOverBudget) {
      const requested = new Set(requestedToolNames);
      const requestedTokens = estimateToolDefinitionPromptTokens(allTools.filter((tool) => requested.has(tool.name)));
      throw new Error(
        `Tool definitions require about ${requestedTokens.toLocaleString("en-US")} tokens; the per-session limit is ${TOOL_DEFINITION_PROMPT_TOKEN_LIMIT.toLocaleString("en-US")} tokens. Disable another tool before enabling ${budget.droppedToolNames.join(", ")}.`,
      );
    }

    const enabledCapabilityIds = selectionFromToolNames(budget.toolNames, this.capabilityCatalog).enabledCapabilityIds ?? [];
    return {
      policy: {
        ...policy,
        revision: policy.revision + 1,
        preset: "custom",
        enabledCapabilityIds,
        updatedAt: new Date().toISOString(),
      },
      toolNames: budget.toolNames,
      trimmed: true,
    };
  }

  private applySessionCapabilities(options: { persistBudgetTrim?: boolean } = {}): void {
    this.refreshCapabilityCatalog();
    const resolved = this.resolveCapabilityToolBudget(this.capabilityPolicy, false);
    this.capabilityPolicy = resolved.policy;
    if (resolved.trimmed && options.persistBudgetTrim && !this.projectManaged) {
      appendSessionCapabilityPolicy(this.inner.sessionManager, this.capabilityPolicy);
    }
    this.setForceEmptySystemPrompt(resolved.toolNames.length === 0);
    this.inner.setActiveToolsByName(resolved.toolNames);
    this.applyForcedEmptySystemPrompt();
  }

  getSessionCapabilities(): SessionCapabilitiesState {
    this.refreshCapabilityCatalog();
    return buildSessionCapabilitiesState(
      this.capabilityCatalog,
      this.capabilityPolicy,
      this.inner.getActiveToolNames(),
    );
  }

  initializeSessionCapabilities(): void {
    this.applySessionCapabilities({ persistBudgetTrim: true });
  }

  applyProjectCapabilitySettings(record: ProjectToolSettingsRecord): "applied" | "deferred" {
    this.refreshCapabilityCatalog();
    const policy = createSessionCapabilityPolicy(
      projectToolSelection(record),
      this.capabilityCatalog,
      this.runtimeProfile,
      record.revision - 1,
      this.capabilityPolicy,
    );
    const resolved = this.resolveCapabilityToolBudget(policy, true);
    const projectAllowedToolNames = new Set(resolveSessionCapabilityToolNames(
      this.capabilityCatalog,
      resolved.policy,
      this.inner.getAllTools().map((tool) => tool.name),
    ));
    this.projectManaged = true;
    if (this.isRunning()) {
      this.pendingProjectCapabilityPolicy = resolved.policy;
      this.pendingProjectAllowedToolNames = projectAllowedToolNames;
      return "deferred";
    }
    this.capabilityPolicy = resolved.policy;
    this.projectAllowedToolNames = projectAllowedToolNames;
    this.pendingProjectCapabilityPolicy = null;
    this.pendingProjectAllowedToolNames = null;
    this.applySessionCapabilities();
    this.emit({ type: "capabilities_changed", capabilities: this.getSessionCapabilities() });
    invalidateSessionListCache();
    return "applied";
  }

  private flushPendingProjectCapabilitySettings(): void {
    if (!this.pendingProjectCapabilityPolicy || this.isRunning()) return;
    this.capabilityPolicy = this.pendingProjectCapabilityPolicy;
    if (this.pendingProjectAllowedToolNames) this.projectAllowedToolNames = this.pendingProjectAllowedToolNames;
    this.pendingProjectCapabilityPolicy = null;
    this.pendingProjectAllowedToolNames = null;
    this.applySessionCapabilities();
    this.emit({ type: "capabilities_changed", capabilities: this.getSessionCapabilities() });
    invalidateSessionListCache();
  }

  private updateSessionCapabilities(selection: SessionCapabilitySelection): SessionCapabilitiesState {
    if (this.projectManaged) {
      throw new Error("Tools are managed by this project's settings.");
    }
    this.assertSessionIdle("change session tools");
    if (
      selection.expectedRevision !== undefined
      && selection.expectedRevision !== this.capabilityPolicy.revision
    ) {
      throw new Error("Session tools changed in another view. Refresh and try again.");
    }
    const nextPolicy = createSessionCapabilityPolicy(
      selection,
      this.capabilityCatalog,
      this.runtimeProfile,
      this.capabilityPolicy.revision,
      this.capabilityPolicy,
    );
    this.refreshCapabilityCatalog();
    const resolved = this.resolveCapabilityToolBudget(nextPolicy, true);
    this.capabilityPolicy = resolved.policy;
    appendSessionCapabilityPolicy(this.inner.sessionManager, this.capabilityPolicy);
    this.applySessionCapabilities();
    const capabilities = this.getSessionCapabilities();
    this.emit({ type: "capabilities_changed", capabilities });
    invalidateSessionListCache();
    return capabilities;
  }

  async requestSystemPromptReload(): Promise<"reloaded" | "deferred" | "skipped"> {
    if (!this._alive || this.runtimeProfile !== "normal") return "skipped";
    this.systemPromptReloadRequested += 1;
    if (this.isRunning() || this.systemPromptReloading) {
      this.scheduleSystemPromptReload();
      return "deferred";
    }
    await this.flushSystemPromptReload();
    return "reloaded";
  }

  getSystemPromptBinding(): SessionSystemPromptBinding | null {
    return readLatestSessionSystemPromptBinding(this.inner.sessionManager.getEntries());
  }

  async setSystemPromptBinding(selection: SystemPromptSelection): Promise<SessionSystemPromptBinding> {
    this.assertSessionIdle("change the system prompt");
    if (this.runtimeProfile !== "normal") throw new Error("System prompt templates are available only for normal sessions.");
    const previous = this.getSystemPromptBinding();
    const binding = createSessionSystemPromptBinding(selection, readSystemPromptConfig(), previous);
    appendSessionSystemPromptBinding(this.inner.sessionManager, binding);
    invalidateSessionListCache();
    await this.requestSystemPromptReload();
    return binding;
  }

  getActivePromptRunId(): string | undefined {
    return this.activePromptRun?.runId;
  }

  /** Start one ordinary prompt with a stable command correlation id. */
  async startTrackedPrompt(input: {
    commandId: string;
    source: SessionMessageSourceKind;
    roomContext?: SessionRoomContext;
    message: string;
    images?: Array<{ type: "image"; data: string; mimeType: string }>;
    materials?: PromptMaterialReference[];
    teamExecution?: TeamExecutionContext;
  }): Promise<{ accepted: true; sessionId: string; commandId: string; runId: string }> {
    if (input.teamExecution) this.validateTeamRuntimePolicy(input.teamExecution);
    await this.send({ type: "prompt", ...input });
    const runId = this.activePromptRun?.runId;
    if (!runId) throw new Error("Prompt was not admitted by the target session.");
    return { accepted: true, sessionId: this.sessionId, commandId: input.commandId, runId };
  }

  private validateTeamRuntimePolicy(context: TeamExecutionContext): void {
    validateTeamExecutionContext(context, this.sessionId);
    const member = getRoom(context.roomId).members.find((candidate) => candidate.memberId === context.memberId)!;
    if (member.binding.cwd) {
      const normalize = (value: string) => process.platform === "win32" ? resolve(value).toLocaleLowerCase() : resolve(value);
      if (normalize(member.binding.cwd) !== normalize(this.cwd)) throw new TeamError("TEAM_WORKSPACE_CONFLICT", "Team Agent Session cwd does not match its workspace binding.");
    }
    if (member.profile.modelPolicy.mode === "pinned") {
      const model = this.inner.model;
      if (!model || model.provider !== member.profile.modelPolicy.provider || model.id !== member.profile.modelPolicy.modelId) {
        throw new TeamError("TEAM_INVALID_CONTEXT", "Managed Team Agent model drifted from its pinned Profile.");
      }
    }
    if (member.profile.toolPolicy.mode === "allowlist") {
      const expected = [...new Set([...member.profile.toolPolicy.toolNames, "piora_room"])].sort();
      const actual = [...this.inner.getActiveToolNames()].sort();
      if (expected.length !== actual.length || expected.some((name, index) => name !== actual[index])) {
        throw new TeamError("TEAM_INVALID_CONTEXT", "Managed Team Agent tools drifted from its Profile allowlist.");
      }
    }
  }

  getRuntime(): Runtime {
    if (!this._alive) return "idle";
    if (this.stopping) return "stopping";
    if (this.inner.isCompacting) return "compacting";
    if (this.promptAdmissionBusy || this.promptRunning || this.inner.isStreaming || this.inner.isBashRunning) return "running";
    return "idle";
  }

  getTaskRuntimeSnapshot(): TaskRuntimeSnapshot {
    const runtime = this.getRuntime();
    if (runtime === "idle") this.runStartedAt = null;
    else this.runStartedAt ??= Date.now();
    const pendingApproval = this.pendingUiResponses.size > 0 || this.activeCustomUis.size > 0;
    const contextUsage = this.inner.getContextUsage();
    const title = compactTaskActivityText(
      this.cachedSessionTitle || this.fallbackTaskTitle || "",
      80,
    );
    const activeTaskRun = projectTaskRun({
      sessionId: this.sessionId,
      runtime,
      pendingApproval,
      lastPromptFailed: this.lastPromptFailed,
      ...(this.lastPromptErrorSummary ? { errorSummary: this.lastPromptErrorSummary } : {}),
      ...(this.runStartedAt !== null ? { startedAt: this.runStartedAt } : {}),
      ...(title ? { title } : {}),
      ...(this.taskActivity ? { activity: this.taskActivity } : {}),
    });
    return {
      id: this.sessionId,
      runtime,
      pendingApproval,
      lastPromptFailed: this.lastPromptFailed,
      ...(this.lastPromptErrorSummary ? { errorSummary: this.lastPromptErrorSummary } : {}),
      ...(this.runStartedAt !== null ? { startedAt: this.runStartedAt } : {}),
      ...(title ? { title } : {}),
      ...(this.taskActivity ? { activity: this.taskActivity } : {}),
      ...(contextUsage ? { contextUsage } : {}),
      ...(activeTaskRun ? { taskRun: activeTaskRun } : {}),
    };
  }

  setSessionName(name: string): void {
    this.inner.setSessionName(name);
    this.cachedSessionTitle = name.trim() || null;
    notifyRunningChange();
  }

  private setTaskActivity(kind: TaskRuntimeActivityKind, message: unknown, streaming = false): void {
    const now = Date.now();
    if (streaming && now - this.lastStreamActivityAt < TASK_ACTIVITY_STREAM_INTERVAL_MS) return;
    const compact = compactTaskActivityText(message);
    if (!compact) return;
    this.taskActivity = { kind, message: compact, updatedAt: now };
    if (streaming) this.lastStreamActivityAt = now;
  }

  private beginRun(kind: TaskRuntimeActivityKind, message: unknown): void {
    this.runStartedAt = Date.now();
    this.lastStreamActivityAt = 0;
    this.setTaskActivity(kind, message);
  }

  private updateActivityFromEvent(event: AgentEvent): void {
    if (event.type === "agent_start") {
      this.runStartedAt ??= Date.now();
      if (!this.taskActivity) this.setTaskActivity("thinking", "Thinking");
      return;
    }
    if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
      const activity = activityFromMessage(event.message);
      if (activity) this.setTaskActivity(activity.kind, activity.message, event.type === "message_update");
      return;
    }
    if (event.type === "tool_execution_start") {
      const name = compactTaskActivityText(event.toolName, 64) || "tool";
      const input = compactTaskActivityText(event.args ?? event.input ?? event.arguments, 160);
      this.setTaskActivity("tool", input ? `${name}: ${input}` : name);
      return;
    }
    if (event.type === "tool_execution_end") {
      this.setTaskActivity("thinking", "Waiting for the model");
      return;
    }
    if (event.type === "compaction_start" || event.type === "auto_compaction_start") {
      this.setTaskActivity("compacting", "Compacting conversation context");
      return;
    }
    if (event.type === "auto_retry_start") {
      this.setTaskActivity("retry", event.errorMessage ?? "Retrying the model request");
      return;
    }
    if (event.type === "extension_ui_request") {
      if (event.method === "setStatus") {
        if (event.statusText) this.setTaskActivity("thinking", event.statusText);
        return;
      }
      if (typeof event.method === "string" && ["request_user_input", "select", "confirm", "input", "editor", "custom"].includes(event.method)) {
        this.setTaskActivity("approval", event.title ?? event.message ?? "Waiting for your input");
      }
    }
  }

  start(): void {
    this.unsubscribe = this.inner.subscribe((event: AgentEvent) => {
      this.resetIdleTimer();
      this.updateActivityFromEvent(event);
      if (event.type === "tool_execution_start") {
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
        const toolName = typeof event.toolName === "string" ? event.toolName : "";
        if (toolCallId && toolName) {
          this.runtimeToolCalls.set(toolCallId, { toolName, args: event.args });
        }
      }
      if (event.type === "tool_execution_end") {
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
        const started = toolCallId ? this.runtimeToolCalls.get(toolCallId) : undefined;
        if (toolCallId) this.runtimeToolCalls.delete(toolCallId);
        const toolName = started?.toolName ?? (typeof event.toolName === "string" ? event.toolName : "");
        if (this.activePromptRun && toolCallId && toolName) {
          void captureTeamRuntimeToolResult(
            this.activePromptRun,
            toolCallId,
            toolName,
            started?.args ?? event.args,
            event.isError === true,
          ).catch((error) => console.error("[pi-web] failed to capture Team runtime evidence:", error instanceof Error ? error.message : String(error)));
        }
      }
      if (event.type === "agent_start") {
        this.lastPromptFailed = false;
        this.lastPromptErrorSummary = undefined;
      }
      if (event.type === "agent_end") {
        this.runtimeToolCalls.clear();
        invalidateSessionListCache();
      }
      this.emit(event);
      // Lifecycle state is immediate; high-frequency text/tool activity is
      // coalesced so a token stream cannot rebuild every live-session snapshot.
      if (isImmediateRunningSnapshotEvent(event)) notifyRunningChange();
      else scheduleRunningChange();
    });
    this.resetIdleTimer();
    notifyRunningChange();
  }

  setForceEmptySystemPrompt(force: boolean): void {
    this.forceEmptySystemPrompt = force;
    this.applyForcedEmptySystemPrompt();
  }

  beginExtensionBinding(options: ExtensionBindingOptions = {}): void {
    void this.ensureExtensionsBound(options).catch((err) => {
      console.error("[pi-web] failed to dispatch session_start to extensions:", err instanceof Error ? err.message : err);
    });
  }

  async waitUntilReady(): Promise<void> {
    await this.waitForExtensionsBound();
  }

  private ensureExtensionsBound(options: ExtensionBindingOptions = {}): Promise<void> {
    if (options.forceEmptySystemPrompt) this.forceEmptySystemPrompt = true;
    if (this.extensionsBound) {
      this.applyForcedEmptySystemPrompt();
      return Promise.resolve();
    }
    if (this.extensionBindingPromise) return this.extensionBindingPromise;

    this.extensionBindingError = null;
    this.extensionBindingPromise = (async () => {
      if (!this._alive) return;
      const uiContext = this.createExtensionUiContext();
      if (typeof this.inner.bindExtensions === "function") {
        const bindExtensions = this.inner.bindExtensions as (bindings: {
          uiContext?: ExtensionUiContextLike;
          mode?: "rpc";
          commandContextActions?: ExtensionCommandContextActionsLike;
          shutdownHandler?: () => void;
          onError?: (error: { extensionPath: string; event: string; error: string }) => void;
        }) => Promise<void>;
        await bindExtensions.call(this.inner, {
          uiContext,
          mode: "rpc",
          commandContextActions: this.createExtensionCommandContextActions(),
          shutdownHandler: () => this.emit({
            type: "extension_ui_request",
            id: randomUUID(),
            method: "notify",
            notifyType: "warning",
            message: "Extension requested shutdown, but shutdown is not supported in Pi Web.",
          } as ExtensionUiRequest as AgentEvent),
          onError: (error) => this.emit({
            type: "extension_error",
            extensionPath: error.extensionPath,
            event: error.event,
            error: error.error,
          }),
        });
      } else {
        this.inner.extensionRunner.setUIContext?.(uiContext, "rpc");
      }
      this.extensionsBound = true;
      this.applyForcedEmptySystemPrompt();
      console.log(`[pi-web] session_start dispatched to extensions for session ${this.inner.sessionId}`);
    })().catch((err) => {
      this.extensionBindingError = err;
      throw err;
    });

    return this.extensionBindingPromise;
  }

  private async waitForExtensionsBound(): Promise<void> {
    try {
      if (this.extensionBindingPromise) await this.extensionBindingPromise;
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (this.extensionBindingError) {
      throw this.extensionBindingError instanceof Error
        ? this.extensionBindingError
        : new Error(String(this.extensionBindingError));
    }
  }

  private shouldWaitForExtensions(type: string): boolean {
    return type === "prompt" || type === "steer" || type === "follow_up" || type === "get_commands";
  }

  private async withFinalRunningNotification<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      notifyRunningChange();
    }
  }

  private applyForcedEmptySystemPrompt(): void {
    if (this.forceEmptySystemPrompt && this.inner.agent.state) {
      this.inner.agent.state.systemPrompt = "";
    }
  }

  private scheduleSystemPromptReload(): void {
    if (!this._alive || this.systemPromptReloadTimer) return;
    this.systemPromptReloadTimer = setTimeout(() => {
      this.systemPromptReloadTimer = null;
      void this.flushSystemPromptReload().catch((error) => {
        console.error("[pi-web] deferred system prompt reload failed:", error instanceof Error ? error.message : error);
        this.scheduleSystemPromptReload();
      });
    }, 250);
  }

  private async flushSystemPromptReload(): Promise<void> {
    if (!this._alive || this.systemPromptReloadApplied >= this.systemPromptReloadRequested) return;
    if (this.isRunning() || this.systemPromptReloading) {
      this.scheduleSystemPromptReload();
      return;
    }
    this.systemPromptReloading = true;
    const revision = this.systemPromptReloadRequested;
    try {
      await this.waitForExtensionsBound();
      this.extensionStatuses.clear();
      this.extensionWidgets.clear();
      await this.inner.reload();
      if (typeof this.inner.bindExtensions !== "function") {
        this.inner.extensionRunner.setUIContext?.(this.createExtensionUiContext(), "rpc");
      }
      this.applyForcedEmptySystemPrompt();
      this.systemPromptReloadApplied = revision;
      invalidateModelsCache();
      this.emit({
        type: "system_prompt_reloaded",
        sessionId: this.sessionId,
        systemPrompt: this.inner.agent.state?.systemPrompt ?? "",
      });
    } finally {
      this.systemPromptReloading = false;
      if (this.systemPromptReloadApplied < this.systemPromptReloadRequested) this.scheduleSystemPromptReload();
    }
  }

  private emit(event: AgentEvent): void {
    for (const l of this.listeners) l(event);
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.isRunning()) {
        this.resetIdleTimer();
        return;
      }
      this.destroy();
    }, 10 * 60 * 1000);
  }

  persistSessionFile(): void {
    const manager = this.inner.sessionManager;
    const sessionFile = persistLazySessionManager(manager);
    if (sessionFile) cacheSessionPath(this.inner.sessionId, sessionFile);
  }

  appendAutomationCard(details: Record<string, unknown>): void {
    this.persistSessionFile();
    this.inner.sessionManager.appendCustomMessageEntry("piora-automation", "", true, details);
    invalidateSessionListCache();
  }

  private assertSessionIdle(action: string): void {
    if (this.stopping || this.promptRunning || this.inner.isStreaming || this.inner.isCompacting || this.inner.isBashRunning) {
      throw new Error(`Cannot ${action} while the session is busy`);
    }
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    for (const event of this.pendingUiRequests.values()) listener(event);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  onDestroy(cb: () => void): () => void {
    this.onDestroyCallbacks.add(cb);
    return () => this.onDestroyCallbacks.delete(cb);
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    this.resetIdleTimer();
    this.flushPendingProjectCapabilitySettings();
    const type = command.type as string;
    const abortGeneration = this.abortGeneration;
    if (this.runtimeProfile === "device-control" && DEVICE_CONTROL_DENIED_RPC_COMMANDS.has(type)) {
      throw new Error(`RPC command ${type} is disabled by the device-control runtime profile.`);
    }
    if (this.shouldWaitForExtensions(type)) await this.waitForExtensionsBound();

    if (type === "prompt" || type === "steer" || type === "follow_up") {
      if (this.stopping || abortGeneration !== this.abortGeneration) {
        throw new Error("Cannot send a prompt while the session is busy stopping");
      }
      const imageError = validateAgentImages(command.images);
      if (imageError) throw new Error(imageError);
    }

    switch (type) {
      case "prompt": {
        // Fire and forget — events come via subscribe
        const promptImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        const promptMaterials = command.materials as PromptMaterialReference[] | undefined;
        const streamingBehavior = command.streamingBehavior as "steer" | "followUp" | undefined;
        if (!streamingBehavior) {
          this.assertSessionIdle("send a prompt");
          if (this.promptAdmissionBusy) throw new Error("Cannot send a prompt while the session is starting another prompt");
        }
        const teamExecution = command.teamExecution as TeamExecutionContext | undefined;
        if (teamExecution && streamingBehavior) throw new Error("Team execution context cannot be attached to a follow-up prompt.");
        if (teamExecution) this.validateTeamRuntimePolicy(teamExecution);
        const commandId = typeof command.commandId === "string" && command.commandId.trim()
          ? command.commandId.trim()
          : `cmd_${randomUUID()}`;
        const originalPromptMessage = String(command.message ?? "");
        const runtimePromptMessage = promptMaterials?.length
          ? buildPromptWithMaterials(originalPromptMessage, resolvePromptMaterialReferences(promptMaterials))
          : originalPromptMessage;
        if (!streamingBehavior) this.promptAdmissionBusy = true;
        const promptText = compactTaskActivityText(originalPromptMessage);
        this.fallbackTaskTitle = compactTaskActivityText(originalPromptMessage, 80) || this.fallbackTaskTitle;
        this.beginRun("prompt", promptText || "Processing request");
        this.lastPromptFailed = false;
        this.lastPromptErrorSummary = undefined;
        const ownsPromptRun = !streamingBehavior || !this.activePromptRun;
        const promptSource = command.source as SessionMessageSourceKind | undefined;
        const roomContext = command.roomContext as SessionRoomContext | undefined;
        const promptRun = ownsPromptRun
          ? beginPromptRun(this.inner.sessionId, {
              ...(promptSource ? { source: promptSource } : {}),
              ...(roomContext ? { roomContext } : {}),
            })
          : this.activePromptRun!;
        if (ownsPromptRun) {
          this.activePromptRun = promptRun;
          this.activeCommandId = commandId;
          this.emit({
            type: "prompt_started",
            sessionId: this.sessionId,
            commandId,
            runId: promptRun.runId,
            timestamp: Date.now(),
          });
        }
        if (teamExecution) {
          if (!ownsPromptRun) throw new Error("Team execution requires a new PromptRun.");
          bindTeamPromptContext(promptRun, teamExecution);
        }
        this.promptRunning = true;
        notifyRunningChange();
        const assertNotAborted = () => {
          if (!this._alive || abortGeneration !== this.abortGeneration) {
            throw new Error("Prompt cancelled");
          }
        };
        const promptTask = Promise.resolve().then(() => {
          assertNotAborted();
          return this.inner.prompt(runtimePromptMessage, {
            ...(promptImages?.length ? { images: promptImages } : {}),
            ...(streamingBehavior ? { streamingBehavior } : {}),
            source: "rpc",
            // SDK abort() only sees an active model run, not asynchronous auth,
            // input hooks or pre-prompt compaction. Fence that late model start.
            preflightResult: (success) => { if (success) assertNotAborted(); },
          });
        })
          .then(async () => {
          this.promptRunning = false;
          if (ownsPromptRun) {
            await finishPromptRun(promptRun, "idle");
            if (this.activePromptRun?.runId === promptRun.runId) this.activePromptRun = undefined;
            if (this.activeCommandId === commandId) this.activeCommandId = undefined;
          }
          if (!streamingBehavior) {
            this.promptAdmissionBusy = false;
            this.emit({ type: "prompt_done", sessionId: this.sessionId, commandId, runId: promptRun.runId, timestamp: Date.now() });
          }
          this.flushPendingProjectCapabilitySettings();
          notifyRunningChange();
        }).catch(async (error) => {
          this.promptRunning = false;
          if (ownsPromptRun) {
            await finishPromptRun(promptRun, "error");
            if (this.activePromptRun?.runId === promptRun.runId) this.activePromptRun = undefined;
            if (this.activeCommandId === commandId) this.activeCommandId = undefined;
          }
          if (!streamingBehavior) this.promptAdmissionBusy = false;
          const cancelled = abortGeneration !== this.abortGeneration || !this._alive;
          this.lastPromptFailed = !cancelled;
          this.lastPromptErrorSummary = cancelled ? undefined : error instanceof Error ? error.message : String(error);
          invalidateSessionListCache();
          if (!cancelled) this.emit({
            type: "prompt_error",
            sessionId: this.sessionId,
            commandId,
            runId: promptRun.runId,
            timestamp: Date.now(),
            errorMessage: error instanceof Error ? error.message : String(error),
          });
          if (!streamingBehavior) this.emit({ type: "prompt_done", sessionId: this.sessionId, commandId, runId: promptRun.runId, timestamp: Date.now() });
          this.flushPendingProjectCapabilitySettings();
          notifyRunningChange();
        }).finally(() => {
          this.promptTasks.delete(promptTask);
        });
        this.promptTasks.add(promptTask);
        return null;
      }

      case "abort": {
        if (this.stopping) return { accepted: true };
        const promptRun = this.activePromptRun;
        this.abortGeneration += 1;
        this.stopping = true;
        notifyRunningChange();

        // AgentSession.abort() signals its AbortController synchronously, then
        // waits for the model transport and all event listeners to become idle.
        // Do not hold the stop request open for that potentially slow cleanup:
        // the UI can settle immediately while the wrapper remains `stopping`
        // until the real runtime has finished unwinding.
        const signal = (cancel: () => unknown) => {
          try { return Promise.resolve(cancel()); }
          catch (error) { return Promise.reject(error); }
        };
        const abortTask = signal(() => this.inner.abort());
        const compactionTask = signal(() => this.inner.abortCompaction());
        const bashTask = signal(() => this.inner.abortBash());
        const queueTask = signal(() => {
          this.inner.clearQueue();
          this.emit({ type: "queue_update", steering: [], followUp: [] });
        });
        const uiTasks = [
          ...Array.from(this.pendingUiResponses.values(), (pending) => signal(() => pending.cancel())),
          ...Array.from(this.activeCustomUis.keys(), (id) => signal(() => this.closeCustomUi(id, undefined))),
        ];
        const cleanupTask = finishPromptRun(promptRun, "abort");
        if (this.activePromptRun?.runId === promptRun?.runId) this.activePromptRun = undefined;

        void Promise.allSettled([abortTask, compactionTask, bashTask, queueTask, cleanupTask, ...uiTasks, ...this.promptTasks]).then((results) => {
          for (const result of results) {
            if (result.status === "rejected") {
              console.error("[pi-web] active run abort cleanup failed:", result.reason instanceof Error ? result.reason.message : result.reason);
            }
          }
        }).finally(() => {
          if (!this._alive) return;
          this.stopping = false;
          this.flushPendingProjectCapabilitySettings();
          this.emit({ type: "session_idle", sessionId: this.sessionId });
          notifyRunningChange();
        });
        return { accepted: true };
      }

      case "get_state": {
        const model = this.inner.model;
        const contextUsage = this.inner.getContextUsage();
        const agentState = this.inner.agent.state;
        const contextBreakdown = contextUsage ? estimateContextUsageBreakdown({
          messages: agentState?.messages ?? [],
          systemPrompt: agentState?.systemPrompt ?? "",
          tools: agentState?.tools ?? [],
          totalTokens: contextUsage.tokens,
        }) : undefined;
        return {
          sessionId: this.inner.sessionId,
          runtimeProfile: this.runtimeProfile,
          sessionFile: this.inner.sessionFile ?? "",
          isStreaming: this.inner.isStreaming,
          isPromptRunning: this.promptRunning,
          isBashRunning: this.inner.isBashRunning,
          isCompacting: this.inner.isCompacting,
          runtime: this.getRuntime(),
          activeTools: Array.from(this.runtimeToolCalls, ([id, tool]) => ({ id, name: tool.toolName })),
          pendingApproval: this.pendingUiResponses.size > 0 || this.activeCustomUis.size > 0,
          lastPromptFailed: this.lastPromptFailed,
          lastPromptErrorSummary: this.lastPromptErrorSummary,
          autoCompactionEnabled: this.inner.autoCompactionEnabled,
          autoRetryEnabled: this.inner.autoRetryEnabled,
          model: model ? { id: model.id, provider: model.provider } : undefined,
          messageCount: 0,
          pendingMessageCount: this.inner.pendingMessageCount,
          queuedMessages: {
            steering: [...this.inner.getSteeringMessages()],
            followUp: [...this.inner.getFollowUpMessages()],
          },
          contextUsage: contextUsage
            ? {
                percent: contextUsage.percent,
                contextWindow: contextUsage.contextWindow,
                tokens: contextUsage.tokens,
                ...(contextBreakdown ? { breakdown: contextBreakdown } : {}),
              }
            : null,
          systemPrompt: this.inner.agent.state?.systemPrompt ?? "",
          systemPromptBinding: this.getSystemPromptBinding(),
          thinkingLevel: this.inner.agent.state?.thinkingLevel ?? "off",
          extensionStatuses: this.getExtensionStatuses(),
          extensionWidgets: this.getExtensionWidgets(),
          capabilities: this.getSessionCapabilities(),
        };
      }

      case "set_model": {
        const { provider, modelId } = command as { provider: string; modelId: string };
        let model = this.inner.modelRuntime.getModel(provider, modelId);
        if (!model) {
          await this.inner.modelRuntime.refresh({ allowNetwork: false });
          model = this.inner.modelRuntime.getModel(provider, modelId);
        }
        if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
        await this.inner.setModel(applyConfiguredImageInput(model));
        invalidateModelsCache();
        invalidateSessionListCache();
        return { id: model.id, provider: model.provider };
      }

      case "fork": {
        this.assertSessionIdle("fork");
        const entryId = command.entryId as string;
        const sessionManager = this.inner.sessionManager;
        const currentSessionFile = this.inner.sessionFile;

        if (!sessionManager.isPersisted()) return { cancelled: true };
        if (!currentSessionFile) throw new Error("Persisted session is missing a session file");

        const entry = sessionManager.getEntry(entryId);
        if (!entry) throw new Error("Invalid entry ID for forking");

        const sessionDir = sessionManager.getSessionDir();
        let newSessionFile: string;

        if (!entry.parentId) {
          // Fork before the first message: create an empty session linked to this one
          const newManager = SessionManager.create(sessionManager.getCwd(), sessionDir);
          newManager.newSession({ parentSession: currentSessionFile });
          newSessionFile = newManager.getSessionFile() as string;
        } else {
          // Fork after some history: copy path up to (but not including) the fork point
          const sourceManager = SessionManager.open(currentSessionFile, sessionDir);
          const forkedPath = sourceManager.createBranchedSession(entry.parentId);
          if (!forkedPath) throw new Error("Failed to create forked session");
          newSessionFile = forkedPath;
        }

        const newSessionId = SessionManager.open(newSessionFile, sessionDir).getSessionId();
        const forkedManager = SessionManager.open(newSessionFile, sessionDir);
        appendSessionCapabilityPolicy(forkedManager, copySessionCapabilityPolicy(this.capabilityPolicy));
        const sourceSystemPromptBinding = this.getSystemPromptBinding()
          ?? createSessionSystemPromptBinding({ mode: "default" });
        appendSessionSystemPromptBinding(
          forkedManager,
          copySessionSystemPromptBinding(sourceSystemPromptBinding),
        );
        try {
          await bindSessionAgentRuntimeProfile(newSessionId, this.runtimeProfile);
        } catch (profileError) {
          quarantineUnboundSessionFile(newSessionFile);
          throw profileError;
        }
        cacheSessionPath(newSessionId, newSessionFile);
        invalidateSessionListCache();
        await finishPromptRun(this.activePromptRun, "fork");
        this.activePromptRun = undefined;
        this.destroy();
        return { cancelled: false, newSessionId, runtimeProfile: this.runtimeProfile };
      }

      case "navigate_tree": {
        this.assertSessionIdle("navigate");
        const result = await this.inner.navigateTree(command.targetId as string, {});
        notifyRunningChange();
        return { cancelled: result.cancelled };
      }

      case "set_thinking_level": {
        const level = command.level as string;
        this.inner.setThinkingLevel(level);
        // setThinkingLevel clamps xhigh→high for models where supportsXhigh()===false.
        // If the model has DeepSeek thinking compat (reasoningEffortMap maps xhigh→max),
        // force the state back so the compat layer can use it correctly.
        if (level === "xhigh" && (this.inner.model as { compat?: { thinkingFormat?: string } } | null)?.compat?.thinkingFormat === "deepseek" && this.inner.agent?.state) {
          this.inner.agent.state.thinkingLevel = "xhigh";
        }
        invalidateSessionListCache();
        return null;
      }

      case "compact": {
        this.beginRun("compacting", "Compacting conversation context");
        try {
          return await this.withFinalRunningNotification(() =>
            this.inner.compact(command.customInstructions as string | undefined)
          );
        } finally {
          invalidateSessionListCache();
          this.flushPendingProjectCapabilitySettings();
        }
      }

      case "set_session_name": {
        const name = (command.name as string | undefined)?.trim();
        if (!name) throw new Error("Session name cannot be empty");
        this.setSessionName(name);
        invalidateSessionListCache();
        return null;
      }

      case "get_session_stats": {
        return {
          ...this.inner.getSessionStats(),
          sessionName: this.cachedSessionTitle ?? undefined,
        };
      }

      case "get_last_assistant_text": {
        return { text: this.inner.getLastAssistantText() ?? "" };
      }

      case "set_auto_compaction": {
        this.inner.setAutoCompactionEnabled(command.enabled as boolean);
        return null;
      }

      case "clear_queue": {
        // Full clear only: pi has no single-item dequeue, and clear+requeue
        // races against the agent loop pulling messages mid-flight.
        return this.inner.clearQueue();
      }

      case "steer": {
        const steerImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.steer(command.message as string, steerImages?.length ? steerImages : undefined);
        return null;
      }

      case "follow_up": {
        const followImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.followUp(command.message as string, followImages?.length ? followImages : undefined);
        return null;
      }

      case "get_tools": {
        const all: ToolInfo[] = this.inner.getAllTools();
        const active = new Set<string>(this.inner.getActiveToolNames());
        return all.map((t) => ({
          name: t.name,
          description: t.description,
          active: active.has(t.name),
        }));
      }

      case "get_capabilities": {
        return this.getSessionCapabilities();
      }

      case "get_commands": {
        const commands: SlashCommandInfo[] = [];
        for (const registered of this.inner.extensionRunner.getRegisteredCommands()) {
          commands.push({
            name: registered.invocationName,
            description: registered.description,
            source: "extension",
            sourceInfo: registered.sourceInfo,
          });
        }
        for (const template of this.inner.promptTemplates) {
          commands.push({
            name: template.name,
            description: template.description,
            source: "prompt",
            sourceInfo: template.sourceInfo,
          });
        }
        for (const skill of this.inner.resourceLoader.getSkills().skills) {
          commands.push({
            name: `skill:${skill.name}`,
            description: skill.description,
            source: "skill",
            sourceInfo: skill.sourceInfo,
          });
        }
        return { commands };
      }

      case "set_tools": {
        const requested = Array.isArray(command.toolNames)
          ? command.toolNames.filter((name): name is string => typeof name === "string")
          : [];
        return this.updateSessionCapabilities(selectionFromToolNames(requested, this.capabilityCatalog));
      }

      case "set_capabilities": {
        const preset = command.preset;
        if (preset !== "chat" && preset !== "coding" && preset !== "research" && preset !== "device" && preset !== "custom") {
          throw new Error("Invalid session tool preset.");
        }
        const enabledCapabilityIds = Array.isArray(command.enabledCapabilityIds)
          ? command.enabledCapabilityIds.filter((id): id is string => typeof id === "string")
          : undefined;
        const expectedRevision = command.expectedRevision;
        if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0)) {
          throw new Error("Invalid session tool revision.");
        }
        return this.updateSessionCapabilities({
          preset,
          ...(enabledCapabilityIds ? { enabledCapabilityIds } : {}),
          ...(expectedRevision !== undefined ? { expectedRevision: Number(expectedRevision) } : {}),
        });
      }

      case "set_team_tools": {
        this.assertSessionIdle("change Team tools");
        if (this.runtimeProfile !== "normal") throw new Error("Team Agent tools require the normal runtime profile.");
        const available = new Set(this.inner.getAllTools().map((tool) => tool.name));
        const requested = Array.isArray(command.toolNames)
          ? command.toolNames.filter((name): name is string => typeof name === "string")
          : [];
        const exact = [...new Set([...requested, "piora_room"])];
        if (exact.some((name) => !available.has(name))) throw new Error("Team tool allowlist contains an unavailable tool.");
        if (this.projectAllowedToolNames && exact.some((name) => !this.projectAllowedToolNames?.has(name))) {
          throw new Error("Team tool allowlist contains a tool disabled by project settings.");
        }
        const previousCeiling = this.toolNameCeiling;
        this.toolNameCeiling = new Set(exact);
        const nextPolicy = createSessionCapabilityPolicy(
          selectionFromToolNames(exact, this.capabilityCatalog),
          this.capabilityCatalog,
          this.runtimeProfile,
          this.capabilityPolicy.revision,
          this.capabilityPolicy,
        );
        this.refreshCapabilityCatalog();
        let resolved: { policy: SessionCapabilityPolicy; toolNames: string[]; trimmed: boolean };
        try {
          resolved = this.resolveCapabilityToolBudget(nextPolicy, true);
        } catch (error) {
          this.toolNameCeiling = previousCeiling;
          throw error;
        }
        this.capabilityPolicy = resolved.policy;
        this.applySessionCapabilities();
        return null;
      }

      case "reload": {
        this.assertSessionIdle("reload");
        await this.waitForExtensionsBound();
        this.extensionStatuses.clear();
        this.extensionWidgets.clear();
        await this.inner.reload();
        if (typeof this.inner.bindExtensions !== "function") {
          this.inner.extensionRunner.setUIContext?.(this.createExtensionUiContext(), "rpc");
        }
        this.applySessionCapabilities({ persistBudgetTrim: true });
        invalidateModelsCache();
        return { success: true };
      }

      case "restart_extensions": {
        this.assertSessionIdle("restart extensions");
        this.destroy();
        return { success: true };
      }

      case "abort_compaction": {
        this.stopping = true;
        notifyRunningChange();
        try {
          this.inner.abortCompaction();
        } finally {
          this.stopping = false;
          notifyRunningChange();
        }
        return null;
      }

      case "extension_ui_response": {
        this.resolveExtensionUiResponse(command as ExtensionUiResponse);
        return null;
      }

      case "extension_ui_input": {
        this.handleExtensionUiInput(command.id as string, command.data as string);
        return null;
      }

      case "set_auto_retry": {
        this.inner.setAutoRetryEnabled(command.enabled as boolean);
        return null;
      }

      case "bash": {
        if (this.promptRunning || this.inner.isStreaming || this.inner.isCompacting || this.inner.isBashRunning) {
          throw new Error("Cannot run a shell command while the session is busy");
        }
        this.beginRun("command", command.command);
        const execution = this.inner.executeBash(
          command.command as string,
          undefined,
          { excludeFromContext: command.excludeFromContext as boolean | undefined },
        );
        notifyRunningChange();
        try {
          const result = await execution;
          this.persistSessionFile();
          return result;
        } finally {
          invalidateSessionListCache();
          this.flushPendingProjectCapabilitySettings();
          notifyRunningChange();
        }
      }

      case "abort_bash": {
        this.stopping = true;
        notifyRunningChange();
        try {
          this.inner.abortBash();
        } finally {
          this.stopping = false;
          notifyRunningChange();
        }
        return null;
      }

      default:
        throw new Error(`Unsupported command: ${type}`);
    }
  }

  destroy(): void {
    if (!this._alive) return;
    this._alive = false;
    if (this.promptRunning || this.inner.isStreaming) {
      void this.inner.abort().catch(() => undefined);
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.systemPromptReloadTimer) clearTimeout(this.systemPromptReloadTimer);
    if (this.inner.isBashRunning) this.inner.abortBash();
    const promptRun = this.activePromptRun;
    this.activePromptRun = undefined;
    this.activeCommandId = undefined;
    this.promptAdmissionBusy = false;
    void finishPromptRun(promptRun, "destroy");
    this.unsubscribe?.();
    for (const pending of this.pendingUiResponses.values()) pending.cancel();
    for (const id of Array.from(this.activeCustomUis.keys())) this.closeCustomUi(id, undefined);
    this.pendingUiResponses.clear();
    this.pendingUiRequests.clear();
    this.runtimeToolCalls.clear();
    for (const callback of this.onDestroyCallbacks) {
      try { callback(); } catch (error) {
        console.error("[pi-web] session destroy callback failed:", error instanceof Error ? error.message : error);
      }
    }
    this.onDestroyCallbacks.clear();
    // AgentSession.dispose() is synchronous in the SDK, but extension
    // session_shutdown handlers are async. Run the lifecycle in order so a
    // session's handlers finish before its runner is invalidated and disposed.
    void (async () => {
      try {
        await this.inner.extensionRunner.emit?.({ type: "session_shutdown", reason: "shutdown" });
      } catch (error) {
        console.error("[pi-web] session_shutdown handler failed:", error instanceof Error ? error.message : error);
      } finally {
        try { this.inner.dispose?.(); } catch (error) {
          console.error("[pi-web] AgentSession dispose failed:", error instanceof Error ? error.message : error);
        }
      }
    })();
    notifyRunningChange();
  }

  private resolveExtensionUiResponse(response: ExtensionUiResponse): void {
    const pending = this.pendingUiResponses.get(response.id);
    if (!pending) return;
    pending.resolve(response);
  }

  private getExtensionStatuses(): Array<{ key: string; text: string }> {
    return Array.from(this.extensionStatuses, ([key, text]) => ({ key, text }));
  }

  private getExtensionWidgets(): ExtensionWidgetItem[] {
    return Array.from(this.extensionWidgets.values());
  }

  private getCustomUiWidth(options: unknown): number {
    if (!options || typeof options !== "object") return DEFAULT_CUSTOM_UI_COLUMNS;
    const overlayOptions = (options as { overlayOptions?: unknown }).overlayOptions;
    const resolved = typeof overlayOptions === "function" ? overlayOptions() : overlayOptions;
    if (!resolved || typeof resolved !== "object") return DEFAULT_CUSTOM_UI_COLUMNS;
    const width = (resolved as { width?: unknown }).width;
    return typeof width === "number" && Number.isFinite(width)
      ? Math.max(40, Math.min(140, Math.round(width)))
      : 92;
  }

  private emitCustomUiRender(id: string, custom: ActiveCustomUi): void {
    let lines: string[];
    try {
      lines = custom.component.render(custom.width);
    } catch (error) {
      lines = [`Extension custom UI render failed: ${error instanceof Error ? error.message : String(error)}`];
    }
    const event = {
      type: "extension_ui_request",
      id,
      method: "custom",
      lines,
    } as ExtensionUiRequest as AgentEvent;
    this.pendingUiRequests.set(id, event);
    this.emit(event);
    notifyRunningChange();
  }

  private closeCustomUi(id: string, value: unknown): void {
    const custom = this.activeCustomUis.get(id);
    if (!custom || custom.settled) return;
    custom.settled = true;
    this.activeCustomUis.delete(id);
    this.pendingUiRequests.delete(id);
    notifyRunningChange();
    try {
      custom.component.dispose?.();
    } catch {
      // Ignore dispose errors from extension UI components.
    }
    this.emit({
      type: "extension_ui_request",
      id,
      method: "custom",
      lines: [],
      closed: true,
    } as ExtensionUiRequest as AgentEvent);
    custom.resolve(value);
  }

  private handleExtensionUiInput(id: string, data: string): void {
    const custom = this.activeCustomUis.get(id);
    if (!custom || typeof data !== "string") return;
    try {
      custom.component.handleInput?.(data);
      if (this.activeCustomUis.has(id)) this.emitCustomUiRender(id, custom);
    } catch (error) {
      this.closeCustomUi(id, undefined);
      this.emit({
        type: "extension_error",
        extensionPath: `custom-ui:${id}`,
        event: "custom_ui_input",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private requestExtensionCustomUi<T>(
    factory: unknown,
    options?: unknown,
  ): Promise<T> {
    if (typeof factory !== "function" || this.stopping || !this._alive) return Promise.resolve(undefined as T);
    const abortGeneration = this.abortGeneration;

    const id = randomUUID();
    const width = this.getCustomUiWidth(options);

    return new Promise<T>((resolve) => {
      let completed = false;
      const tui = createHeadlessCustomUiTui(
        () => {
          const custom = this.activeCustomUis.get(id);
          if (custom) this.emitCustomUiRender(id, custom);
        },
        width,
      );
      const finish = (value: T) => {
        if (completed) return;
        completed = true;
        resolve(value);
      };
      const done = (value: T) => {
        if (this.activeCustomUis.has(id)) {
          this.closeCustomUi(id, value);
        } else {
          finish(value);
        }
      };

      Promise.resolve()
        .then(() => factory(tui, PLAIN_TEXT_THEME, CUSTOM_UI_KEYBINDINGS, done))
        .then((component) => {
          if (abortGeneration !== this.abortGeneration || !this._alive) finish(undefined as T);
          if (completed) {
            try {
              (component as CustomUiComponent | undefined)?.dispose?.();
            } catch {
              // Ignore dispose errors from a component completed before mounting.
            }
            return;
          }
          if (!component || typeof component !== "object" || typeof (component as CustomUiComponent).render !== "function") {
            finish(undefined as T);
            return;
          }
          const custom: ActiveCustomUi = {
            component: component as CustomUiComponent,
            width,
            resolve: (value) => finish(value as T),
            settled: false,
          };
          this.activeCustomUis.set(id, custom);
          this.emitCustomUiRender(id, custom);
        })
        .catch((error) => {
          if (completed) return;
          this.emit({
            type: "extension_error",
            extensionPath: `custom-ui:${id}`,
            event: "custom_ui",
            error: error instanceof Error ? error.message : String(error),
          });
          finish(undefined as T);
        });
    });
  }

  private requestExtensionUi<T>(
    request: ExtensionUiRequestBody,
    defaultValue: T,
    parseResponse: (response: ExtensionUiResponse) => T,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted || this.stopping || !this._alive) return Promise.resolve(defaultValue);

    const id = randomUUID();
    const fullRequest = {
      type: "extension_ui_request",
      id,
      ...request,
      ...(timeout ? { timeout, expiresAt: Date.now() + timeout } : {}),
    };

    return new Promise((resolve) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onAbort);
        this.pendingUiRequests.delete(id);
        this.pendingUiResponses.delete(id);
        notifyRunningChange();
      };
      const settle = (value: T) => {
        cleanup();
        resolve(value);
      };
      const onAbort = () => settle(defaultValue);

      if (timeout) timeoutId = setTimeout(() => settle(defaultValue), timeout);
      signal?.addEventListener("abort", onAbort, { once: true });

      this.pendingUiRequests.set(id, fullRequest as AgentEvent);
      this.pendingUiResponses.set(id, {
        resolve: (response) => settle(parseResponse(response)),
        cancel: () => settle(defaultValue),
      });
      this.emit(fullRequest as AgentEvent);
      notifyRunningChange();
    });
  }

  private createExtensionUiContext(): ExtensionUiContextLike {
    return {
      requestUserInput: (title, description, questions, opts) => this.requestExtensionUi(
        {
          method: "request_user_input",
          title,
          ...(description ? { description } : {}),
          questions,
          ...(opts?.timeout ? { timeout: opts.timeout } : {}),
        },
        { cancelled: true } as UserInputResult,
        (response) => "answers" in response ? { answers: response.answers } : { cancelled: true },
        opts?.timeout,
        opts?.signal,
      ),
      select: (title, options, opts) => this.requestExtensionUi(
        { method: "select", title, options, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      confirm: (title, message, opts) => this.requestExtensionUi(
        { method: "confirm", title, message, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        false,
        (response) => "confirmed" in response ? response.confirmed : false,
        opts?.timeout,
        opts?.signal,
      ),
      input: (title, placeholder, opts) => this.requestExtensionUi(
        { method: "input", title, ...(placeholder !== undefined ? { placeholder } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      editor: (title, prefill, opts) => this.requestExtensionUi(
        { method: "editor", title, ...(prefill !== undefined ? { prefill } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      notify: (message, type) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "notify",
          message,
          notifyType: type,
        } as ExtensionUiRequest as AgentEvent);
      },
      onTerminalInput: () => () => {},
      setStatus: (key, text) => {
        if (text === undefined) this.extensionStatuses.delete(key);
        else this.extensionStatuses.set(key, text);
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setStatus",
          statusKey: key,
          statusText: text,
        } as ExtensionUiRequest as AgentEvent);
      },
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: (key, content, options) => {
        if (content !== undefined && !Array.isArray(content)) return;
        if (content === undefined) {
          this.extensionWidgets.delete(key);
        } else {
          this.extensionWidgets.set(key, {
            key,
            lines: content,
            placement: options?.placement ?? "aboveEditor",
          });
        }
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setWidget",
          widgetKey: key,
          widgetLines: content,
          widgetPlacement: options?.placement,
        } as ExtensionUiRequest as AgentEvent);
      },
      setFooter: () => {},
      setHeader: () => {},
      setTitle: (title) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setTitle",
          title,
        } as ExtensionUiRequest as AgentEvent);
      },
      custom: <T = unknown>(factory: unknown, options?: unknown) => this.requestExtensionCustomUi<T>(factory, options),
      pasteToEditor: (text) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        } as ExtensionUiRequest as AgentEvent);
      },
      setEditorText: (text) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        } as ExtensionUiRequest as AgentEvent);
      },
      getEditorText: () => "",
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      get theme() { return PLAIN_TEXT_THEME; },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Theme switching is not supported in Pi Web extension UI yet" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }

  private createExtensionCommandContextActions(): ExtensionCommandContextActionsLike {
    return {
      waitForIdle: async () => {
        const agent = this.inner.agent as { waitForIdle?: () => Promise<void> };
        await agent.waitForIdle?.();
      },
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      navigateTree: async (targetId, options) => {
        const result = await this.inner.navigateTree(targetId, { summarize: options?.summarize });
        return { cancelled: result.cancelled };
      },
      switchSession: async () => ({ cancelled: true }),
      reload: async () => {
        this.extensionStatuses.clear();
        this.extensionWidgets.clear();
        await this.inner.reload({
          beforeSessionStart: () => {
            this.inner.extensionRunner.setUIContext?.(this.createExtensionUiContext(), "rpc");
          },
        });
        this.applyForcedEmptySystemPrompt();
      },
    };
  }

}

// ============================================================================
// Session registry
// ============================================================================

declare global {
  var __piSessions: Map<string, AgentSessionWrapper> | undefined;
  var __piStartLocks: Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> | undefined;
  var __piStartingSessionCwds: Map<string, number> | undefined;
  var __piRunningListeners: Set<(sessions: TaskRuntimeSnapshot[]) => void> | undefined;
  var __piRunningNotifyTimer: ReturnType<typeof setTimeout> | undefined;
  var __piServicesCache: Map<string, AgentSessionServices> | undefined;
}

// ==========================================================================
// Per-session services cache.
//
// The SDK's ResourceLoader owns an ExtensionRuntime. ExtensionRunner.bindCore
// mutates that runtime's sendMessage/sendUserMessage actions, so sharing a
// services object by cwd cross-wires sessions even though each AgentSession
// has a separate runner. Correctness wins over the old warm-start optimization:
// every live session gets a private ResourceLoader/runtime. The cache remains
// useful for repeated calls that race while the same session is being started;
// start locks prevent duplicate construction.
// ==========================================================================

function getServicesCache(): Map<string, AgentSessionServices> {
  if (!globalThis.__piServicesCache) globalThis.__piServicesCache = new Map();
  return globalThis.__piServicesCache;
}

/** Drop cached per-cwd services so the next session start reloads them. */
export function invalidateServicesCache(): void {
  getServicesCache().clear();
}

export function applyProjectToolSettingsToLiveSessions(
  projectRoot: string,
  record: ProjectToolSettingsRecord,
): { appliedSessions: number; deferredSessions: number; failedSessions: number } {
  const target = normalizeRpcCwd(projectRoot);
  let appliedSessions = 0;
  let deferredSessions = 0;
  let failedSessions = 0;
  for (const session of getRegistry().values()) {
    if (!session.isAlive() || normalizeRpcCwd(session.projectRoot) !== target) continue;
    try {
      const result = session.applyProjectCapabilitySettings(record);
      if (result === "applied") appliedSessions += 1;
      else deferredSessions += 1;
    } catch {
      failedSessions += 1;
    }
  }
  return { appliedSessions, deferredSessions, failedSessions };
}

export async function reloadAllNormalSessionSystemPrompts(): Promise<{
  reloadedSessions: number;
  deferredSessions: number;
}> {
  const sessions = Array.from(getRegistry().values()).filter(
    (session) => session.isAlive() && session.runtimeProfile === "normal",
  );
  const results = await Promise.all(sessions.map((session) => session.requestSystemPromptReload()));
  return {
    reloadedSessions: results.filter((result) => result === "reloaded").length,
    deferredSessions: results.filter((result) => result === "deferred").length,
  };
}

function getRegistry(): Map<string, AgentSessionWrapper> {
  if (!globalThis.__piSessions) {
    globalThis.__piSessions = new Map();
    const cleanup = () => globalThis.__piSessions?.forEach((s) => s.destroy());
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__piSessions;
}

function getLocks(): Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> {
  if (!globalThis.__piStartLocks) globalThis.__piStartLocks = new Map();
  return globalThis.__piStartLocks;
}

function normalizeRpcCwd(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  try {
    return realpathSync(resolvedCwd);
  } catch {
    return resolvedCwd;
  }
}

function getStartingSessionCwds(): Map<string, number> {
  if (!globalThis.__piStartingSessionCwds) globalThis.__piStartingSessionCwds = new Map();
  return globalThis.__piStartingSessionCwds;
}

function trackStartingSession(cwd: string): () => void {
  const startingCwds = getStartingSessionCwds();
  const key = normalizeRpcCwd(cwd);
  startingCwds.set(key, (startingCwds.get(key) ?? 0) + 1);
  return () => {
    const remaining = (startingCwds.get(key) ?? 1) - 1;
    if (remaining > 0) startingCwds.set(key, remaining);
    else startingCwds.delete(key);
  };
}

export function getRpcSession(sessionId: string): AgentSessionWrapper | undefined {
  return getRegistry().get(sessionId);
}

export function hasBusyRpcSessionForCwd(cwd: string): boolean {
  const targetCwd = normalizeRpcCwd(cwd);
  if (getStartingSessionCwds().has(targetCwd)) return true;
  return Array.from(getRegistry().values()).some(
    (session) => normalizeRpcCwd(session.cwd) === targetCwd && session.isRunning(),
  );
}

export function destroyRpcSessionsForCwd(cwd: string): number {
  const targetCwd = normalizeRpcCwd(cwd);
  const sessions = Array.from(getRegistry().values()).filter(
    (session) => normalizeRpcCwd(session.cwd) === targetCwd,
  );
  for (const session of sessions) session.destroy();
  return sessions.length;
}

export function getRunningRpcSessionIds(): string[] {
  return getRunningRpcSessionStatuses()
    .filter((session) => session.runtime !== "idle")
    .map((session) => session.id);
}

export function getRunningRpcSessionStatuses(): TaskRuntimeSnapshot[] {
  const statuses: TaskRuntimeSnapshot[] = [];
  for (const session of getRegistry().values()) {
    if (!session.isAlive()) continue;
    // globalThis deliberately retains wrappers across Next.js hot reloads.
    // A wrapper created by the previous module version does not yet have the
    // three-axis accessor, so adapt it until that live session is recreated.
    const snapshot = typeof session.getTaskRuntimeSnapshot === "function"
      ? session.getTaskRuntimeSnapshot()
      : {
          id: session.sessionId,
          runtime: session.inner.isCompacting ? "compacting" as const : session.isRunning() ? "running" as const : "idle" as const,
          pendingApproval: false,
          lastPromptFailed: false,
        };
    const hasOpenTaskRun = snapshot.taskRun
      && snapshot.taskRun.phase !== "completed"
      && snapshot.taskRun.phase !== "cancelled";
    if (snapshot.runtime !== "idle" || snapshot.pendingApproval || snapshot.lastPromptFailed || hasOpenTaskRun) {
      statuses.push(snapshot);
    }
  }
  return statuses.sort((a, b) => a.id.localeCompare(b.id));
}

export interface UnpersistedSessionInfo {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  parentSessionPath?: string;
}

/**
 * Session infos for live registry sessions missing from the caller's disk
 * scan. The primary case: pi delays the first file write until an assistant
 * message exists, so a brand-new session is invisible to the session list
 * (and thus the sidebar) until its first turn completes. Entries already
 * covered by the disk scan are excluded via `excludeIds` — not via
 * existsSync — because a freshly flushed file may still be absent from a
 * cached (TTL) scan, and the registry entry must bridge that window too.
 * Field semantics mirror the SDK's buildSessionInfo() so merged entries
 * render identically to disk entries.
 */
export function getUnpersistedSessionInfos(excludeIds?: ReadonlySet<string>): UnpersistedSessionInfo[] {
  const infos: UnpersistedSessionInfo[] = [];
  for (const session of getRegistry().values()) {
    if (!session.isAlive()) continue;
    if (excludeIds?.has(session.sessionId)) continue;
    const sessionFile = session.sessionFile;
    if (!sessionFile) continue;

    const manager = session.inner.sessionManager;
    const header = manager.getHeader();
    if (!header) continue;

    let messageCount = 0;
    let firstMessage = "";
    let lastActivityMs = Date.parse(header.timestamp);
    for (const entry of manager.getEntries()) {
      if (entry.type !== "message") continue;
      messageCount += 1;
      const message = entry.message;
      if (message.role !== "user" && message.role !== "assistant") continue;
      const timestamp = (message as { timestamp?: unknown }).timestamp;
      const activityMs = typeof timestamp === "number" ? timestamp : Date.parse(entry.timestamp);
      if (!Number.isNaN(activityMs)) lastActivityMs = Math.max(lastActivityMs, activityMs);
      if (!firstMessage && message.role === "user") {
        firstMessage = typeof message.content === "string"
          ? restorePromptMaterialDisplayPreview(message.content)
          : message.content
              .filter((block): block is { type: "text"; text: string } => (block as { type?: unknown }).type === "text")
              .map((block) => restorePromptMaterialDisplayPreview(block.text))
              .join(" ");
      }
    }

    infos.push({
      id: session.sessionId,
      path: sessionFile,
      cwd: header.cwd || session.cwd,
      name: manager.getSessionName(),
      created: header.timestamp,
      modified: new Date(Number.isNaN(lastActivityMs) ? Date.now() : lastActivityMs).toISOString(),
      messageCount,
      firstMessage,
      ...(header.parentSession ? { parentSessionPath: header.parentSession } : {}),
    });
  }
  return infos;
}

// ----------------------------------------------------------------------------
// Running-status broadcaster
//
// Pushes the current set of running session ids to subscribers whenever any
// session's running state may have changed. This lets the sidebar receive live
// updates over SSE instead of polling. Listeners live on globalThis so they
// survive Next.js hot-reload.
// ----------------------------------------------------------------------------

function getRunningListeners(): Set<(sessions: TaskRuntimeSnapshot[]) => void> {
  if (!globalThis.__piRunningListeners) globalThis.__piRunningListeners = new Set();
  return globalThis.__piRunningListeners;
}

/** Subscribe to running-session-id changes. Returns an unsubscribe function. */
export function subscribeRunningSessions(listener: (sessions: TaskRuntimeSnapshot[]) => void): () => void {
  const listeners = getRunningListeners();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

let lastRunningSnapshot = "";
const RUNNING_SNAPSHOT_THROTTLE_MS = 250;

function isImmediateRunningSnapshotEvent(event: AgentEvent): boolean {
  return event.type === "agent_start"
    || event.type === "agent_end"
    || event.type === "compaction_start"
    || event.type === "compaction_end"
    || event.type === "auto_compaction_start"
    || event.type === "auto_compaction_end"
    || event.type === "extension_ui_request";
}

function scheduleRunningChange(): void {
  if (globalThis.__piRunningNotifyTimer) return;
  globalThis.__piRunningNotifyTimer = setTimeout(() => {
    globalThis.__piRunningNotifyTimer = undefined;
    notifyRunningChange();
  }, RUNNING_SNAPSHOT_THROTTLE_MS);
}

/**
 * Recompute the running-session-id set and, if it changed since the last
 * notification, broadcast it to subscribers. Cheap to call often.
 */
export function notifyRunningChange(): void {
  if (globalThis.__piRunningNotifyTimer) {
    clearTimeout(globalThis.__piRunningNotifyTimer);
    globalThis.__piRunningNotifyTimer = undefined;
  }
  const sessions = getRunningRpcSessionStatuses();
  const snapshot = JSON.stringify(sessions);
  if (snapshot === lastRunningSnapshot) return;
  lastRunningSnapshot = snapshot;
  for (const listener of getRunningListeners()) {
    try { listener(sessions); } catch { /* ignore listener errors */ }
  }
}

/**
 * Get or create an AgentSession for the given session.
 * For new sessions (sessionFile === ""), pi generates its own id.
 * New sessions resolve enabledModels before construction so the initial model,
 * thinking pin, and SDK scopedModels share one settings snapshot.
 * Pass options.toolNames to pre-configure active tools (empty = all disabled).
 */
export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string,
  options: RpcSessionStartOptions = {},
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  const { initialModel, thinkingLevel, capabilitySelection, systemPromptSelection } = options;
  const processRuntimeProfile = getAgentRuntimeProfile();
  const runtimeProfile = options.runtimeProfile ?? processRuntimeProfile;
  assertCurrentAgentRuntimeProfile(runtimeProfile);
  if (sessionFile) {
    await resolveSessionAgentRuntimeProfile(sessionId, runtimeProfile);
  } else {
    // Validate the authoritative store before the SDK creates a new session
    // file. Device-control never falls back to an unbound session.
    readAgentProfileStore();
  }
  const toolNames = resolveAgentToolsForRuntimeProfile(runtimeProfile, options.toolNames);
  const registry = getRegistry();
  const locks = getLocks();

  const existing = registry.get(sessionId);
  if (existing?.isAlive()) {
    if (existing.runtimeProfile !== runtimeProfile) {
      throw new Error(`Live session ${sessionId} has a mismatched or unknown runtime profile.`);
    }
    return { session: existing, realSessionId: sessionId };
  }

  const lockKey = `${runtimeProfile}:${sessionId}`;
  const inflight = locks.get(lockKey);
  if (inflight) return inflight;

  const finishStartingSession = trackStartingSession(cwd);
  const starting = (async () => {
    // Some extensions access the SDK's global theme even outside the terminal UI.
    initTheme();
    const agentDir = getAgentDir();
    const projectRoot = (await resolveProject(cwd)).projectRoot;
    const projectToolRecord = readProjectToolSettings(projectRoot);

    const sessionManager = sessionFile
      ? SessionManager.open(sessionFile, undefined)
      : SessionManager.create(cwd, undefined);

    if (
      runtimeProfile === "normal"
      && !readLatestSessionSystemPromptBinding(sessionManager.getEntries())
    ) {
      appendSessionSystemPromptBinding(
        sessionManager,
        createSessionSystemPromptBinding(!sessionFile && systemPromptSelection
          ? systemPromptSelection
          : { mode: "default" }),
      );
    }

    // Determine which tools to pass based on requested toolNames.
    // Since v0.68.0, session creation expects string[] tool names instead of Tool[] instances.
    let toolsOption: string[] | undefined;
    if (runtimeProfile === "device-control") {
      // Passing the exact allow-list prevents built-in coding tools from even
      // entering the AgentSession registry. This is stronger than merely
      // marking them inactive after extensions have loaded.
      toolsOption = toolNames ?? [...DEVICE_CONTROL_AGENT_TOOLS];
    } else {
      // Normal sessions always register every globally available tool. Session
      // capabilities narrow only the active set so a disabled tool can be
      // re-enabled later without rebuilding the AgentSession.
      toolsOption = undefined;
    }

    // Build services first so extension-registered providers are available
    // before the SDK restores the saved model from the session file.
    // Services are cached per cwd: reusing the model runtime + resource loader
    // turns a ~5-8s session start into milliseconds and stops session creation
    // from blocking the event loop (which stalled session loading and left the
    // composer hidden while switching sessions).
    const sessionServicesKey = `${runtimeProfile}:${sessionId}`;
    let services = getServicesCache().get(sessionServicesKey);
    if (!services) {
      const settingsManager = SettingsManager.create(cwd, agentDir);
      const extensionPlan = await resolveExtensionLoadPlan({ cwd, agentDir, settingsManager, profile: runtimeProfile, installMissing: true });
      services = await createAgentSessionServices({
        cwd,
        agentDir,
        settingsManager,
        ...(runtimeProfile === "device-control"
          ? {
              resourceLoaderOptions: {
                additionalExtensionPaths: extensionPlan.enabledPaths,
                noExtensions: true,
                noSkills: true,
                noPromptTemplates: true,
                noThemes: true,
                noContextFiles: true,
                systemPromptOverride: () => undefined,
                appendSystemPromptOverride: () => [],
                agentsFilesOverride: () => ({ agentsFiles: [] }),
                extensionsOverride: (result) => applyExtensionLoadPlan(result, extensionPlan),
              },
            }
          : {
              resourceLoaderOptions: {
                additionalExtensionPaths: extensionPlan.enabledPaths,
                noExtensions: true,
                extensionsOverride: (result) => applyExtensionLoadPlan(result, extensionPlan),
                systemPromptOverride: (base) => resolveSessionSystemPrompt(
                  sessionManager.getEntries(),
                  base,
                  readSystemPromptConfig(),
                ),
              },
            }),
      });
      if (runtimeProfile === "device-control") {
        if (
          services.resourceLoader.getSkills().skills.length > 0
          || services.resourceLoader.getPrompts().prompts.length > 0
          || services.resourceLoader.getAgentsFiles().agentsFiles.length > 0
          || services.resourceLoader.getSystemPrompt() !== undefined
          || services.resourceLoader.getAppendSystemPrompt().length > 0
        ) {
          throw new Error("The device-control resource loader admitted user skills, prompts, system prompts, or context files.");
        }
      }
      getServicesCache().set(sessionServicesKey, services);
    }
    if (runtimeProfile === "normal") ensureWindowsBashShellPath(services.settingsManager);
    const scope = await resolveVisibleModels(
      services.modelRuntime,
      services.settingsManager.getEnabledModels(),
    );
    const defaultProvider = services.settingsManager.getDefaultProvider();
    const defaultModelId = services.settingsManager.getDefaultModel();
    const preferredDefault = resolveDefaultModelPreference({
      models: scope.visible,
      settingsProvider: defaultProvider,
      settingsModel: defaultModelId,
      environment: process.env,
    });
    const initial = sessionFile
      ? { scopedModels: [...scope.scopedModels] }
      : selectInitialModelScope(scope, {
        ...(initialModel ? { requestedModel: initialModel } : {}),
        ...(preferredDefault ? { defaultModel: preferredDefault } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
      });
    const { session: inner } = await createAgentSessionFromServices({
      services,
      sessionManager,
      ...(initial.model ? { model: initial.model } : {}),
      ...(initial.thinkingLevel ? { thinkingLevel: initial.thinkingLevel } : {}),
      ...(initial.scopedModels.length > 0 ? { scopedModels: initial.scopedModels } : {}),
      ...(toolsOption !== undefined ? { tools: toolsOption } : {}),
    });
    if (inner.model) {
      const configuredModel = applyConfiguredImageInput(inner.model);
      // Do not re-select an unchanged restored model: packaged smoke tests use
      // an intentionally credential-less placeholder model, and a redundant
      // setModel would turn that harmless placeholder into an API-key lookup.
      if (configuredModel !== inner.model) await inner.setModel(configuredModel);
    }

    const capabilityCatalog = buildSessionCapabilityCatalog(inner.getAllTools(), runtimeProfile);
    const restoredPolicy = projectToolRecord
      ? createSessionCapabilityPolicy(
          projectToolSelection(projectToolRecord),
          capabilityCatalog,
          runtimeProfile,
          projectToolRecord.revision - 1,
        )
      : sessionFile
        ? restoreSessionCapabilityPolicy(inner.sessionManager.getEntries(), capabilityCatalog, runtimeProfile)
        : createSessionCapabilityPolicy(
          capabilitySelection ?? (toolNames !== undefined ? selectionFromToolNames(toolNames, capabilityCatalog) : undefined),
          capabilityCatalog,
          runtimeProfile,
        );
    if (!sessionFile && !projectToolRecord) appendSessionCapabilityPolicy(inner.sessionManager, restoredPolicy);

    const realSessionId = inner.sessionId as string;
    const realSessionFile = inner.sessionFile as string | undefined;
    try {
      await bindSessionAgentRuntimeProfile(realSessionId, runtimeProfile);
    } catch (error) {
      if (!sessionFile && realSessionFile) quarantineUnboundSessionFile(realSessionFile);
      throw error;
    }

    const wrapper = new AgentSessionWrapper(inner, runtimeProfile, {
      policy: restoredPolicy,
      projectRoot,
      projectManaged: Boolean(projectToolRecord),
      ...(toolNames !== undefined ? { toolNameCeiling: toolNames } : {}),
    });
    wrapper.initializeSessionCapabilities();
    wrapper.start();

    if (realSessionFile) cacheSessionPath(realSessionId, realSessionFile);

    wrapper.onDestroy(() => {
      registry.delete(realSessionId);
      // A disposed AgentSession owns the ResourceLoader/runtime binding held by
      // its service bundle. Never reuse that bundle after the wrapper dies.
      getServicesCache().delete(sessionServicesKey);
    });
    registry.set(realSessionId, wrapper);
    wrapper.beginExtensionBinding({ forceEmptySystemPrompt: inner.getActiveToolNames().length === 0 });

    return { session: wrapper, realSessionId };
  })().finally(() => {
    locks.delete(lockKey);
    finishStartingSession();
  });

  locks.set(lockKey, starting);
  return starting;
}
