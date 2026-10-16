import {
  AGENT_OFFSCREEN_BOUNDS,
  AGENT_VIEWPORT,
  BRIDGE_UNAVAILABLE_ERROR,
  CDP_TIMEOUT_MS,
  EVALUATE_DISABLED_ERROR,
  IDLE_UNLOAD_MS,
  ISOLATED_WORLD_ID,
  InFlightCounter,
  MANUAL_BROWSER_SESSION_ID,
  PAUSED_BY_USER_ERROR,
  REFS_INVALID_ERROR,
  RELOAD_NOTICE,
  RENDERER_CRASHED_ERROR,
  REQUEST_TIMEOUT_MS,
  abortReason,
  assertAgentTabCapacity,
  buildKeyDispatchEvents,
  classifyInputEvent,
  createPendingRequestTable,
  elementCenterInvocation,
  focusInvocation,
  formatSnapshot,
  httpUrl,
  isPausedAction,
  resolveOwnedTab,
  scrollInvocation,
  SNAPSHOT_COLLECT_SCRIPT,
  type OwnedTabCandidate,
  type SnapshotNode,
} from "./browser-agent-logic.js";

export interface BrowserAgentTabState extends OwnedTabCandidate {
  url: string;
  title: string;
  unloaded: boolean;
}

export interface BrowserAgentActivity {
  sessionId: string;
  tabId: string | null;
  operating: boolean;
  paused: boolean;
}

export interface BrowserAgentHost {
  mainWebContentsId: number;
  now(): number;
  platform: string;
  log: {
    info(message: string, details?: unknown): void;
    warn(message: string, details?: unknown): void;
  };
  listTabs(): BrowserAgentTabState[];
  createTab(sessionId: string, url: string): BrowserAgentTabState;
  closeTab(tabId: string): void;
  loadURL(tabId: string, url: string): Promise<void>;
  goBack(tabId: string): Promise<void> | void;
  goForward(tabId: string): Promise<void> | void;
  reload(tabId: string): Promise<void> | void;
  discardTab(tabId: string): void;
  restoreTab(tabId: string): Promise<void>;
  isShowing(tabId: string): boolean;
  panelBounds(): { x: number; y: number; width: number; height: number } | null;
  setBounds(tabId: string, bounds: { x: number; y: number; width: number; height: number }): void;
  attach(tabId: string): void;
  detach(tabId: string): void;
  setBackgroundThrottling(tabId: string, allowed: boolean): void;
  capturePage(tabId: string, options: { stayHidden: boolean; stayAwake: boolean }): Promise<{ byteLength: number; base64: string }>;
  executeIsolated(tabId: string, worldId: number, code: string): Promise<unknown>;
  debuggerAttach(tabId: string, version: string): void;
  debuggerDetach(tabId: string): void;
  debuggerIsAttached(tabId: string): boolean;
  debuggerSend(tabId: string, method: string, params?: Record<string, unknown>): Promise<unknown>;
  onTabEvent(
    tabId: string,
    event: "render-process-gone" | "debugger-detach" | "input-event" | "destroyed",
    handler: (payload?: unknown) => void,
  ): () => void;
  pushActivity(activity: BrowserAgentActivity): void;
}

export interface BrowserAgentRequest {
  requestId: string;
  sessionId: string;
  action: string;
  tabId?: string;
  url?: string;
  selector?: string;
  ref?: string;
  text?: string;
  key?: string;
  submit?: boolean;
  deltaX?: number;
  deltaY?: number;
  x?: number;
  y?: number;
  tabIndex?: number;
  fullPage?: boolean;
}

export interface BrowserAgentResponse {
  type: "pi-desktop:browser-agent-response";
  requestId: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}

export interface BrowserAgentControlOptions {
  cdpTimeoutMs?: number;
  requestTimeoutMs?: number;
  idleUnloadMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface CommandEntry {
  tabId: string;
  timer: unknown;
  reject: (error: Error) => void;
}

interface TabMeta {
  agentOpened: boolean;
  refsInvalid: boolean;
  reloadedNotice: boolean;
}

const ACTIONS = new Set([
  "open", "back", "forward", "reload", "snapshot", "click", "type", "press", "scroll",
  "screenshot", "tabs", "new_tab", "switch_tab", "close_tab", "idle", "session_closed", "evaluate",
]);

function safeRef(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ref = value.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(ref)) throw new Error("Invalid element ref.");
  return ref;
}

function limited(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > max) throw new Error("Browser argument is too long.");
  return text;
}

export class BrowserAgentControl {
  private readonly host: BrowserAgentHost;
  private readonly cdpTimeoutMs: number;
  private readonly idleUnloadMs: number;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly pending: ReturnType<typeof createPendingRequestTable>;
  private readonly inflight = new InFlightCounter();
  private readonly agentTabs = new Map<string, string>();
  private readonly sessionActive = new Map<string, boolean>();
  private readonly paused = new Set<string>();
  private readonly meta = new Map<string, TabMeta>();
  private readonly lastUsed = new Map<string, number>();
  private readonly metrics = new Set<string>();
  private readonly presented = new Set<string>();
  private readonly selfChecked = new Set<string>();
  private readonly watched = new Set<string>();
  private readonly unsubscribers = new Map<string, Array<() => void>>();
  private readonly commands = new Map<number, CommandEntry>();
  private commandSeq = 0;
  private readonly idleTimer: NodeJS.Timeout;
  private stopped = false;

