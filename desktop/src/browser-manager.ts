import { mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { hasFullToolAccess } from "./tool-permission.js";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  session,
  safeStorage,
  shell,
  WebContentsView,
  type IpcMainInvokeEvent,
  type DownloadItem,
  type Event,
  type Rectangle,
  type Session,
  type WebContents,
  type BrowserWindowConstructorOptions,
  type MenuItemConstructorOptions,
} from "electron";
import { BrowserCookieStore } from "./browser-cookie-store.js";
import type { Logger } from "./logger.js";
import {
  NAVIGATION_TIMEOUT_MS,
  RENDERER_CRASHED_ERROR,
  formatNavigationToken,
  isNonFatalNavigationError,
  rejectAgentCreateAtCapacity,
} from "./browser-agent-logic.js";

export const BROWSER_STATE_CHANNEL = "pi:browser-state";
export const BROWSER_DOWNLOAD_CHANNEL = "pi:browser-download";
export const BROWSER_GET_STATE_CHANNEL = "pi:browser-get-state";
export const BROWSER_ACTION_CHANNEL = "pi:browser-action";
export const BROWSER_VIEWPORT_CHANNEL = "pi:browser-viewport";
export const BROWSER_IMPORT_CHROME_BOOKMARKS_CHANNEL = "pi:browser-import-chrome-bookmarks";
export const BROWSER_BOOKMARK_MENU_CHANNEL = "pi:browser-bookmark-menu";
export const BROWSER_AGENT_ACTIVITY_CHANNEL = "pi:browser-agent-activity";
export const BROWSER_AGENT_BACKEND_CHANNEL = "pi:browser-agent-backend";
export const BROWSER_AGENT_BACKEND_GET_CHANNEL = "pi:browser-get-agent-backend";

export const BROWSER_PARTITION = "persist:piora-browser";
const MAX_TABS = 20;
const MANUAL_BROWSER_SESSION_ID = "__piora_browser_manual__";

export interface DesktopBrowserState {
  sessionId: string;
  activeTabId: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  tabs: Array<{ id: string; title: string; url: string }>;
  title: string;
  url: string;
  agentTabId?: string | null;
  agentOperating?: boolean;
  agentPaused?: boolean;
  agentWaiting?: boolean;
  agentWaitReason?: string;
}

export interface ImportedChromeBookmark {
  id: string;
  type: "bookmark";
  title: string;
  url: string;
}

export interface ImportedChromeBookmarkFolder {
  children: ImportedChromeBookmarkNode[];
  id: string;
  title: string;
  type: "folder";
}

export type ImportedChromeBookmarkNode = ImportedChromeBookmark | ImportedChromeBookmarkFolder;

export interface ImportedChromeBookmarkProfile {
  children: ImportedChromeBookmarkNode[];
  id: string;
  title: string;
}

export interface ChromeBookmarkImportResult {
  bookmarkCount: number;
  profiles: ImportedChromeBookmarkProfile[];
}

export interface DesktopBrowserAction {
  action: "back" | "close_tab" | "forward" | "navigate" | "new_tab" | "reload" | "set_session" | "switch_tab" | "configure_login" | "pause_agent" | "resume_agent" | "show_agent_tab";
  sessionId?: string;
  tabId?: string;
  url?: string;
}

interface BrowserAgentBinding {
  heldTabs(): Array<{ id: string; bounds: { x: number; y: number; width: number; height: number } }>;
  afterVisibilityChange(): void;
  failAll(message: string): void;
  idleAll(): Promise<unknown> | void;
  destroy(): void;
  cancel(requestId: string): void;
  handleRequest(message: unknown): Promise<unknown>;
  pauseSession(sessionId: string): void;
  resumeSession(sessionId: string): void;
  agentTabId(sessionId: string): string | null;
  status(sessionId: string): { tabId: string | null; operating: boolean; paused: boolean; waiting: boolean; reason?: string };
  noteUsed(tabId: string): void;
}

export interface DesktopBrowserDownload {
  filename: string;
  path: string;
  percent: number;
  state: "cancelled" | "completed" | "interrupted" | "progressing";
}

