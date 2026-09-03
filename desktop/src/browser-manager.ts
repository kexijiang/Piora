import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  session,
  shell,
  WebContentsView,
  type IpcMainInvokeEvent,
  type DownloadItem,
  type Event,
  type Rectangle,
  type Session,
  type WebContents,
} from "electron";
import type { Logger } from "./logger.js";

export const BROWSER_STATE_CHANNEL = "pi:browser-state";
export const BROWSER_DOWNLOAD_CHANNEL = "pi:browser-download";
export const BROWSER_GET_STATE_CHANNEL = "pi:browser-get-state";
export const BROWSER_ACTION_CHANNEL = "pi:browser-action";
export const BROWSER_VIEWPORT_CHANNEL = "pi:browser-viewport";
export const BROWSER_IMPORT_CHROME_BOOKMARKS_CHANNEL = "pi:browser-import-chrome-bookmarks";

const BROWSER_PARTITION = "persist:piora-browser";
const MAX_TABS = 20;
const MANUAL_BROWSER_SESSION_ID = "__piora_browser_manual__";
const MAX_SNAPSHOT_CHARS = 24_000;
const MAX_INTERACTIVE_ELEMENTS = 160;
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["mailto:", "tel:"]);

function allowedExternalProtocolUrl(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    return ALLOWED_EXTERNAL_PROTOCOLS.has(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function browserEvaluateEnabled(): boolean {
  return process.env.PIORA_BROWSER_ALLOW_EVALUATE === "1";
}

export interface DesktopBrowserState {
  sessionId: string;
  activeTabId: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  tabs: Array<{ id: string; title: string; url: string }>;
  title: string;
  url: string;
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
  action: "back" | "close_tab" | "forward" | "navigate" | "new_tab" | "reload" | "set_session" | "switch_tab";
  sessionId?: string;
  tabId?: string;
  url?: string;
}

export interface DesktopBrowserDownload {
  filename: string;
  path: string;
  percent: number;
  state: "cancelled" | "completed" | "interrupted" | "progressing";
}

type BrowserTab = {
  id: string;
  loading: boolean;
  sessionId: string;
  title: string;
  view: WebContentsView;
};

export interface DesktopAgentBrowserResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: "image/png" }
  >;
  details: Record<string, unknown>;
}

function agentTextResult(text: string, details: Record<string, unknown> = {}): DesktopAgentBrowserResult {
  return { content: [{ type: "text", text }], details };
}