  constructor(host: BrowserAgentHost, options: BrowserAgentControlOptions = {}) {
    this.host = host;
    this.cdpTimeoutMs = options.cdpTimeoutMs ?? CDP_TIMEOUT_MS;
    this.idleUnloadMs = options.idleUnloadMs ?? IDLE_UNLOAD_MS;
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.pending = createPendingRequestTable({
      timeoutMs: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      ...(options.setTimer ? { setTimer: options.setTimer } : {}),
      clearTimer: this.clearTimer,
    });
    this.idleTimer = setInterval(() => {
      try { this.sweepIdle(); } catch (error) {
        this.host.log.warn("Browser agent idle sweep failed", error);
      }
    }, 60_000);
    this.idleTimer.unref();
  }

  inFlight(tabId: string): number {
    return this.inflight.count(tabId);
  }

  isPaused(sessionId: string): boolean {
    return this.paused.has(sessionId);
  }

  agentTabId(sessionId: string): string | null {
    return this.agentTabs.get(sessionId) ?? null;
  }

  status(sessionId: string): { tabId: string | null; operating: boolean; paused: boolean } {
    return {
      tabId: this.agentTabId(sessionId),
      operating: this.sessionActive.get(sessionId) === true,
      paused: this.paused.has(sessionId),
    };
  }

  noteUsed(tabId: string): void {
    this.lastUsed.set(tabId, this.host.now());
  }

  heldTabs(): Array<{ id: string; bounds: { x: number; y: number; width: number; height: number } }> {
    const held: Array<{ id: string; bounds: { x: number; y: number; width: number; height: number } }> = [];
    const seen = new Set<string>();
    const consider = (tabId: string) => {
      if (seen.has(tabId) || this.host.isShowing(tabId)) return;
      const tab = this.tab(tabId);
      if (!tab || tab.closed || tab.unloaded) return;
      seen.add(tabId);
      held.push({ id: tabId, bounds: { ...AGENT_OFFSCREEN_BOUNDS } });
    };
    for (const [sessionId, tabId] of this.agentTabs) {
      if (this.sessionActive.get(sessionId) !== true || this.paused.has(sessionId)) continue;
      consider(tabId);
    }
    // A one-off action may briefly override a non-current tab. Keep it attached
    // until that action releases the override, or the next visibility pass
    // would detach it before capture and input can finish.
    for (const tabId of this.metrics) consider(tabId);
    return held;
  }

  afterVisibilityChange(): void {
    void this.syncHolds().catch((error) => this.host.log.warn("Browser agent visibility sync failed", error));
  }

  pauseSession(sessionId: string): void {
    if (!sessionId || sessionId === MANUAL_BROWSER_SESSION_ID) return;
    this.paused.add(sessionId);
    this.publish(sessionId);
    const tabId = this.agentTabs.get(sessionId);
    if (tabId) void this.releaseHold(tabId).catch(() => undefined);
  }

  resumeSession(sessionId: string): void {
    this.paused.delete(sessionId);
    this.publish(sessionId);
    if (this.sessionActive.get(sessionId) === true) {
      const tabId = this.agentTabs.get(sessionId);
      if (tabId) void this.prepareSurface(tabId).catch(() => undefined);
    }
  }

  cancel(requestId: string): void {
    this.pending.cancel(requestId, new Error("Browser action aborted"));
  }

  failAll(message: string): void {
    this.pending.failAll(new Error(message));
    for (const [id, entry] of this.commands) {
      this.clearTimer(entry.timer);
      this.commands.delete(id);
      entry.reject(new Error(message));
    }
  }