type BrowserTab = {
  initialLoad?: Promise<void>;
  authHost?: string;
  attached: boolean;
  discarding?: boolean;
  id: string;
  loading: boolean;
  navigationEpoch?: number;
  savedTitle?: string;
  savedUrl?: string;
  sessionId: string;
  title: string;
  unloaded?: boolean;
  view: WebContentsView;
  navigationWait?: {
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
};

type ChromeBookmarkNode = {
  children?: ChromeBookmarkNode[];
  id?: string;
  name?: string;
  type?: string;
  url?: string;
};

function browserUrl(contentsUrl: string): string {
  return contentsUrl || "about:blank";
}

function isBrowserUrl(rawUrl: string): boolean {
  if (rawUrl === "about:blank") return true;
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function bookmarkMenuTemplate(value: unknown, select: (url: string) => void, depth = 0): MenuItemConstructorOptions[] {
  if (!Array.isArray(value) || value.length > 50_000 || depth > 100) throw new Error("Invalid bookmark menu");
  if (!value.length) return [{ label: "—", enabled: false }];
  return value.map((node) => {
    if (!node || typeof node.title !== "string") throw new Error("Invalid bookmark");
    const label = (node.title || node.url || "—").slice(0, 200).replace(/&/g, "&&");
    if (node.type === "folder") return { label, submenu: bookmarkMenuTemplate(node.children, select, depth + 1) };
    if (node.type !== "bookmark" || typeof node.url !== "string" || !isBrowserUrl(node.url)) throw new Error("Invalid bookmark URL");
    return { label, click: () => select(node.url) };
  });
}

function normalizeAddress(value: string): string {
  const input = value.trim();
  if (!input || input === "about:blank") return "about:blank";
  if (/^https?:\/\//i.test(input)) return input;
  if (/^[\w.-]+(?::\d+)?(?:[/?#].*)?$/u.test(input) && (input.includes(".") || input.startsWith("localhost"))) {
    return `https://${input}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}

function normalizeBrowserSessionId(value: unknown): string {
  if (typeof value !== "string") return MANUAL_BROWSER_SESSION_ID;
  const sessionId = value.trim();
  return sessionId && sessionId.length <= 512 ? sessionId : MANUAL_BROWSER_SESSION_ID;
}

function validBounds(value: unknown, window: BrowserWindow): Rectangle | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<Rectangle>;
  if (![candidate.x, candidate.y, candidate.width, candidate.height].every(Number.isFinite)) return null;
  if (candidate.width! <= 0 || candidate.height! <= 0) return null;
  const content = window.getContentBounds();
  const x = Math.max(0, Math.round(candidate.x!));
  const y = Math.max(0, Math.round(candidate.y!));
  const width = Math.max(1, Math.min(Math.round(candidate.width!), content.width - x));
  const height = Math.max(1, Math.min(Math.round(candidate.height!), content.height - y));
  if (x >= content.width || y >= content.height) return null;
  return { x, y, width, height };
}

function chromeUserDataDirectory(): string | null {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    return localAppData ? join(localAppData, "Google", "Chrome", "User Data") : null;
  }
  if (process.platform === "darwin") {
    return join(app.getPath("home"), "Library", "Application Support", "Google", "Chrome");
  }
  return join(app.getPath("home"), ".config", "google-chrome");
}

function readChromeBookmarks(): ChromeBookmarkImportResult {
  const userData = chromeUserDataDirectory();
  if (!userData) return { bookmarkCount: 0, profiles: [] };

  let profileDirectories: string[];
  try {
    profileDirectories = readdirSync(userData, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && (entry.name === "Default" || /^Profile \d+$/u.test(entry.name)))
      .map((entry) => entry.name);
  } catch {
    return { bookmarkCount: 0, profiles: [] };
  }

  const profiles: ImportedChromeBookmarkProfile[] = [];
  let bookmarkCount = 0;

  const convertNode = (node: ChromeBookmarkNode, fallbackId: string): ImportedChromeBookmarkNode | null => {
    const id = `${fallbackId}:${node.id?.trim() || "node"}`;
    const title = node.name?.trim() || (typeof node.url === "string" ? node.url : "Untitled");
    if (node.type === "url" && typeof node.url === "string" && node.url.trim()) {
      bookmarkCount += 1;
      return { id, type: "bookmark", title, url: node.url.trim() };
    }
    if (!Array.isArray(node.children)) return null;
    return {
      children: node.children.flatMap((child, index) => {
        const converted = convertNode(child, `${id}:${index}`);
        return converted ? [converted] : [];
      }),
      id,
      title,
      type: "folder",
    };
  };

  for (const profile of profileDirectories) {
    try {
      const parsed = JSON.parse(readFileSync(join(userData, profile, "Bookmarks"), "utf8")) as {
        roots?: Record<string, ChromeBookmarkNode>;
      };
      const bookmarkBar = parsed.roots?.bookmark_bar;
      if (!Array.isArray(bookmarkBar?.children)) continue;
      const children = bookmarkBar.children.flatMap((child, index) => {
        const converted = convertNode(child, `${profile}:bookmark_bar:${index}`);
        return converted ? [converted] : [];
      });
      profiles.push({ children, id: profile, title: profile });
    } catch {
      // A missing, locked, or malformed profile does not block other profiles.
    }
  }
  return { bookmarkCount, profiles };
}

export class DesktopBrowserManager {
  private readonly tabs: BrowserTab[] = [];
  private readonly activeTabIds = new Map<string, string>();
  private displayedSessionId = MANUAL_BROWSER_SESSION_ID;
  private bounds: Rectangle | null = null;
  private requestedVisible = false;
  private nextTabId = 1;
  private readonly browserSession: Session;
  private readonly cookieStore: BrowserCookieStore;
  private readonly storageReady: Promise<void>;
  private destroyed = false;
  private agentControl: BrowserAgentBinding | null = null;
  private reportedAgentBackend: "desktop" | "playwright" | null = null;
  private storageFlushTimer: NodeJS.Timeout | undefined;
  private storageFlushChain: Promise<void> = Promise.resolve();
  private readonly handleCookieChanged = (): void => this.scheduleStorageFlush();
  private readonly handleDownload = (_event: Event, item: DownloadItem, contents: WebContents): void => {
    if (!this.tabs.some((tab) => tab.view.webContents === contents)) return;
    const send = (state: DesktopBrowserDownload["state"]): void => {
      const total = item.getTotalBytes();
      const percent = total > 0 ? Math.round((item.getReceivedBytes() / total) * 100) : 0;
      this.sendDownload({
        filename: item.getFilename(),
        path: item.getSavePath(),
        percent: Math.max(0, Math.min(100, percent)),
        state,
      });
    };
    send("progressing");
    item.on("updated", (_downloadEvent, state) => send(state));
    item.once("done", (_downloadEvent, state) => send(state));
  };

  constructor(
    private readonly window: BrowserWindow,
    private readonly log: Logger,
    private readonly isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
    private readonly startup: { agentDirectory?: () => string | undefined } = {},
  ) {
    this.browserSession = session.fromPartition(BROWSER_PARTITION, { cache: true });
    this.cookieStore = new BrowserCookieStore(join(app.getPath("userData"), "browser-session-cookies.enc"), this.browserSession.cookies, safeStorage);
    this.storageReady = this.cookieStore.restore().catch(() => this.log.warn("Unable to restore browser session cookies"));
    this.configureSession();
    this.createTab("about:blank", false, MANUAL_BROWSER_SESSION_ID);
    this.registerIpc();
    this.window.on("hide", () => this.updateVisibility(false));
    this.window.on("show", () => this.updateVisibility());
    this.window.on("minimize", () => this.updateVisibility(false));
    this.window.on("restore", () => this.updateVisibility());
    this.window.on("closed", () => {
      void this.flushStorage().catch((error) => this.log.warn("Unable to persist browser state while closing", error));
      this.destroy();
    });
  }

  bindAgentControl(control: BrowserAgentBinding): void {
    this.agentControl?.destroy();
    this.agentControl = control;
  }

  handleAgentRequest(message: unknown): Promise<unknown> {
    if (!this.agentControl) return Promise.resolve({ type: "pi-desktop:browser-agent-response", requestId: "", ok: false, error: "Desktop browser bridge unavailable." });
    return this.agentControl.handleRequest(message);
  }

  cancelAgentRequest(requestId: string): void {
    this.agentControl?.cancel(requestId);
  }

  failAgentRequests(message: string): void {
    this.agentControl?.failAll(message);
    void this.agentControl?.idleAll();
  }

  setReportedAgentBackend(backend: "desktop" | "playwright"): void {
    this.reportedAgentBackend = backend;
    this.publishAgentBackend();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.agentControl?.failAll("Browser manager was closed");
    void this.agentControl?.idleAll();
    this.agentControl?.destroy();
    this.agentControl = null;
    if (this.storageFlushTimer) clearTimeout(this.storageFlushTimer);
    this.storageFlushTimer = undefined;
    void this.flushStorage().catch((error) => this.log.warn("Unable to persist browser state while closing", error));
    this.browserSession.off("will-download", this.handleDownload);
    this.browserSession.cookies.off("changed", this.handleCookieChanged);
    for (const tab of this.tabs.splice(0)) {
      this.settleNavigation(tab, new Error("Browser tab is closed."));
      // Discarded tabs retain their view record after Electron releases its contents.
      // Capture a live reference before detaching instead of reading the native getter again.
      const contents = this.liveContents(tab);
      if (tab.attached && !this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view);
      tab.attached = false;
      if (contents && !contents.isDestroyed()) contents.close();
    }
    this.removeIpc();
  }

  flushStorage(): Promise<void> {
    this.browserSession.flushStorageData();
    this.storageFlushChain = this.storageFlushChain
      .catch(() => undefined)
      .then(async () => {
        await this.storageReady;
        await this.browserSession.cookies.flushStore();
        await this.cookieStore.save();
      });
    return this.storageFlushChain;
  }

  private scheduleStorageFlush(): void {
    if (this.destroyed) return;
    if (this.storageFlushTimer) return;
    this.storageFlushTimer = setTimeout(() => {
      this.storageFlushTimer = undefined;
      void this.flushStorage().catch((error) => this.log.warn("Unable to persist browser state", error));
    }, 600);
    this.storageFlushTimer.unref?.();
  }

  private configureSession(): void {
    this.browserSession.allowNTLMCredentialsForDomains(this.readLoginHosts().join(","));
    try {
      this.browserSession.setDownloadPath(app.getPath("downloads"));
    } catch (error) {
      // Headless Windows profiles (including hosted release runners) may not
      // expose a shell Downloads folder. Browser setup is optional startup
      // hardening, so fall back to an app-owned directory instead of making
      // the entire desktop application fail before its renderer can mount.
      try {
        const fallbackDirectory = join(app.getPath("userData"), "Downloads");
        mkdirSync(fallbackDirectory, { recursive: true });
        this.browserSession.setDownloadPath(fallbackDirectory);
        this.log.warn("System Downloads folder is unavailable; using Piora Downloads", error);
      } catch (fallbackError) {
        this.log.warn("Unable to configure the browser download directory", fallbackError);
      }
    }
    this.browserSession.setPermissionCheckHandler(() => false);
    this.browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    this.browserSession.on("will-download", this.handleDownload);
    this.browserSession.cookies.on("changed", this.handleCookieChanged);
  }

  private registerIpc(): void {
    this.removeIpc();
    ipcMain.handle(BROWSER_GET_STATE_CHANNEL, (event): DesktopBrowserState | null => {
      if (!this.isTrustedSender(event)) return null;
      return this.getState();
    });
    ipcMain.handle(BROWSER_VIEWPORT_CHANNEL, (event, rawBounds: unknown, visible: unknown): boolean => {
      if (!this.isTrustedSender(event)) return false;
      // Windows reports a 0x0 content area while minimized. A late renderer
      // resize must not erase the last usable viewport before restore.
      if (!this.window.isMinimized()) this.bounds = validBounds(rawBounds, this.window);
      this.requestedVisible = visible === true;
      this.updateVisibility();
      return Boolean(this.bounds);
    });
    ipcMain.handle(BROWSER_ACTION_CHANNEL, async (event, input: unknown): Promise<DesktopBrowserState | null> => {
      if (!this.isTrustedSender(event)) return null;
      await this.performAction(input);
      return this.getState();
    });
    ipcMain.handle(BROWSER_IMPORT_CHROME_BOOKMARKS_CHANNEL, (event): ChromeBookmarkImportResult | null => {
      if (!this.isTrustedSender(event)) return null;
      return readChromeBookmarks();
    });
    ipcMain.handle(BROWSER_AGENT_BACKEND_GET_CHANNEL, (event): "desktop" | "playwright" => {
      if (!this.isTrustedSender(event)) return "playwright";
      return this.resolvedAgentBackend();
    });
    ipcMain.handle(BROWSER_BOOKMARK_MENU_CHANNEL, (event, nodes: unknown, position: unknown): Promise<string | null> | null => {
      if (!this.isTrustedSender(event)) return null;
      const point = position as { x?: number; y?: number } | null;
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("Invalid bookmark menu position");
      const bounds = this.window.getContentBounds();
      const zoom = this.window.webContents.getZoomFactor();
      let selected: string | null = null;
      const menu = Menu.buildFromTemplate(bookmarkMenuTemplate(nodes, (url) => { selected = url; }));
      return new Promise((resolve) => menu.popup({
        window: this.window,
        x: Math.max(0, Math.min(bounds.width - 1, Math.round(point.x! * zoom))),
        y: Math.max(0, Math.min(bounds.height - 1, Math.round(point.y! * zoom))),
        callback: () => resolve(selected),
      }));
    });
  }

  private removeIpc(): void {
    ipcMain.removeHandler(BROWSER_GET_STATE_CHANNEL);
    ipcMain.removeHandler(BROWSER_VIEWPORT_CHANNEL);
    ipcMain.removeHandler(BROWSER_ACTION_CHANNEL);
    ipcMain.removeHandler(BROWSER_IMPORT_CHROME_BOOKMARKS_CHANNEL);
    ipcMain.removeHandler(BROWSER_BOOKMARK_MENU_CHANNEL);
    ipcMain.removeHandler(BROWSER_AGENT_BACKEND_GET_CHANNEL);
  }

  private createTab(rawUrl: string, activate = true, sessionId = this.displayedSessionId, popupOptions?: BrowserWindowConstructorOptions & { webContents?: WebContents }, deferLoad = false): BrowserTab {
    if (this.tabs.length >= MAX_TABS) {
      const existing = this.activeTab(sessionId);
      if (existing) return existing;
      throw new Error(`The browser tab limit of ${MAX_TABS} has been reached.`);
    }
    const id = `tab-${this.nextTabId++}`;
    const view = this.createBrowserView(popupOptions);
    const tab: BrowserTab = { attached: false, id, loading: false, sessionId, title: "", view };
    this.tabs.push(tab);
    this.installTabEvents(tab);
    if (activate || !this.activeTabIds.has(sessionId)) this.activeTabIds.set(sessionId, id);
    const targetUrl = normalizeAddress(rawUrl);
    // Agent opens defer the load so the request can wait for did-stop-loading
    // instead of returning while the tab is still about:blank.
    if (!deferLoad && targetUrl !== "about:blank") {
      void this.storageReady.then(() => view.webContents.isDestroyed() ? undefined : view.webContents.loadURL(targetUrl)).catch((error) => {
        this.log.warn("Browser tab failed to load", error);
      });
    }
    this.updateVisibility();
    this.sendState();
    return tab;
  }

  private armNavigation(tab: BrowserTab): Promise<void> {
    this.settleNavigation(tab, new Error("Navigation was replaced."));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settleNavigation(tab, new Error("Navigation timed out after 30 seconds."));
      }, NAVIGATION_TIMEOUT_MS);
      timer.unref?.();
      tab.navigationWait = { resolve, reject, timer };
    });
  }

  private noteMainFrameNavigation(tab: BrowserTab): void {
    tab.navigationEpoch = (tab.navigationEpoch ?? 0) + 1;
  }

  private settleNavigation(tab: BrowserTab, error?: Error): void {
    const wait = tab.navigationWait;
    if (!wait) return;
    delete tab.navigationWait;
    clearTimeout(wait.timer);
    if (error) wait.reject(error);
    else wait.resolve();
  }

  private async loadTabUrl(tab: BrowserTab, url: string): Promise<void> {
    await this.storageReady;
    const contents = tab.view.webContents;
    if (contents.isDestroyed()) throw new Error("Browser tab is closed.");
    const waited = this.armNavigation(tab);
    const loading = (async () => {
      try {
        await contents.loadURL(url);
      } catch (error) {
        if (!isNonFatalNavigationError(error)) {
          this.settleNavigation(tab, error instanceof Error ? error : new Error(String(error)));
        }
      }
    })();
    // Navigation events and the timeout can reject before loadURL settles.
    // Observe both promises immediately so that failure cannot terminate Node.
    await Promise.all([waited, loading]);
  }

  private async waitForHistoryNavigation(tab: BrowserTab, start: () => void): Promise<void> {
    const waited = this.armNavigation(tab);
    start();
    await waited;
  }

  private installTabEvents(tab: BrowserTab): void {
    const contents = tab.view.webContents;
    contents.on("login", (_event, details, authInfo) => {
      if (authInfo.isProxy || !/^(ntlm|negotiate)$/i.test(authInfo.scheme)) return;
      try {
        const url = new URL(details.url);
        if (url.protocol === "https:" && url.hostname === authInfo.host) tab.authHost = url.hostname;
      } catch { /* Ignore malformed authentication challenges. */ }
      this.log.info("Browser integrated authentication requires site configuration", { host: tab.authHost, scheme: authInfo.scheme });
    });
    contents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame) this.noteMainFrameNavigation(tab);
      if (isMainFrame && !isInPlace) delete tab.authHost;
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (isBrowserUrl(url) && this.tabs.length < MAX_TABS) {
        return {
          action: "allow",
          createWindow: (options) => this.createTab((options as { webContents?: WebContents }).webContents ? "about:blank" : url, true, tab.sessionId, options).view.webContents,
        };
      }
      if (!isBrowserUrl(url)) void shell.openExternal(url).catch((error) => this.log.warn("Unable to open browser protocol", error));
      return { action: "deny" };
    });
    contents.on("destroyed", () => {
      if (tab.view.webContents === contents) this.settleNavigation(tab, new Error("Browser tab is closed."));
      if (this.destroyed || tab.view.webContents !== contents || tab.discarding) return;
      if (!this.tabs.includes(tab)) return;
      if (tab.attached && !this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view);
      this.tabs.splice(this.tabs.indexOf(tab), 1);
      this.updateVisibility();
      this.sendState();
    });
    contents.on("will-navigate", (event, url) => {
      if (!isBrowserUrl(url)) {
        event.preventDefault();
        void shell.openExternal(url).catch((error) => this.log.warn("Unable to open browser protocol", error));
      }
    });
    contents.on("page-title-updated", (_event, title) => {
      tab.title = title;
      this.sendState();
    });
    contents.on("did-start-loading", () => {
      tab.loading = true;
      this.sendState();
    });
    contents.on("did-stop-loading", () => {
      tab.loading = false;
      this.settleNavigation(tab);
      this.scheduleStorageFlush();
      this.sendState();
    });
    contents.on("did-navigate", () => {
      this.noteMainFrameNavigation(tab);
      this.scheduleStorageFlush();
      this.updateVisibility();
      this.sendState();
    });
    contents.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
      if (isMainFrame === true) this.noteMainFrameNavigation(tab);
      this.scheduleStorageFlush();
      this.sendState();
    });
    contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (isMainFrame && errorCode !== -3) {
        this.log.warn("Browser navigation failed", { errorCode, errorDescription, validatedUrl });
        tab.loading = false;
        const failure = new Error(`Page failed to load (${errorCode}): ${errorDescription}`);
        (failure as Error & { errorCode: number }).errorCode = errorCode;
        this.settleNavigation(tab, failure);
        this.sendState();
        return;
      }
      tab.loading = false;
      this.sendState();
    });
    contents.on("context-menu", (_event, params) => {
      const template: Electron.MenuItemConstructorOptions[] = [];
      if (params.linkURL && isBrowserUrl(params.linkURL)) {
        template.push({ label: "在新标签页中打开链接", click: () => this.createTab(params.linkURL, true, tab.sessionId) });
        template.push({ type: "separator" });
      }
      if (params.selectionText) template.push({ role: "copy", label: "复制" });
      if (params.isEditable) {
        template.push({ role: "cut", label: "剪切" }, { role: "copy", label: "复制" }, { role: "paste", label: "粘贴" });
      }
      if (template.length) template.push({ type: "separator" });
      template.push(
        { label: "后退", enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() },
        { label: "重新加载", click: () => contents.reload() },
      );
      Menu.buildFromTemplate(template).popup({ window: this.window });
    });
    contents.on("render-process-gone", (_event, details) => {
      this.log.warn("Browser tab renderer exited", details);
      tab.loading = false;
      this.settleNavigation(tab, new Error(RENDERER_CRASHED_ERROR));
      this.sendState();
    });
  }

  private activeTab(sessionId = this.displayedSessionId): BrowserTab | undefined {
    const activeTabId = this.activeTabIds.get(sessionId);
    return this.tabs.find((tab) => tab.sessionId === sessionId && tab.id === activeTabId)
      ?? this.tabs.find((tab) => tab.sessionId === sessionId);
  }

  private ensureSession(sessionId: string): BrowserTab {
    return this.activeTab(sessionId) ?? this.createTab("about:blank", false, sessionId);
  }

  private getState(sessionId = this.displayedSessionId): DesktopBrowserState {
    const active = this.ensureSession(sessionId);
    const contents = this.liveContents(active);
    const url = this.tabUrl(active);
    const agent = this.agentControl?.status(sessionId);
    return {
      sessionId,
      activeTabId: active.id,
      canGoBack: contents ? contents.navigationHistory.canGoBack() : false,
      canGoForward: contents ? contents.navigationHistory.canGoForward() : false,
      loading: active.loading,
      tabs: this.tabs.filter((tab) => tab.sessionId === sessionId).map((tab) => ({
        id: tab.id,
        title: this.tabTitle(tab),
        url: this.tabUrl(tab),
      })),
      title: this.tabTitle(active),
      url,
      ...(agent ? {
        agentTabId: agent.tabId,
        agentOperating: agent.operating,
        agentPaused: agent.paused,
        agentWaiting: agent.waiting,
        ...(agent.waiting && agent.reason ? { agentWaitReason: agent.reason } : {}),
      } : {}),
    };
  }

  private sendState(): void {
    if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) return;
    this.window.webContents.send(BROWSER_STATE_CHANNEL, this.getState());
  }

  private sendDownload(download: DesktopBrowserDownload): void {
    if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) return;
    this.window.webContents.send(BROWSER_DOWNLOAD_CHANNEL, download);
  }

  private updateVisibility(force?: boolean): void {
    if (this.destroyed || this.window.isDestroyed()) return;
    const active = this.activeTab(this.displayedSessionId);
    const shouldShow = force ?? Boolean(
      this.requestedVisible
      && this.bounds
      && active
      && !active.unloaded
      && this.tabUrl(active) !== "about:blank"
      && this.window.isVisible()
      && !this.window.isMinimized(),
    );
    const held = new Map((this.agentControl?.heldTabs() ?? []).map((entry) => [entry.id, entry.bounds]));
    let attachmentChanged = false;
    for (const tab of this.tabs) {
      if (tab.unloaded) {
        if (tab.attached && !this.window.isDestroyed()) {
          this.window.contentView.removeChildView(tab.view);
          tab.attached = false;
          attachmentChanged = true;
        }
        continue;
      }
      const visible = shouldShow && tab === active && tab.sessionId === this.displayedSessionId;
      const hold = !visible ? held.get(tab.id) : undefined;
      if (visible && this.bounds) {
        tab.view.setBounds(this.bounds);
        if (!tab.attached) {
          this.window.contentView.addChildView(tab.view);
          tab.attached = true;
          attachmentChanged = true;
        }
      } else if (hold) {
        // A hidden agent tab stays attached offscreen. Detached or 0x0 views
        // stop producing frames, so CDP input and capturePage would time out.
        tab.view.setBounds(hold);
        if (!tab.attached) {
          this.window.contentView.addChildView(tab.view);
          tab.attached = true;
          attachmentChanged = true;
        }
      }
      tab.view.setVisible(visible || Boolean(hold));
      if (!visible && !hold && tab.attached) {
        // Native Chromium surfaces (including cross-origin login frames) are
        // outside React/CSS clipping. Remove the entire view from the host,
        // but keep its WebContents alive so sign-in and navigation survive.
        this.window.contentView.removeChildView(tab.view);
        tab.attached = false;
        attachmentChanged = true;
      }
    }
    if (attachmentChanged) {
      this.log.info("Browser display attachment changed", {
        visible: Boolean(shouldShow),
        attachedViews: this.tabs.filter((tab) => tab.attached).length,
      });
    }
    this.agentControl?.afterVisibilityChange();
  }

  private async performAction(value: unknown): Promise<void> {
    if (!value || typeof value !== "object") return;
    const input = value as DesktopBrowserAction;
    if (input.action === "set_session") {
      this.displayedSessionId = normalizeBrowserSessionId(input.sessionId);
      this.ensureSession(this.displayedSessionId);
      this.updateVisibility();
      this.sendState();
      return;
    }
    if (input.action === "pause_agent") {
      this.agentControl?.pauseSession(this.displayedSessionId);
      this.sendState();
      return;
    }
    if (input.action === "resume_agent") {
      this.agentControl?.resumeSession(this.displayedSessionId);
      this.updateVisibility();
      this.sendState();
      return;
    }
    if (input.action === "show_agent_tab") {
      const agentTabId = this.agentControl?.agentTabId(this.displayedSessionId);
      if (agentTabId && this.tabs.some((tab) => tab.id === agentTabId && tab.sessionId === this.displayedSessionId && !tab.unloaded)) {
        this.activeTabIds.set(this.displayedSessionId, agentTabId);
        this.agentControl?.noteUsed(agentTabId);
      }
      this.updateVisibility();
      this.sendState();
      return;
    }
    const active = this.activeTab(this.displayedSessionId);
    if (!active || active.unloaded) {
      if (input.action === "new_tab") this.noteTabUsed(this.createTab(typeof input.url === "string" ? input.url : "about:blank", true, this.displayedSessionId));
      return;
    }
    if (input.action === "configure_login") { this.showLoginMenu(active); return; }
    if (input.action === "navigate" && typeof input.url === "string") {
      await this.storageReady;
      await active.view.webContents.loadURL(normalizeAddress(input.url));
      this.noteTabUsed(active);
    } else if (input.action === "back" && active.view.webContents.navigationHistory.canGoBack()) {
      active.view.webContents.navigationHistory.goBack();
      this.noteTabUsed(active);
    } else if (input.action === "forward" && active.view.webContents.navigationHistory.canGoForward()) {
      active.view.webContents.navigationHistory.goForward();
      this.noteTabUsed(active);
    } else if (input.action === "reload") {
      active.view.webContents.reload();
      this.noteTabUsed(active);
    } else if (input.action === "new_tab") {
      this.noteTabUsed(this.createTab(typeof input.url === "string" ? input.url : "about:blank", true, this.displayedSessionId));
    } else if (input.action === "switch_tab" && typeof input.tabId === "string" && this.tabs.some((tab) => tab.id === input.tabId && tab.sessionId === this.displayedSessionId)) {
      this.activeTabIds.set(this.displayedSessionId, input.tabId);
      this.noteTabUsed(this.tabs.find((tab) => tab.id === input.tabId));
      this.updateVisibility();
      this.sendState();
    } else if (input.action === "close_tab" && typeof input.tabId === "string") {
      this.closeTab(input.tabId, this.displayedSessionId);
    }
  }

  private readLoginHosts(): string[] {
    try {
      const value: unknown = JSON.parse(readFileSync(join(app.getPath("userData"), "browser-login-hosts.json"), "utf8"));
      return Array.isArray(value) ? [...new Set(value.filter((host): host is string => typeof host === "string" && /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)).map((host) => host.toLowerCase()))].slice(0, 100) : [];
    } catch { return []; }
  }

  private showLoginMenu(tab: BrowserTab): void {
    let host = tab.authHost;
    try { const url = new URL(tab.view.webContents.getURL()); if (!host && url.protocol === "https:") host = url.hostname; } catch { /* Blank page. */ }
    const hosts = this.readLoginHosts();
    const targetHost = host;
    const checked = Boolean(targetHost && hosts.includes(targetHost));
    const menu = Menu.buildFromTemplate([
      { label: targetHost ?? "请先打开需要登录的网站", enabled: false },
      { label: "允许此站点使用 Windows 免密登录", type: "checkbox", checked, enabled: process.platform === "win32" && Boolean(targetHost), click: () => {
        if (!targetHost || tab.view.webContents.isDestroyed()) return;
        const latest = this.readLoginHosts();
        const next = checked ? latest.filter((value) => value !== targetHost) : [...new Set([...latest, targetHost])];
        try {
          const root = app.getPath("userData"); mkdirSync(root, { recursive: true });
          const file = join(root, "browser-login-hosts.json");
          writeFileSync(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 }); renameSync(`${file}.tmp`, file);
          this.browserSession.allowNTLMCredentialsForDomains(next.join(","));
          tab.view.webContents.reload();
        } catch (error) { this.log.warn("Unable to configure browser integrated authentication", error); }
      } },
      { type: "separator" },
      { label: "使用系统账户认证，仅对选中的域名生效", enabled: false },
      { label: "Chrome 的登录状态和企业插件不会自动共享", enabled: false },
    ]);
    menu.popup({ window: this.window });
  }

  private closeTab(tabId: string, sessionId: string, force = false): void {
    const sessionTabs = this.tabs.filter((tab) => tab.sessionId === sessionId);
    const index = this.tabs.findIndex((tab) => tab.id === tabId && tab.sessionId === sessionId);
    if (index < 0) return;
    if (sessionTabs.length === 1 && !force) {
      const tab = sessionTabs[0]!;
      if (tab.unloaded || tab.view.webContents.isDestroyed()) return;
      tab.title = "";
      tab.savedUrl = "about:blank";
      tab.view.webContents.navigationHistory.clear();
      void tab.view.webContents.loadURL("about:blank");
      return;
    }
    const [tab] = this.tabs.splice(index, 1);
    if (!tab) return;
    if (tab.attached && !this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view);
    tab.attached = false;
    if (!tab.unloaded && !tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    if (this.activeTabIds.get(sessionId) === tabId) {
      const remaining = this.tabs.filter((candidate) => candidate.sessionId === sessionId);
      const next = remaining[Math.min(Math.max(sessionTabs.indexOf(tab), 0), Math.max(0, remaining.length - 1))];
      if (next) this.activeTabIds.set(sessionId, next.id);
      else this.activeTabIds.delete(sessionId);
    }
    this.updateVisibility();
    this.sendState();
  }

  private createBrowserView(popupOptions?: BrowserWindowConstructorOptions & { webContents?: WebContents }): WebContentsView {
    const view = new WebContentsView({
      ...(popupOptions?.webContents ? { webContents: popupOptions.webContents } : {}),
      webPreferences: {
        ...popupOptions?.webPreferences,
        partition: BROWSER_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        navigateOnDragDrop: false,
        safeDialogs: true,
        devTools: !app.isPackaged || process.env.PI_DESKTOP_DEVTOOLS === "1",
      },
    });
    view.setBackgroundColor("#ffffff");
    view.setVisible(false);
    return view;
  }

  private liveContents(tab: BrowserTab): WebContents | null {
    if (tab.unloaded) return null;
    try {
      const contents = tab.view.webContents;
      return contents && !contents.isDestroyed() ? contents : null;
    } catch {
      return null;
    }
  }

  private tabUrl(tab: BrowserTab): string {
    const contents = this.liveContents(tab);
    return contents ? browserUrl(contents.getURL()) : (tab.savedUrl || "about:blank");
  }

  private tabTitle(tab: BrowserTab): string {
    return this.liveContents(tab) ? tab.title : (tab.savedTitle || tab.title || "");
  }

  private noteTabUsed(tab: BrowserTab | undefined): void {
    if (tab) this.agentControl?.noteUsed(tab.id);
  }

  private findTab(tabId: string): BrowserTab | undefined {
    return this.tabs.find((tab) => tab.id === tabId);
  }

  private agentBrowserMode(): "builtin" | "background" {
    const directory = this.startup.agentDirectory?.();
    if (!directory) return "builtin";
    try {
      const parsed = JSON.parse(readFileSync(join(directory, "piora", "browser.json"), "utf8")) as { mode?: unknown };
      return parsed.mode === "background" ? "background" : "builtin";
    } catch {
      return "builtin";
    }
  }

  private resolvedAgentBackend(): "desktop" | "playwright" {
    if (this.agentBrowserMode() === "background") return "playwright";
    if (this.reportedAgentBackend === "playwright") return "playwright";
    return "desktop";
  }

  private publishAgentBackend(): void {
    if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) return;
    this.window.webContents.send(BROWSER_AGENT_BACKEND_CHANNEL, this.resolvedAgentBackend());
  }

  private requireLiveTab(tabId: string): BrowserTab {
    const tab = this.findTab(tabId);
    if (!tab || tab.unloaded || tab.view.webContents.isDestroyed()) throw new Error("Browser tab is closed.");
    return tab;
  }

  private async ensureTabReady(tabId: string): Promise<void> {
    const tab = this.requireLiveTab(tabId);
    if (tab.initialLoad) return tab.initialLoad;
    if (tab.view.webContents.getURL()) return;
    // A new WebContentsView has no committed document. Sending CDP emulation
    // commands before its first load can crash the native Electron process.
    const pending = this.loadTabUrl(tab, "about:blank");
    tab.initialLoad = pending;
    try {
      await pending;
    } finally {
      if (tab.initialLoad === pending) delete tab.initialLoad;
    }
  }

  private tabState(tab: BrowserTab) {
    return {
      id: tab.id,
      sessionId: tab.sessionId,
      webContentsId: this.liveContents(tab)?.id ?? -1,
      closed: false,
      url: this.tabUrl(tab),
      title: this.tabTitle(tab),
      unloaded: Boolean(tab.unloaded),
    };
  }

  private discardTab(tabId: string): void {
    const tab = this.findTab(tabId);
    if (!tab || tab.unloaded) return;
    const contents = tab.view.webContents;
    if (!contents.isDestroyed()) {
      tab.savedUrl = browserUrl(contents.getURL());
      tab.savedTitle = tab.title;
    }
    tab.unloaded = true;
    tab.discarding = true;
    if (tab.attached && !this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view);
    tab.attached = false;
    if (!contents.isDestroyed()) contents.close();
  }

  private async restoreTab(tabId: string): Promise<void> {
    const tab = this.findTab(tabId);
    if (!tab || !tab.unloaded) return;
    const url = tab.savedUrl && tab.savedUrl !== "about:blank" ? tab.savedUrl : "about:blank";
    const view = this.createBrowserView();
    tab.view = view;
    tab.unloaded = false;
    tab.discarding = false;
    tab.attached = false;
    tab.loading = url !== "about:blank";
    this.installTabEvents(tab);
    if (url === "about:blank") return;
    await this.loadTabUrl(tab, url);
  }

  private showingTab(tabId: string): boolean {
    if (this.destroyed || this.window.isDestroyed()) return false;
    const active = this.activeTab(this.displayedSessionId);
    if (!active || active.id !== tabId || active.unloaded) return false;
    return Boolean(
      this.requestedVisible
      && this.bounds
      && this.tabUrl(active) !== "about:blank"
      && this.window.isVisible()
      && !this.window.isMinimized(),
    );
  }

  createAgentHost() {
    return {
      mainWebContentsId: this.window.webContents.id,
      now: () => Date.now(),
      platform: process.platform,
      log: this.log,
      listTabs: () => this.tabs.map((tab) => this.tabState(tab)),
      ensureReady: (tabId: string) => this.ensureTabReady(tabId),
      createTab: (sessionId: string, url: string) => {
        rejectAgentCreateAtCapacity(this.tabs.length, MAX_TABS);
        return this.tabState(this.createTab(url, false, sessionId, undefined, true));
      },
      closeTab: (tabId: string) => {
        const tab = this.findTab(tabId);
        if (tab) this.closeTab(tabId, tab.sessionId, true);
      },
      loadURL: (tabId: string, url: string) => this.loadTabUrl(this.requireLiveTab(tabId), url),
      goBack: async (tabId: string) => {
        const tab = this.requireLiveTab(tabId);
        if (!tab.view.webContents.navigationHistory.canGoBack()) return;
        await this.waitForHistoryNavigation(tab, () => tab.view.webContents.navigationHistory.goBack());
      },
      goForward: async (tabId: string) => {
        const tab = this.requireLiveTab(tabId);
        if (!tab.view.webContents.navigationHistory.canGoForward()) return;
        await this.waitForHistoryNavigation(tab, () => tab.view.webContents.navigationHistory.goForward());
      },
      reload: async (tabId: string) => {
        const tab = this.requireLiveTab(tabId);
        await this.waitForHistoryNavigation(tab, () => tab.view.webContents.reload());
      },
      discardTab: (tabId: string) => this.discardTab(tabId),
      restoreTab: (tabId: string) => this.restoreTab(tabId),
      isShowing: (tabId: string) => this.showingTab(tabId),
      panelBounds: () => (this.bounds ? { ...this.bounds } : null),
      setBounds: (tabId: string, bounds: { x: number; y: number; width: number; height: number }) => {
        const tab = this.findTab(tabId);
        if (!tab || tab.unloaded) return;
        tab.view.setBounds(bounds);
      },
      attach: (tabId: string) => {
        const tab = this.findTab(tabId);
        if (!tab || tab.unloaded || this.destroyed || this.window.isDestroyed() || tab.attached) return;
        this.window.contentView.addChildView(tab.view);
        tab.attached = true;
      },
      detach: (tabId: string) => {
        const tab = this.findTab(tabId);
        if (!tab || !tab.attached || this.window.isDestroyed()) return;
        this.window.contentView.removeChildView(tab.view);
        tab.attached = false;
      },
      setBackgroundThrottling: (tabId: string, allowed: boolean) => {
        this.requireLiveTab(tabId).view.webContents.setBackgroundThrottling(allowed);
      },
      capturePage: async (tabId: string, options: { stayHidden: boolean; stayAwake: boolean }) => {
        const image = await this.requireLiveTab(tabId).view.webContents.capturePage(undefined, options);
        const png = image.toPNG();
        return { byteLength: png.length, base64: png.toString("base64") };
      },
      executeIsolated: (tabId: string, worldId: number, code: string) => (
        this.requireLiveTab(tabId).view.webContents.executeJavaScriptInIsolatedWorld(worldId, [{ code }])
      ),
      executeMain: (tabId: string, code: string) => (
        this.requireLiveTab(tabId).view.webContents.executeJavaScript(`globalThis.eval(${JSON.stringify(code)})`)
      ),
      hasFullToolAccess: (sessionId: string) => hasFullToolAccess(this.startup.agentDirectory?.(), sessionId),
      navigationToken: (tabId: string) => {
        const tab = this.findTab(tabId);
        if (!tab) return formatNavigationToken(tabId, 0, "");
        return formatNavigationToken(tab.id, tab.navigationEpoch ?? 0, this.tabUrl(tab));
      },
      activateSessionTab: (sessionId: string, tabId: string) => {
        const tab = this.findTab(tabId);
        if (!tab || tab.sessionId !== sessionId || tab.unloaded) return;
        this.activeTabIds.set(sessionId, tabId);
        this.noteTabUsed(tab);
        this.updateVisibility();
        this.sendState();
      },
      debuggerAttach: (tabId: string, version: string) => {
        this.requireLiveTab(tabId).view.webContents.debugger.attach(version);
      },
      debuggerDetach: (tabId: string) => {
        const contents = this.requireLiveTab(tabId).view.webContents;
        if (contents.debugger.isAttached()) contents.debugger.detach();
      },
      debuggerIsAttached: (tabId: string) => {
        const tab = this.findTab(tabId);
        if (!tab || tab.unloaded || tab.view.webContents.isDestroyed()) return false;
        return tab.view.webContents.debugger.isAttached();
      },
      debuggerSend: (tabId: string, method: string, params?: Record<string, unknown>) => (
        this.requireLiveTab(tabId).view.webContents.debugger.sendCommand(method, params)
      ),
      onTabEvent: (tabId: string, event: "render-process-gone" | "debugger-detach" | "input-event" | "destroyed", handler: (payload?: unknown) => void) => {
        const tab = this.findTab(tabId);
        if (!tab || tab.unloaded) return () => undefined;
        const contents = tab.view.webContents;
        if (event === "render-process-gone") {
          const listener = () => handler();
          contents.on("render-process-gone", listener);
          return () => { if (!contents.isDestroyed()) contents.off("render-process-gone", listener); };
        }
        if (event === "destroyed") {
          const listener = () => handler();
          contents.on("destroyed", listener);
          return () => { if (!contents.isDestroyed()) contents.off("destroyed", listener); };
        }
        if (event === "input-event") {
          const listener = (_ipcEvent: Event, input: Electron.InputEvent) => handler({ type: input.type });
          contents.on("input-event", listener);
          return () => { if (!contents.isDestroyed()) contents.off("input-event", listener); };
        }
        const listener = (_ipcEvent: Event, reason: string) => {
          const closed = tab.unloaded || contents.isDestroyed() || /closed/i.test(reason);
          if (!closed) {
            // DevTools takes the only debugger session. Reattach instead of
            // treating the tab as closed so the agent can continue.
            try {
              if (!contents.isDestroyed() && !contents.debugger.isAttached()) contents.debugger.attach("1.3");
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (!/already attached/i.test(message)) this.log.warn("Browser agent debugger reattach failed", error);
            }
            return;
          }
          handler({ reason });
        };
        contents.debugger.on("detach", listener);
        return () => {
          try { contents.debugger.off("detach", listener); } catch { /* The tab is already gone. */ }
        };
      },
      pushActivity: (activity: { sessionId: string; tabId: string | null; operating: boolean; paused: boolean; waiting?: boolean; reason?: string }) => {
        if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) return;
        this.window.webContents.send(BROWSER_AGENT_ACTIVITY_CHANNEL, activity);
        this.sendState();
      },
    };
  }
}