function requireAgentUrl(rawUrl: unknown): string {
  if (typeof rawUrl !== "string") throw new Error("A URL is required.");
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The built-in browser accepts only http:// and https:// URLs.");
  }
  return url.href;
}

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
  private destroyed = false;
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
  ) {
    this.browserSession = session.fromPartition(BROWSER_PARTITION, { cache: true });
    this.configureSession();
    this.createTab("about:blank", false, MANUAL_BROWSER_SESSION_ID);
    this.registerIpc();
    this.window.on("hide", () => this.updateVisibility(false));
    this.window.on("show", () => this.updateVisibility());
    this.window.on("closed", () => {
      void this.flushStorage().catch((error) => this.log.warn("Unable to persist browser state while closing", error));
      this.destroy();
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.storageFlushTimer) clearTimeout(this.storageFlushTimer);
    this.storageFlushTimer = undefined;
    void this.flushStorage().catch((error) => this.log.warn("Unable to persist browser state while closing", error));
    this.browserSession.off("will-download", this.handleDownload);
    this.browserSession.cookies.off("changed", this.handleCookieChanged);
    for (const tab of this.tabs.splice(0)) {
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view);
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    this.removeIpc();
  }

  flushStorage(): Promise<void> {
    this.browserSession.flushStorageData();
    this.storageFlushChain = this.storageFlushChain
      .catch(() => undefined)
      .then(() => this.browserSession.cookies.flushStore());
    return this.storageFlushChain;
  }

  private scheduleStorageFlush(): void {
    if (this.destroyed) return;
    if (this.storageFlushTimer) clearTimeout(this.storageFlushTimer);
    this.storageFlushTimer = setTimeout(() => {
      this.storageFlushTimer = undefined;
      void this.flushStorage().catch((error) => this.log.warn("Unable to persist browser state", error));
    }, 600);
    this.storageFlushTimer.unref?.();
  }

  private configureSession(): void {
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
      this.bounds = validBounds(rawBounds, this.window);
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
  }

  private removeIpc(): void {
    ipcMain.removeHandler(BROWSER_GET_STATE_CHANNEL);
    ipcMain.removeHandler(BROWSER_VIEWPORT_CHANNEL);
    ipcMain.removeHandler(BROWSER_ACTION_CHANNEL);
    ipcMain.removeHandler(BROWSER_IMPORT_CHROME_BOOKMARKS_CHANNEL);
  }

  private createTab(rawUrl: string, activate = true, sessionId = this.displayedSessionId): BrowserTab {
    if (this.tabs.length >= MAX_TABS) {
      throw new Error(`The browser tab limit of ${MAX_TABS} has been reached.`);
    }
    const id = `tab-${this.nextTabId++}`;
    const view = new WebContentsView({
      webPreferences: {
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
    this.window.contentView.addChildView(view);
    const tab: BrowserTab = { id, loading: false, sessionId, title: "", view };
    this.tabs.push(tab);
    this.installTabEvents(tab);
    if (activate || !this.activeTabIds.has(sessionId)) this.activeTabIds.set(sessionId, id);
    const targetUrl = normalizeAddress(rawUrl);
    if (targetUrl !== "about:blank") {
      void view.webContents.loadURL(targetUrl).catch((error) => {
        this.log.warn("Browser tab failed to load", error);
      });
    }
    this.updateVisibility();
    this.sendState();
    return tab;
  }

  private openExternalProtocol(rawUrl: string): void {
    const externalUrl = allowedExternalProtocolUrl(rawUrl);
    if (!externalUrl) {
      this.log.warn("Blocked unsupported browser protocol", { url: rawUrl.slice(0, 512) });
      return;
    }
    void shell.openExternal(externalUrl).catch((error) => this.log.warn("Unable to open browser protocol", error));
  }

  private installTabEvents(tab: BrowserTab): void {
    const contents = tab.view.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      if (isBrowserUrl(url)) this.createTab(url, true, tab.sessionId);
      else this.openExternalProtocol(url);
      return { action: "deny" };
    });
    const handleExternalNavigation = (event: Event, url: string): void => {
      if (!isBrowserUrl(url)) {
        event.preventDefault();
        this.openExternalProtocol(url);
      }
    };
    contents.on("will-navigate", handleExternalNavigation);
    contents.on("will-redirect", handleExternalNavigation);
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
      this.scheduleStorageFlush();
      this.sendState();
    });
    contents.on("did-navigate", () => {
      this.scheduleStorageFlush();
      this.updateVisibility();
      this.sendState();
    });
    contents.on("did-navigate-in-page", () => {
      this.scheduleStorageFlush();
      this.sendState();
    });
    contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (isMainFrame && errorCode !== -3) {
        this.log.warn("Browser navigation failed", { errorCode, errorDescription, validatedUrl });
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
    const url = browserUrl(active.view.webContents.getURL());
    return {
      sessionId,
      activeTabId: active.id,
      canGoBack: active.view.webContents.navigationHistory.canGoBack(),
      canGoForward: active.view.webContents.navigationHistory.canGoForward(),
      loading: active.loading,
      tabs: this.tabs.filter((tab) => tab.sessionId === sessionId).map((tab) => ({
        id: tab.id,
        title: tab.title,
        url: browserUrl(tab.view.webContents.getURL()),
      })),
      title: active.title,
      url,
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
    const active = this.activeTab(this.displayedSessionId);
    const shouldShow = force ?? Boolean(
      this.requestedVisible
      && this.bounds
      && active
      && browserUrl(active.view.webContents.getURL()) !== "about:blank"
      && this.window.isVisible(),
    );
    for (const tab of this.tabs) {
      const visible = shouldShow && tab === active && tab.sessionId === this.displayedSessionId;
      if (visible && this.bounds) tab.view.setBounds(this.bounds);
      tab.view.setVisible(visible);
    }
  }

  private async pageSummary(contents: WebContents): Promise<string> {
    const title = await contents.getTitle();
    return `${title || "Untitled"}\n${browserUrl(contents.getURL())}`;
  }

  private async snapshotPage(contents: WebContents): Promise<string> {
    const payload = await contents.executeJavaScriptInIsolatedWorld(999, [{ code: `(() => {
      const compact = (value, limit = 180) => String(value ?? "").replace(/\\s+/g, " ").trim().slice(0, limit);
      const bodyText = compact(document.body?.innerText ?? "", 18000);
      const selectors = "a,button,input,textarea,select,summary,[role],[contenteditable='true']";
      const elements = Array.from(document.querySelectorAll(selectors)).slice(0, ${MAX_INTERACTIVE_ELEMENTS});
      const interactive = [];
      for (const element of elements) {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (rect.width <= 0 || rect.height <= 0 || style.visibility === "hidden" || style.display === "none") continue;
        const ref = "e" + (interactive.length + 1);
        element.setAttribute("data-piora-ref", ref);
        const input = element;
        const label = compact(element.getAttribute("aria-label") || element.getAttribute("title") || input.placeholder || element.innerText || input.value || "");
        interactive.push("[" + ref + "] " + (element.getAttribute("role") || element.tagName.toLowerCase()) + (label ? " — " + label : ""));
      }
      return { bodyText, interactive };
    })()` }]);
    const value = payload && typeof payload === "object"
      ? payload as { bodyText?: unknown; interactive?: unknown }
      : {};
    const bodyText = typeof value.bodyText === "string" ? value.bodyText : "";
    const interactive = Array.isArray(value.interactive) ? value.interactive.filter((item): item is string => typeof item === "string") : [];
    const output = `${await this.pageSummary(contents)}\n\nPage text:\n${bodyText}\n\nInteractive elements:\n${interactive.join("\n")}`;
    return output.length > MAX_SNAPSHOT_CHARS ? `${output.slice(0, MAX_SNAPSHOT_CHARS)}\n… snapshot truncated` : output;
  }

  private async targetBounds(contents: WebContents, params: Record<string, unknown>): Promise<{ x: number; y: number }> {
    const ref = typeof params.ref === "string" ? params.ref.replace(/[^A-Za-z0-9_-]/g, "") : "";
    const selector = typeof params.selector === "string" ? params.selector.slice(0, 2_000) : "";
    if (!ref && !selector) throw new Error("This browser action requires selector or ref.");
    const target = await contents.executeJavaScriptInIsolatedWorld(999, [{ code: `(() => {
      const element = ${JSON.stringify(ref)}
        ? document.querySelector('[data-piora-ref="' + ${JSON.stringify(ref)} + '"]')
        : document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      element.scrollIntoView({ block: "center", inline: "center" });
      const rect = element.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()` }]);
    if (!target || typeof target !== "object") throw new Error("The browser target was not found.");
    const point = target as { x?: unknown; y?: unknown };
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("The browser target is not visible.");
    return { x: Number(point.x), y: Number(point.y) };
  }

  private async typeIntoTarget(contents: WebContents, params: Record<string, unknown>): Promise<void> {
    if (typeof params.text !== "string") throw new Error("type requires text");
    const ref = typeof params.ref === "string" ? params.ref.replace(/[^A-Za-z0-9_-]/g, "") : "";
    const selector = typeof params.selector === "string" ? params.selector.slice(0, 2_000) : "";
    if (!ref && !selector) throw new Error("This browser action requires selector or ref.");
    const accepted = await contents.executeJavaScriptInIsolatedWorld(999, [{ code: `(() => {
      const element = ${JSON.stringify(ref)}
        ? document.querySelector('[data-piora-ref="' + ${JSON.stringify(ref)} + '"]')
        : document.querySelector(${JSON.stringify(selector)});
      if (!element) return false;
      element.focus();
      const text = ${JSON.stringify(params.text)};
      if (element.isContentEditable) element.textContent = text;
      else {
        const prototype = Object.getPrototypeOf(element);
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (setter) setter.call(element, text); else element.value = text;
      }
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()` }]);
    if (accepted !== true) throw new Error("The browser target was not found.");
    if (params.submit === true) {
      contents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
      contents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    }
  }

  async performAgentAction(
    rawSessionId: unknown,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<DesktopAgentBrowserResult> {
    const sessionId = normalizeBrowserSessionId(rawSessionId);
    if (sessionId === MANUAL_BROWSER_SESSION_ID) throw new Error("A valid Session id is required for Agent browser actions.");
    if (signal?.aborted) throw new Error("Browser action aborted");
    const action = typeof params.action === "string" ? params.action : "";
    if (!action) throw new Error("A browser action is required.");

    let tab = this.ensureSession(sessionId);
    let contents = tab.view.webContents;
    const stopOnAbort = () => contents.stop();
    signal?.addEventListener("abort", stopOnAbort, { once: true });
    try {
      if (action === "close") {
        this.closeSession(sessionId);
        return agentTextResult("Built-in browser session closed. The dedicated profile and sign-in state were preserved.", { action });
      }
      if (action === "open") {
        await contents.loadURL(requireAgentUrl(params.url));
      } else if (action === "snapshot") {
        return agentTextResult(await this.snapshotPage(contents), { action, url: browserUrl(contents.getURL()) });
      } else if (action === "click") {
        const point = await this.targetBounds(contents, params);
        contents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 });
        contents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 });
      } else if (action === "type") {
        await this.typeIntoTarget(contents, params);
      } else if (action === "press") {
        const rawKey = typeof params.key === "string" ? params.key.slice(0, 64) : "Enter";
        const parts = rawKey.split("+");
        const keyCode = parts.pop() || "Enter";
        const modifiers = parts.map((part) => part.toLocaleLowerCase()).filter((part): part is "alt" | "control" | "meta" | "shift" => (
          part === "alt" || part === "control" || part === "meta" || part === "shift"
        ));
        contents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
        contents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      } else if (action === "scroll") {
        const deltaY = Number.isFinite(params.deltaY) ? Number(params.deltaY) : 720;
        await contents.executeJavaScriptInIsolatedWorld(999, [{ code: `window.scrollBy(0, ${Math.round(deltaY)}); true` }]);
      } else if (action === "screenshot") {
        const image = await contents.capturePage();
        return {
          content: [
            { type: "text", text: await this.pageSummary(contents) },
            { type: "image", data: image.toPNG().toString("base64"), mimeType: "image/png" },
          ],
          details: { action, url: browserUrl(contents.getURL()), fullPage: false },
        };
      } else if (action === "evaluate") {
        if (!browserEvaluateEnabled()) throw new Error("Browser JavaScript evaluation is disabled by the operator.");
        if (typeof params.text !== "string" || !params.text) throw new Error("evaluate requires a JavaScript expression in text");
        const value = await contents.executeJavaScriptInIsolatedWorld(999, [{ code: `(() => (0, eval)(${JSON.stringify(params.text)}))()` }]);
        return agentTextResult(JSON.stringify(value, null, 2) ?? "undefined", { action, url: browserUrl(contents.getURL()) });
      } else if (action === "back") {
        if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
      } else if (action === "forward") {
        if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
      } else if (action === "reload") {
        contents.reload();
      } else if (action === "tabs") {
        const tabs = this.tabs.filter((candidate) => candidate.sessionId === sessionId);
        return agentTextResult(tabs.map((candidate, index) => (
          `${index}: ${candidate.title || "New tab"} — ${browserUrl(candidate.view.webContents.getURL())}${candidate === tab ? " (active)" : ""}`
        )).join("\n") || "No tabs", { action, count: tabs.length });
      } else if (action === "new_tab") {
        tab = this.createTab("about:blank", true, sessionId);
        contents = tab.view.webContents;
        if (typeof params.url === "string" && params.url) await contents.loadURL(requireAgentUrl(params.url));
      } else if (action === "switch_tab") {
        const tabs = this.tabs.filter((candidate) => candidate.sessionId === sessionId);
        const index = Math.floor(Number(params.tabIndex));
        if (!Number.isSafeInteger(index) || index < 0 || index >= tabs.length) throw new Error(`tabIndex must be between 0 and ${Math.max(0, tabs.length - 1)}`);
        tab = tabs[index]!;
        contents = tab.view.webContents;
        this.activeTabIds.set(sessionId, tab.id);
      } else if (action === "close_tab") {
        const tabs = this.tabs.filter((candidate) => candidate.sessionId === sessionId);
        const index = params.tabIndex === undefined ? tabs.indexOf(tab) : Math.floor(Number(params.tabIndex));
        if (!Number.isSafeInteger(index) || index < 0 || index >= tabs.length) throw new Error(`tabIndex must be between 0 and ${Math.max(0, tabs.length - 1)}`);
        this.closeTab(tabs[index]!.id, sessionId);
        tab = this.ensureSession(sessionId);
        contents = tab.view.webContents;
      } else {
        throw new Error(`Unsupported browser action: ${action}`);
      }
      if (signal?.aborted) throw new Error("Browser action aborted");
      if (sessionId === this.displayedSessionId) {
        this.updateVisibility();
        this.sendState();
      }
      this.scheduleStorageFlush();
      return agentTextResult(await this.pageSummary(contents), { action, url: browserUrl(contents.getURL()) });
    } finally {
      signal?.removeEventListener("abort", stopOnAbort);
    }
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
    const active = this.activeTab(this.displayedSessionId);
    if (!active) return;
    if (input.action === "navigate" && typeof input.url === "string") {
      await active.view.webContents.loadURL(normalizeAddress(input.url));
    } else if (input.action === "back" && active.view.webContents.navigationHistory.canGoBack()) {
      active.view.webContents.navigationHistory.goBack();
    } else if (input.action === "forward" && active.view.webContents.navigationHistory.canGoForward()) {
      active.view.webContents.navigationHistory.goForward();
    } else if (input.action === "reload") {
      active.view.webContents.reload();
    } else if (input.action === "new_tab") {
      this.createTab(typeof input.url === "string" ? input.url : "about:blank", true, this.displayedSessionId);
    } else if (input.action === "switch_tab" && typeof input.tabId === "string" && this.tabs.some((tab) => tab.id === input.tabId && tab.sessionId === this.displayedSessionId)) {
      this.activeTabIds.set(this.displayedSessionId, input.tabId);
      this.updateVisibility();
      this.sendState();
    } else if (input.action === "close_tab" && typeof input.tabId === "string") {
      this.closeTab(input.tabId, this.displayedSessionId);
    }
  }

  private closeSession(sessionId: string): void {
    const sessionTabs = this.tabs.filter((tab) => tab.sessionId === sessionId);
    for (const tab of sessionTabs) {
      const index = this.tabs.indexOf(tab);
      if (index >= 0) this.tabs.splice(index, 1);
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view);
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    this.activeTabIds.delete(sessionId);
    this.updateVisibility();
    this.sendState();
  }

  private closeTab(tabId: string, sessionId: string): void {
    const sessionTabs = this.tabs.filter((tab) => tab.sessionId === sessionId);
    const index = this.tabs.findIndex((tab) => tab.id === tabId && tab.sessionId === sessionId);
    if (index < 0) return;
    if (sessionTabs.length === 1) {
      const tab = sessionTabs[0]!;
      tab.title = "";
      tab.view.webContents.navigationHistory.clear();
      void tab.view.webContents.loadURL("about:blank");
      return;
    }
    const [tab] = this.tabs.splice(index, 1);
    if (!tab) return;
    this.window.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    if (this.activeTabIds.get(sessionId) === tabId) {
      const remaining = this.tabs.filter((candidate) => candidate.sessionId === sessionId);
      this.activeTabIds.set(sessionId, remaining[Math.min(sessionTabs.indexOf(tab), remaining.length - 1)]!.id);
    }
    this.updateVisibility();
    this.sendState();
  }
}