  destroy(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.idleTimer);
    this.failAll("Browser agent control stopped");
    for (const unsubs of this.unsubscribers.values()) {
      for (const unsubscribe of unsubs) unsubscribe();
    }
    this.unsubscribers.clear();
  }

  sweepIdle(now = this.host.now()): string[] {
    const unloaded: string[] = [];
    for (const tab of this.host.listTabs()) {
      if (tab.closed || tab.unloaded) continue;
      const seen = this.lastUsed.get(tab.id);
      if (seen === undefined) {
        this.lastUsed.set(tab.id, now);
        continue;
      }
      if (now - seen < this.idleUnloadMs) continue;
      if (this.host.isShowing(tab.id)) continue;
      const sessionId = tab.sessionId;
      if (this.sessionActive.get(sessionId) === true && this.agentTabs.get(sessionId) === tab.id && !this.paused.has(sessionId)) continue;
      this.detachQuiet(tab.id);
      this.host.discardTab(tab.id);
      const meta = this.metaOf(tab.id);
      meta.refsInvalid = true;
      unloaded.push(tab.id);
    }
    return unloaded;
  }

  async handleRequest(message: unknown): Promise<BrowserAgentResponse> {
    const requestId = message && typeof message === "object" && typeof (message as { requestId?: unknown }).requestId === "string"
      ? (message as { requestId: string }).requestId
      : "";
    try {
      const request = normalizeRequest(message);
      if (!request) return { type: "pi-desktop:browser-agent-response", requestId, ok: false, error: "Invalid browser agent request" };
      const value = await this.execute(request);
      return { type: "pi-desktop:browser-agent-response", requestId: request.requestId, ok: true, value };
    } catch (error) {
      return {
        type: "pi-desktop:browser-agent-response",
        requestId,
        ok: false,
        error: error instanceof Error ? error.message : "Browser agent request failed",
      };
    }
  }

  private async execute(request: BrowserAgentRequest): Promise<unknown> {
    if (this.stopped) throw new Error(BRIDGE_UNAVAILABLE_ERROR);
    const controller = new AbortController();
    this.pending.track(request.requestId, controller);
    const signal = controller.signal;
    try {
      return await new Promise((resolve, reject) => {
        const onAbort = () => reject(abortReason(signal, "Browser action aborted"));
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        this.dispatch(request, signal).then((value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        }, (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      });
    } finally {
      this.pending.finish(request.requestId);
    }
  }

  private async dispatch(request: BrowserAgentRequest, signal: AbortSignal): Promise<unknown> {
    this.throwIfAborted(signal);
    if (!ACTIONS.has(request.action)) throw new Error(`Unsupported browser action: ${request.action}`);
    if (request.action === "evaluate") throw new Error(EVALUATE_DISABLED_ERROR);
    if (request.action === "idle") return this.idle(request.sessionId);
    if (request.action === "session_closed") return this.closeSession(request.sessionId);
    if (this.paused.has(request.sessionId) && isPausedAction(request.action)) throw new Error(PAUSED_BY_USER_ERROR);
    this.sweepIdle();
    switch (request.action) {
      case "open":
        return this.open(request, signal);
      case "new_tab":
        return this.newTab(request, signal);
      case "switch_tab":
        return this.switchTab(request, signal);
      case "close_tab":
        return this.closeTab(request);
      case "tabs":
        return this.listSessionTabs(request.sessionId);
      case "snapshot":
        return this.snapshot(request, signal);
      case "screenshot":
        return this.screenshot(request, signal);
      case "click":
        return this.click(request, signal);
      case "type":
        return this.type(request, signal);
      case "press":
        return this.press(request, signal);
      case "scroll":
        return this.scroll(request, signal);
      case "back":
      case "forward":
      case "reload":
        return this.navigateHistory(request, signal);
      default:
        throw new Error(`Unsupported browser action: ${request.action}`);
    }
  }

  private async open(request: BrowserAgentRequest, signal: AbortSignal): Promise<unknown> {
    if (!request.url) throw new Error("open requires url");
    const url = httpUrl(request.url);
    let tab = this.currentTab(request.sessionId);
    let created = false;
    if (!tab) {
      tab = this.createAgentTab(request.sessionId, url);
      created = true;
    }
    this.rememberAgentTab(request.sessionId, tab.id);
    const notice = await this.prepare(tab.id, request.sessionId, signal);
    if (!created) {
      await this.host.loadURL(tab.id, url);
      this.metaOf(tab.id).refsInvalid = false;
    }
    this.throwIfAborted(signal);
    this.publish(request.sessionId);
    const loaded = this.tab(tab.id);
    return {
      action: "open",
      tabId: tab.id,
      url: loaded?.url ?? url,
      title: loaded?.title ?? "",
      text: `Opened ${loaded?.url ?? url}\n${loaded?.title || "Untitled"}\ntabId=${tab.id}${notice ? `\n${notice}` : ""}`,
      ...(notice ? { notice } : {}),
    };
  }

  private async newTab(request: BrowserAgentRequest, signal: AbortSignal): Promise<unknown> {
    const url = request.url ? httpUrl(request.url) : "about:blank";
    const previous = this.agentTabs.get(request.sessionId);
    const tab = this.createAgentTab(request.sessionId, url);
    if (previous && previous !== tab.id) await this.releaseHold(previous);
    this.rememberAgentTab(request.sessionId, tab.id);
    await this.prepare(tab.id, request.sessionId, signal);
    this.throwIfAborted(signal);
    this.publish(request.sessionId);
    const loaded = this.tab(tab.id);
    return {
      action: "new_tab",
      tabId: tab.id,
      url: loaded?.url ?? url,
      title: loaded?.title ?? "",
      text: `Opened tab ${tab.id}\n${loaded?.url ?? url}\ntabId=${tab.id}`,
    };
  }

  private async switchTab(request: BrowserAgentRequest, signal: AbortSignal): Promise<unknown> {
    const tabs = this.sessionTabs(request.sessionId);
    let target = request.tabId ? this.tab(request.tabId) : undefined;
    if (!target && request.tabIndex !== undefined) target = tabs[Math.floor(request.tabIndex)];
    if (!target || target.sessionId !== request.sessionId || target.closed) {
      throw new Error(request.tabIndex !== undefined
        ? `tabIndex must be between 0 and ${Math.max(0, tabs.length - 1)}`
        : "Browser tab is closed.");
    }
    const owned = resolveOwnedTab({
      sessionId: request.sessionId,
      requestedTabId: target.id,
      tabs: this.host.listTabs(),
      mainWebContentsId: this.host.mainWebContentsId,
    });
    if (!owned.ok) throw new Error(owned.error);
    const previous = this.agentTabs.get(request.sessionId);
    if (previous && previous !== target.id) await this.releaseHold(previous);
    this.rememberAgentTab(request.sessionId, target.id);
    const notice = await this.prepare(target.id, request.sessionId, signal);
    this.publish(request.sessionId);
    const loaded = this.tab(target.id);
    return {
      action: "switch_tab",
      tabId: target.id,
      url: loaded?.url ?? "",
      title: loaded?.title ?? "",
      text: `Switched to ${loaded?.title || "Untitled"}\n${loaded?.url ?? ""}\ntabId=${target.id}${notice ? `\n${notice}` : ""}`,
      ...(notice ? { notice } : {}),
    };
  }

  private async closeTab(request: BrowserAgentRequest): Promise<unknown> {
    const tabs = this.sessionTabs(request.sessionId);
    let target = request.tabId ? this.tab(request.tabId) : undefined;
    if (!target && request.tabIndex !== undefined) target = tabs[Math.floor(request.tabIndex)];
    if (!target) target = this.currentTab(request.sessionId) ?? undefined;
    if (!target || target.sessionId !== request.sessionId) throw new Error("Browser tab is closed.");
    const closingId = target.id;
    await this.releaseHold(closingId);
    this.detachQuiet(closingId);
    this.host.closeTab(closingId);
    this.agentOpenedDelete(closingId);
    if (this.agentTabs.get(request.sessionId) === closingId) {
      const remaining = this.sessionTabs(request.sessionId).find((candidate) => candidate.id !== closingId && !candidate.closed);
      if (remaining) this.agentTabs.set(request.sessionId, remaining.id);
      else this.agentTabs.delete(request.sessionId);
    }
    this.publish(request.sessionId);
    return { action: "close_tab", tabId: this.agentTabs.get(request.sessionId) ?? null, text: `Closed tab ${closingId}` };
  }

  private listSessionTabs(sessionId: string): unknown {
    this.assertSession(sessionId);
    const current = this.agentTabs.get(sessionId);
    const tabs = this.sessionTabs(sessionId).map((tab, index) => ({
      index,
      tabId: tab.id,
      title: tab.title || "Untitled",
      url: tab.url,
      active: tab.id === current,
    }));
    const lines = tabs.map((tab) => `${tab.index}: ${tab.title} — ${tab.url}${tab.active ? " (active)" : ""} tabId=${tab.tabId}`);
    return { action: "tabs", tabs, tabId: current ?? null, text: lines.join("\n") || "No tabs", count: tabs.length };
  }

  private async snapshot(request: BrowserAgentRequest, signal: AbortSignal): Promise<unknown> {
    return this.withOwnedTab(request, signal, async (tab) => {
      const raw = await this.host.executeIsolated(tab.id, ISOLATED_WORLD_ID, SNAPSHOT_COLLECT_SCRIPT);
      this.throwIfAborted(signal);
      const parsed = parseSnapshot(raw);
      const meta = this.metaOf(tab.id);
      const notice = meta.reloadedNotice ? RELOAD_NOTICE : undefined;
      meta.reloadedNotice = false;
      meta.refsInvalid = false;
      const text = formatSnapshot({ ...parsed, ...(notice ? { notice } : {}) });
      const loaded = this.tab(tab.id);
      return { action: "snapshot", tabId: tab.id, url: loaded?.url ?? parsed.url, title: loaded?.title ?? parsed.title, text, truncated: parsed.truncated, passwordField: parsed.passwordField };
    });
  }

  private async screenshot(request: BrowserAgentRequest, signal: AbortSignal): Promise<unknown> {
    return this.withOwnedTab(request, signal, async (tab) => {
      const image = await this.host.capturePage(tab.id, { stayHidden: true, stayAwake: true });
      this.throwIfAborted(signal);
      if (!image.byteLength) throw new Error("Screenshot was empty.");
      const loaded = this.tab(tab.id);
      return {
        action: "screenshot",
        tabId: tab.id,
        url: loaded?.url ?? "",
        title: loaded?.title ?? "",
        text: `${loaded?.title || "Untitled"}\n${loaded?.url ?? ""}`,
        imageBase64: image.base64,
        byteLength: image.byteLength,
        fullPage: false,
      };
    });
  }

  private async click(request: BrowserAgentRequest, signal: AbortSignal): Promise<unknown> {
    return this.withOwnedTab(request, signal, async (tab) => {
      this.assertRefs(tab.id, request);
      const point = await this.elementPoint(tab.id, request);
      this.throwIfAborted(signal);
      await this.inputCommand(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none", clickCount: 0 });
      await this.inputCommand(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
      await this.inputCommand(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
      this.throwIfAborted(signal);
      return this.pageResult(request, tab.id);
    });
  }

  private async type(request: BrowserAgentRequest, signal: AbortSignal): Promise<unknown> {
    if (request.text === undefined) throw new Error("type requires text");
    return this.withOwnedTab(request, signal, async (tab) => {
      this.assertRefs(tab.id, request);
      if (request.ref || request.selector) {
        const focused = await this.host.executeIsolated(tab.id, ISOLATED_WORLD_ID, focusInvocation({
          ...(request.ref ? { ref: request.ref } : {}),
          ...(request.selector ? { selector: request.selector } : {}),
        }));
        const result = focused as { ok?: boolean; error?: string };
        if (result && result.ok === false) throw new Error(result.error || "Element ref was not found. Take a new snapshot.");
      }
      await this.inputCommand(tab.id, "Input.insertText", { text: request.text });
      if (request.submit) {
        for (const event of buildKeyDispatchEvents("Enter")) await this.inputCommand(tab.id, "Input.dispatchKeyEvent", eventRecord(event));
      }
      this.throwIfAborted(signal);
      return this.pageResult(request, tab.id);
    });
  }

  private async press(request: BrowserAgentRequest, signal: AbortSignal): Promise<unknown> {
    return this.withOwnedTab(request, signal, async (tab) => {
      const events = buildKeyDispatchEvents(request.key || "Enter");
      for (const event of events) {
        this.throwIfAborted(signal);
        await this.inputCommand(tab.id, "Input.dispatchKeyEvent", eventRecord(event));
      }
      return this.pageResult(request, tab.id);
    });
  }

  private async scroll(request: BrowserAgentRequest, signal: AbortSignal): Promise<unknown> {
    return this.withOwnedTab(request, signal, async (tab) => {
      this.assertRefs(tab.id, request);
      const intoView = Boolean(request.ref || request.selector) && request.deltaY === undefined && request.deltaX === undefined;
      const script = scrollInvocation({
        ...(request.ref ? { ref: request.ref } : {}),
        ...(request.selector ? { selector: request.selector } : {}),
        ...(request.x !== undefined ? { x: request.x } : {}),
        ...(request.y !== undefined ? { y: request.y } : {}),
        deltaX: request.deltaX ?? 0,
        deltaY: intoView ? 0 : request.deltaY ?? 720,
        intoView,
      });
      const raw = await this.host.executeIsolated(tab.id, ISOLATED_WORLD_ID, script);
      this.throwIfAborted(signal);
      const result = raw as { ok?: boolean; error?: string };
      if (result && result.ok === false) throw new Error(result.error || "Scroll failed.");
      return this.pageResult(request, tab.id);
    });
  }

  private async navigateHistory(request: BrowserAgentRequest, signal: AbortSignal): Promise<unknown> {
    return this.withOwnedTab(request, signal, async (tab) => {
      if (request.action === "back") await this.host.goBack(tab.id);
      else if (request.action === "forward") await this.host.goForward(tab.id);
      else await this.host.reload(tab.id);
      this.metaOf(tab.id).refsInvalid = true;
      this.metaOf(tab.id).reloadedNotice = true;
      this.throwIfAborted(signal);
      return this.pageResult(request, tab.id, RELOAD_NOTICE);
    });
  }

  private idle(sessionId: string): unknown {
    this.assertSession(sessionId);
    this.sessionActive.set(sessionId, false);
    const tabId = this.agentTabs.get(sessionId);
    if (tabId) void this.releaseHold(tabId).catch(() => undefined);
    this.publish(sessionId);
    return { action: "idle", tabId: tabId ?? null, text: "Agent browser tab restored to the background." };
  }

  private async closeSession(sessionId: string): Promise<unknown> {
    this.assertSession(sessionId);
    const tabs = this.sessionTabs(sessionId);
    for (const tab of tabs) {
      await this.releaseHold(tab.id);
      this.detachQuiet(tab.id);
      this.host.closeTab(tab.id);
      this.agentOpenedDelete(tab.id);
    }
    this.agentTabs.delete(sessionId);
    this.sessionActive.delete(sessionId);
    this.paused.delete(sessionId);
    this.publish(sessionId);
    return { action: "session_closed", closed: tabs.length, text: `Closed ${tabs.length} browser tabs for this session.` };
  }

  private async requireTab(request: BrowserAgentRequest, signal: AbortSignal): Promise<BrowserAgentTabState> {
    const agentTabId = this.agentTabs.get(request.sessionId);
    const owned = resolveOwnedTab({
      sessionId: request.sessionId,
      ...(request.tabId ? { requestedTabId: request.tabId } : {}),
      ...(agentTabId ? { agentTabId } : {}),
      tabs: this.host.listTabs(),
      mainWebContentsId: this.host.mainWebContentsId,
    });
    if (!owned.ok) throw new Error(owned.error);
    try {
      await this.prepare(owned.tab.id, request.sessionId, signal);
      this.throwIfAborted(signal);
      const tab = this.tab(owned.tab.id);
      if (!tab || tab.closed) throw new Error("Browser tab is closed.");
      return tab;
    } catch (error) {
      await this.releaseBorrowed(request.sessionId, owned.tab.id).catch(() => undefined);
      throw error;
    }
  }

  private async withOwnedTab<T>(request: BrowserAgentRequest, signal: AbortSignal, run: (tab: BrowserAgentTabState) => Promise<T>): Promise<T> {
    const tab = await this.requireTab(request, signal);
    try {
      return await run(tab);
    } finally {
      await this.releaseBorrowed(request.sessionId, tab.id);
    }
  }

  private async releaseBorrowed(sessionId: string, tabId: string): Promise<void> {
    if (this.agentTabs.get(sessionId) === tabId) return;
    await this.releaseHold(tabId);
  }

  private async prepare(tabId: string, sessionId: string, signal: AbortSignal): Promise<string | undefined> {
    this.throwIfAborted(signal);
    this.sessionActive.set(sessionId, true);
    this.noteUsed(tabId);
    this.watch(tabId);
    this.ensureDebugger(tabId);
    const meta = this.metaOf(tabId);
    const tab = this.tab(tabId);
    if (tab?.unloaded) {
      await this.host.restoreTab(tabId);
      meta.refsInvalid = true;
      meta.reloadedNotice = true;
      this.metrics.delete(tabId);
      this.presented.delete(tabId);
      this.selfChecked.delete(tabId);
    }
    await this.prepareSurface(tabId);
    this.throwIfAborted(signal);
    return meta.reloadedNotice ? RELOAD_NOTICE : undefined;
  }

  private assertRefs(tabId: string, request: BrowserAgentRequest): void {
    const meta = this.metaOf(tabId);
    if (!meta.refsInvalid) return;
    if (request.ref || request.selector || request.action === "click" || request.action === "type" || request.action === "scroll") {
      throw new Error(REFS_INVALID_ERROR);
    }
  }

  private async prepareSurface(tabId: string): Promise<void> {
    if (this.host.isShowing(tabId)) await this.showNative(tabId);
    else await this.placeOffscreen(tabId);
  }

  private async showNative(tabId: string): Promise<void> {
    const bounds = this.host.panelBounds();
    if (!bounds) return;
    this.host.attach(tabId);
    this.host.setBounds(tabId, bounds);
    if (this.metrics.has(tabId) || !this.presented.has(tabId)) {
      await this.command(tabId, "Emulation.clearDeviceMetricsOverride", {});
      this.metrics.delete(tabId);
      const inner = await this.host.executeIsolated(tabId, ISOLATED_WORLD_ID, "innerWidth");
      if (typeof inner === "number" && inner !== bounds.width) {
        this.host.setBounds(tabId, { x: bounds.x, y: bounds.y, width: bounds.width + 1, height: bounds.height });
        this.host.setBounds(tabId, bounds);
      }
      this.presented.add(tabId);
    }
    this.host.setBackgroundThrottling(tabId, true);
  }

  private async placeOffscreen(tabId: string): Promise<void> {
    this.presented.delete(tabId);
    this.host.attach(tabId);
    this.host.setBounds(tabId, { ...AGENT_OFFSCREEN_BOUNDS });
    this.host.setBackgroundThrottling(tabId, false);
    if (!this.metrics.has(tabId)) {
      await this.command(tabId, "Emulation.setDeviceMetricsOverride", {
        width: AGENT_VIEWPORT.width,
        height: AGENT_VIEWPORT.height,
        deviceScaleFactor: AGENT_VIEWPORT.deviceScaleFactor,
        mobile: AGENT_VIEWPORT.mobile,
      });
      this.metrics.add(tabId);
    }
    if (!this.selfChecked.has(tabId)) {
      this.selfChecked.add(tabId);
      let visibilityState = "unknown";
      try {
        const value = await this.host.executeIsolated(tabId, ISOLATED_WORLD_ID, "document.visibilityState");
        visibilityState = typeof value === "string" ? value : "unknown";
      } catch (error) {
        this.host.log.warn("Browser agent offscreen visibility check failed", error);
      }
      let byteLength = 0;
      try {
        const image = await this.host.capturePage(tabId, { stayHidden: true, stayAwake: true });
        byteLength = image.byteLength;
      } catch (error) {
        this.host.log.warn("Browser agent offscreen capture check failed", error);
      }
      this.host.log.info(`[browser-agent] offscreen-selfcheck platform=${this.host.platform} visibilityState=${visibilityState} image=${byteLength}`);
    }
  }

  private async releaseHold(tabId: string): Promise<void> {
    if (this.metrics.has(tabId)) {
      try {
        await this.command(tabId, "Emulation.clearDeviceMetricsOverride", {});
      } catch {
        // The tab may already be gone. Throttling still returns to the default.
      }
      this.metrics.delete(tabId);
    }
    this.presented.delete(tabId);
    try {
      this.host.setBackgroundThrottling(tabId, true);
    } catch {
      // Closed tabs have no throttling state.
    }
    if (!this.host.isShowing(tabId)) {
      try { this.host.detach(tabId); } catch { /* already detached */ }
    }
  }

  private async syncHolds(): Promise<void> {
    for (const [sessionId, tabId] of this.agentTabs) {
      if (this.sessionActive.get(sessionId) !== true || this.paused.has(sessionId)) continue;
      const tab = this.tab(tabId);
      if (!tab || tab.closed || tab.unloaded) continue;
      await this.prepareSurface(tabId);
    }
  }

  private createAgentTab(sessionId: string, url: string): BrowserAgentTabState {
    this.assertSession(sessionId);
    const open = this.host.listTabs().filter((tab) => tab.sessionId === sessionId && !tab.closed && this.metaOf(tab.id).agentOpened).length;
    assertAgentTabCapacity(open);
    const tab = this.host.createTab(sessionId, url);
    const meta = this.metaOf(tab.id);
    meta.agentOpened = true;
    this.noteUsed(tab.id);
    this.watch(tab.id);
    return tab;
  }

  private rememberAgentTab(sessionId: string, tabId: string): void {
    this.agentTabs.set(sessionId, tabId);
  }

  private currentTab(sessionId: string): BrowserAgentTabState | undefined {
    const id = this.agentTabs.get(sessionId);
    if (!id) return undefined;
    const tab = this.tab(id);
    if (!tab || tab.closed) {
      this.agentTabs.delete(sessionId);
      return undefined;
    }
    return tab;
  }

  private async elementPoint(tabId: string, request: BrowserAgentRequest): Promise<{ x: number; y: number }> {
    if (!request.ref && !request.selector) {
      if (request.x !== undefined && request.y !== undefined) return { x: request.x, y: request.y };
      throw new Error("This browser action requires selector or ref.");
    }
    const raw = await this.host.executeIsolated(tabId, ISOLATED_WORLD_ID, elementCenterInvocation({
      ...(request.ref ? { ref: request.ref } : {}),
      ...(request.selector ? { selector: request.selector } : {}),
    }));
    const point = raw as { ok?: boolean; error?: string; x?: number; y?: number; width?: number; height?: number };
    if (!point || point.ok === false) throw new Error(point?.error || "Element ref was not found. Take a new snapshot.");
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("Element is not visible.");
    if ((point.width ?? 1) <= 0 || (point.height ?? 1) <= 0) throw new Error("Element is not visible.");
    return { x: Math.round(point.x!), y: Math.round(point.y!) };
  }

  private pageResult(request: BrowserAgentRequest, tabId: string, notice?: string): unknown {
    const tab = this.tab(tabId);
    const text = `${tab?.title || "Untitled"}\n${tab?.url ?? ""}${notice ? `\n${notice}` : ""}`;
    return {
      action: request.action,
      tabId,
      url: tab?.url ?? "",
      title: tab?.title ?? "",
      text,
      ...(notice ? { notice } : {}),
    };
  }

  private async inputCommand(tabId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    this.inflight.increment(tabId);
    try {
      return await this.command(tabId, method, params);
    } finally {
      this.inflight.decrement(tabId);
    }
  }

  private command(tabId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++this.commandSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.commands.has(id)) return;
        this.commands.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, this.cdpTimeoutMs);
      const handle = timer as { unref?: () => void };
      handle.unref?.();
      this.commands.set(id, { tabId, timer, reject });
      this.host.debuggerSend(tabId, method, params).then((value) => {
        const entry = this.commands.get(id);
        if (!entry) return;
        this.clearTimer(entry.timer);
        this.commands.delete(id);
        resolve(value);
      }, (error: unknown) => {
        const entry = this.commands.get(id);
        if (!entry) return;
        this.clearTimer(entry.timer);
        this.commands.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private ensureDebugger(tabId: string): void {
    if (this.host.debuggerIsAttached(tabId)) return;
    try {
      this.host.debuggerAttach(tabId, "1.3");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already attached/i.test(message)) throw error;
    }
  }

  private watch(tabId: string): void {
    if (this.watched.has(tabId)) return;
    this.watched.add(tabId);
    const unsubs = [
      this.host.onTabEvent(tabId, "render-process-gone", () => this.onRendererGone(tabId)),
      this.host.onTabEvent(tabId, "debugger-detach", () => this.onDebuggerDetach(tabId)),
      this.host.onTabEvent(tabId, "destroyed", () => this.onDebuggerDetach(tabId)),
      this.host.onTabEvent(tabId, "input-event", (payload) => this.onInput(tabId, payload)),
    ];
    this.unsubscribers.set(tabId, unsubs);
  }

  private onRendererGone(tabId: string): void {
    this.rejectTabCommands(tabId, new Error(RENDERER_CRASHED_ERROR));
    this.metrics.delete(tabId);
    this.presented.delete(tabId);
    const sessionId = this.tab(tabId)?.sessionId;
    if (sessionId && this.agentTabs.get(sessionId) === tabId) this.publish(sessionId);
  }

  private onDebuggerDetach(tabId: string): void {
    this.rejectTabCommands(tabId, new Error("Browser tab is closed."));
    this.metrics.delete(tabId);
    this.presented.delete(tabId);
  }

  private onInput(tabId: string, payload: unknown): void {
    const type = payload && typeof payload === "object" && typeof (payload as { type?: unknown }).type === "string"
      ? (payload as { type: string }).type
      : "";
    if (classifyInputEvent(type, this.inflight.count(tabId)) !== "user") return;
    const sessionId = this.tab(tabId)?.sessionId ?? this.sessionForTab(tabId);
    if (!sessionId || sessionId === MANUAL_BROWSER_SESSION_ID) return;
    this.pauseSession(sessionId);
  }

  private rejectTabCommands(tabId: string, error: Error): void {
    for (const [id, entry] of this.commands) {
      if (entry.tabId !== tabId) continue;
      this.clearTimer(entry.timer);
      this.commands.delete(id);
      entry.reject(error);
    }
  }

  private detachQuiet(tabId: string): void {
    if (!this.host.debuggerIsAttached(tabId)) return;
    try { this.host.debuggerDetach(tabId); } catch { /* already detached */ }
  }

  private publish(sessionId: string): void {
    this.host.pushActivity({
      sessionId,
      tabId: this.agentTabs.get(sessionId) ?? null,
      operating: this.sessionActive.get(sessionId) === true,
      paused: this.paused.has(sessionId),
    });
  }

  private sessionTabs(sessionId: string): BrowserAgentTabState[] {
    return this.host.listTabs().filter((tab) => tab.sessionId === sessionId && !tab.closed);
  }

  private tab(tabId: string): BrowserAgentTabState | undefined {
    return this.host.listTabs().find((tab) => tab.id === tabId);
  }

  private sessionForTab(tabId: string): string | undefined {
    return this.tab(tabId)?.sessionId;
  }

  private metaOf(tabId: string): TabMeta {
    const existing = this.meta.get(tabId);
    if (existing) return existing;
    const created: TabMeta = { agentOpened: false, refsInvalid: false, reloadedNotice: false };
    this.meta.set(tabId, created);
    return created;
  }

  private agentOpenedDelete(tabId: string): void {
    const meta = this.meta.get(tabId);
    if (meta) meta.agentOpened = false;
  }

  private assertSession(sessionId: string): void {
    if (!sessionId || sessionId === MANUAL_BROWSER_SESSION_ID) {
      throw new Error("Refusing to control the manual browser session.");
    }
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw abortReason(signal, "Browser action aborted");
  }
}

function eventRecord(event: ReturnType<typeof buildKeyDispatchEvents>[number]): Record<string, unknown> {
  return {
    type: event.type,
    key: event.key,
    code: event.code,
    windowsVirtualKeyCode: event.windowsVirtualKeyCode,
    modifiers: event.modifiers,
    ...(event.text !== undefined ? { text: event.text } : {}),
  };
}

function parseSnapshot(raw: unknown): { title: string; url: string; nodes: SnapshotNode[]; truncated: boolean; passwordField: boolean } {
  const value = raw as {
    title?: unknown;
    url?: unknown;
    nodes?: unknown;
    truncated?: unknown;
    passwordField?: unknown;
  } | null;
  if (!value || typeof value !== "object" || !Array.isArray(value.nodes)) throw new Error("Snapshot failed.");
  const nodes: SnapshotNode[] = [];
  for (const node of value.nodes) {
    if (!node || typeof node !== "object") continue;
    const candidate = node as SnapshotNode;
    if (typeof candidate.ref !== "string") continue;
    nodes.push({
      ref: candidate.ref,
      tag: typeof candidate.tag === "string" ? candidate.tag : "element",
      role: typeof candidate.role === "string" ? candidate.role : "",
      ...(typeof candidate.type === "string" ? { type: candidate.type } : {}),
      ...(typeof candidate.name === "string" ? { name: candidate.name } : {}),
      ...(candidate.password === true || candidate.type === "password" ? { password: true } : {}),
    });
  }
  return {
    title: typeof value.title === "string" ? value.title : "",
    url: typeof value.url === "string" ? value.url : "",
    nodes,
    truncated: value.truncated === true,
    passwordField: value.passwordField === true,
  };
}

function normalizeRequest(message: unknown): BrowserAgentRequest | null {
  if (!message || typeof message !== "object") return null;
  const candidate = message as Record<string, unknown>;
  if (candidate.type !== undefined && candidate.type !== "pi-desktop:browser-agent-request") return null;
  if (typeof candidate.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(candidate.requestId)) return null;
  if (typeof candidate.sessionId !== "string" || !candidate.sessionId.trim() || candidate.sessionId.length > 512) return null;
  if (typeof candidate.action !== "string" || !ACTIONS.has(candidate.action)) return null;
  const request: BrowserAgentRequest = { requestId: candidate.requestId, sessionId: candidate.sessionId.trim(), action: candidate.action };
  const tabId = limited(candidate.tabId, 128);
  const url = limited(candidate.url, 16_384);
  const selector = limited(candidate.selector, 2_000);
  const ref = safeRef(typeof candidate.ref === "string" ? candidate.ref : undefined);
  const text = typeof candidate.text === "string" ? candidate.text : undefined;
  if (text !== undefined && text.length > 100_000) throw new Error("Browser argument is too long.");
  const key = limited(candidate.key, 64);
  if (tabId) request.tabId = tabId;
  if (url) request.url = url;
  if (selector) request.selector = selector;
  if (ref) request.ref = ref;
  if (text !== undefined) request.text = text;
  if (key) request.key = key;
  if (candidate.submit === true) request.submit = true;
  if (typeof candidate.deltaX === "number" && Number.isFinite(candidate.deltaX)) request.deltaX = candidate.deltaX;
  if (typeof candidate.deltaY === "number" && Number.isFinite(candidate.deltaY)) request.deltaY = candidate.deltaY;
  if (typeof candidate.x === "number" && Number.isFinite(candidate.x)) request.x = candidate.x;
  if (typeof candidate.y === "number" && Number.isFinite(candidate.y)) request.y = candidate.y;
  if (typeof candidate.tabIndex === "number" && Number.isFinite(candidate.tabIndex)) request.tabIndex = candidate.tabIndex;
  if (candidate.fullPage === true) request.fullPage = true;
  return request;
}

export function createBrowserAgentControl(host: BrowserAgentHost, options?: BrowserAgentControlOptions): BrowserAgentControl {
  return new BrowserAgentControl(host, options);
}
