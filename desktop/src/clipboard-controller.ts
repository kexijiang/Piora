import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, net, screen, session, type IpcMainEvent, type IpcMainInvokeEvent, type Rectangle } from "electron";
import { ClipboardRuntime } from "./clipboard-runtime.js";
import { cleanClipboardTemporaryFiles } from "./clipboard-drag-files.js";
import { clipboardWebLink } from "./clipboard-content.js";
import { clipboardMessage, type ClipboardLocale } from "./clipboard-messages.js";
import type { ClipboardBridge, ClipboardChange, ClipboardMutation, ClipboardOperation, ClipboardQuery } from "./clipboard-types.js";

type Surface = "quick" | "shelf";
type Sender = IpcMainInvokeEvent | IpcMainEvent;
type MenuAction = Awaited<ReturnType<ClipboardBridge["menu"]>>;
const CHANNEL = "pi:clipboard-v2-";
const SCHEME = "piora-clipboard";
export class ClipboardDraftFlushError extends Error {
  constructor() { super("Clipboard edit recovery could not finish. The application is still open; retry saving the draft before quitting."); }
}

interface Options {
  directory: string;
  origin: URL;
  partition: string;
  host: BrowserWindow;
  trusted: (event: IpcMainInvokeEvent) => boolean;
  openManager: () => BrowserWindow | null;
  onError: (error: unknown) => void;
}

/** Owns clipboard surfaces and capabilities; renderer requests contain record IDs only. */
export class ClipboardController {
  readonly runtime: ClipboardRuntime;
  private windows = new Map<Surface, BrowserWindow>();
  private loading = new Map<Surface, Promise<void>>();
  private targets = new Map<number, string>();
  private subscribers = new Set<number>();
  private locales = new Map<number, ClipboardLocale>();
  private leases = new Map<string, { window: BrowserWindow; id: string; thumbnail: boolean }>();
  private leaseKeys = new Map<string, string>();
  private thumbnails = new Map<string, Buffer>();
  private thumbnailJobs = new Map<string, Promise<Buffer>>();
  private prepared = new Map<number, { key: string; files: string[] }>();
  private dragTokens = new Map<number, object>();
  private dragJobs = new Set<Promise<string[]>>();
  private protectedWindows = new Map<number, number>();
  private registrations: string[] = [];
  private shortcut: string | undefined;
  private unwatch: (() => unknown) | undefined;
  private shelfBounds: Rectangle | undefined;
  private stopping = false;
  private started = false;
  private starting: Promise<void> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private geometryTail: Promise<void> = Promise.resolve();
  private openGeneration = 0;
  private closing = new Map<string, { sender: number; resolve: (ok: boolean) => void }>();
  private quitPreparation: Promise<void> | undefined;

  constructor(private options: Options) { this.runtime = new ClipboardRuntime(options.directory); }
  async start() {
    if (this.started) return;
    if (this.stopping) throw new Error("剪贴板存储正在关闭。");
    if (!this.registrations.length) this.register();
    this.unwatch ??= this.runtime.subscribe(change => this.broadcast(change));
    return this.starting ??= this.initialize().finally(() => { this.starting = null; });
  }
  private async initialize() {
    await this.runtime.start(this.options.host);
    await cleanClipboardTemporaryFiles(join(this.options.directory, "thumbnail-sources")).catch(this.options.onError);
    try {
      const bounds: unknown = JSON.parse(await readFile(join(this.options.directory, "shelf-window.json"), "utf8"));
      if (bounds && typeof bounds === "object" && ["x", "y", "width", "height"].every(key => Number.isFinite((bounds as Record<string, unknown>)[key]))) this.shelfBounds = bounds as Rectangle;
    } catch { /* First launch or invalid geometry uses the visible display. */ }
    const protocol = session.fromPartition(this.options.partition).protocol;
    if (await protocol.isProtocolHandled(SCHEME)) protocol.unhandle(SCHEME);
    protocol.handle(SCHEME, request => this.serveAsset(request));
    this.started = true;
  }
  setShortcut(accelerator?: string): boolean {
    if (this.shortcut) globalShortcut.unregister(this.shortcut);
    this.shortcut = undefined; this.runtime.shortcut = null;
    if (!accelerator) { this.broadcast({ reason: "status", revision: 0 }); return true; }
    try {
      if (!globalShortcut.register(accelerator, () => {
        const window = this.windows.get("quick");
        if (window?.isFocused()) window.hide();
        else void this.open("quick").catch(this.options.onError);
      })) { this.broadcast({ reason: "status", revision: 0 }); return false; }
      this.shortcut = accelerator; this.runtime.shortcut = accelerator;
      this.broadcast({ reason: "status", revision: 0 }); return true;
    } catch (error) { this.options.onError(error); return false; }
  }
  private validWindow(window: BrowserWindow): boolean {
    if (window.isDestroyed()) return false;
    try { return new URL(window.webContents.getURL()).origin === this.options.origin.origin; } catch { return false; }
  }
  private trusted(event: Sender): BrowserWindow {
    const window = BrowserWindow.fromWebContents(event.sender);
    const own = window && [...this.windows.values()].includes(window) && this.validWindow(window);
    if (!window || !event.senderFrame || event.senderFrame !== event.sender.mainFrame || !(own || this.options.trusted(event as IpcMainInvokeEvent))) throw new Error("Untrusted clipboard request");
    return window;
  }
  private register() {
    const handle = (name: string, fn: (window: BrowserWindow, value: unknown) => unknown) => {
      const channel = CHANNEL + name; this.registrations.push(channel);
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, value: unknown) => {
        const window = this.trusted(event);
        try { return await fn(window, value); }
        catch (error) { throw new Error(this.text(window, error instanceof Error ? error.message : String(error))); }
      });
    };
    handle("locale", (window, value) => {
      if (value !== "en" && value !== "zh-CN") throw new Error("Invalid clipboard locale");
      this.locales.set(window.webContents.id, value);
      const surface = [...this.windows].find(([, owned]) => owned === window)?.[0];
      if (surface) window.setTitle(this.text(window, surface === "quick" ? "Piora 剪贴板" : "Piora 屏幕暂存"));
    });
    handle("close-ready", (window, value) => {
      if (!value || typeof value !== "object") return;
      const { token, ok } = value as { token?: unknown; ok?: unknown };
      if (typeof token !== "string" || typeof ok !== "boolean") return;
      const request = this.closing.get(token);
      if (request?.sender === window.webContents.id) request.resolve(ok);
    });
    handle("watch", window => {
      this.subscribers.add(window.webContents.id);
      return this.context(window, window === this.windows.get("quick") ? "open" : "status");
    });
    handle("unwatch", window => {
      this.subscribers.delete(window.webContents.id);
      this.prepared.delete(window.webContents.id); this.dragTokens.delete(window.webContents.id); this.syncDragReferences();
      return this.runtime.store.cancelQuery(`renderer:${window.webContents.id}`);
    });
    handle("query", (window, value) => this.runtime.store.query(value as ClipboardQuery, `renderer:${window.webContents.id}`));
    handle("cancel-query", (window, value) => {
      if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("查询标识无效。");
      return this.runtime.store.cancelQuery(`renderer:${window.webContents.id}`, Number(value));
    });
    handle("detail", (_window, value) => this.runtime.store.detail(this.id(value)));
    handle("status", window => this.runtime.status(this.targets.get(window.webContents.id)));
    handle("reconnect", async () => { await this.runtime.reconnect(); await this.start(); });
    handle("mutate", (_window, value) => this.runtime.mutate(value as ClipboardMutation));
    handle("capture", () => this.runtime.capture(true));
    handle("copy", (_window, value) => this.runtime.operate(value as ClipboardOperation, false, () => {}));
    handle("paste", async (window, value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("粘贴参数无效。");
      // The caller cannot select another window's capability or a raw HWND.
      // Shelf / management actions use the most recent external target.
      const token = window === this.windows.get("quick") ? this.targets.get(window.webContents.id) : this.runtime.native?.target()?.token;
      const result = await this.runtime.operate({ ...(value as ClipboardOperation), ...(token ? { targetToken: token } : { targetToken: "" }) }, true, () => {
        if (window !== this.windows.get("shelf")) window.hide();
      });
      if (result.status !== "input-sent" && !window.isDestroyed() && !window.isVisible()) { window.show(); window.focus(); }
      return result;
    });
    handle("open", (_window, value) => {
      if (value !== "quick" && value !== "shelf" && value !== "manager") throw new Error("剪贴板窗口无效。");
      return this.open(value);
    });
    handle("hide", window => {
      if ([...this.windows.values()].includes(window)) { if (window === this.windows.get("quick")) this.openGeneration++; window.hide(); }
    });
    handle("asset", (window, value) => this.asset(window, value));
    handle("save", (window, value) => this.saveAs(window, this.id(value)));
    handle("export", window => this.protect(window, async () => {
      const result = await dialog.showSaveDialog(window, { title: this.text(window, "导出全部剪贴板历史"), defaultPath: `clipboard-${new Date().toISOString().slice(0, 10)}.piora-clipboard`, filters: [{ name: this.text(window, "Piora 剪贴板归档"), extensions: ["piora-clipboard"] }] });
      if (result.canceled || !result.filePath) return false;
      await this.runtime.store.exportArchive(result.filePath); return true;
    }));
    handle("import", window => this.protect(window, async () => {
      const result = await dialog.showOpenDialog(window, { title: this.text(window, "导入并合并剪贴板历史"), properties: ["openFile"], filters: [{ name: this.text(window, "Piora 剪贴板归档"), extensions: ["piora-clipboard"] }] });
      if (result.canceled || !result.filePaths[0]) return null;
      return this.runtime.importArchive(result.filePaths[0]);
    }));
    handle("reveal", async (_window, value) => {
      if (!value || typeof value !== "object") throw new Error("文件选择无效。");
      const input = value as { id: unknown; index: unknown };
      if (!Number.isInteger(input.index) || (input.index as number) < 0) throw new Error("文件序号无效。");
      const detail = await this.runtime.store.detail(this.id(input.id)), file = detail.files[input.index as number];
      if (!file?.exists) throw new Error("源文件已不存在。");
      const { shell } = await import("electron"); shell.showItemInFolder(file.path);
    });
    handle("open-link", async (_window, value) => {
      const entry = await this.runtime.store.detail(this.id(value));
      const link = entry.kind === "link" ? clipboardWebLink(entry.text) : null;
      if (!link || entry.deletedAt !== null && entry.shelfOrder === null) throw new Error("这条记录没有可直接打开的网页链接。");
      const { shell } = await import("electron"); await shell.openExternal(link.url);
    });
    handle("prepare-drag", async (window, value) => {
      const ids = this.ids(value), owner = window.webContents.id, token = {};
      this.prepared.delete(owner); this.syncDragReferences(); this.dragTokens.set(owner, token);
      const cancelled = () => this.stopping || window.isDestroyed() || this.dragTokens.get(owner) !== token;
      const job = this.runtime.prepareDrag(ids, cancelled); this.dragJobs.add(job);
      try {
        const files = await job;
        if (cancelled() || !files.length) return false;
        this.prepared.set(owner, { key: JSON.stringify(ids), files }); this.syncDragReferences(); return true;
      } catch (error) { if (cancelled()) return false; throw error; }
      finally { this.dragJobs.delete(job); }
    });
    ipcMain.on(CHANNEL + "drag", this.startDrag);
    handle("menu", (window, value) => this.menu(window, this.ids(value)));
  }
  private id(value: unknown): string {
    if (typeof value !== "string" || !value || value.length > 128) throw new Error("记录无效。"); return value;
  }
  private text(window: BrowserWindow, source: string) { return clipboardMessage(this.locales.get(window.webContents.id) ?? "zh-CN", source); }
  private syncDragReferences() { this.runtime.protectDragFiles([...this.prepared.values()].flatMap(entry => entry.files)); }
  private ids(value: unknown): string[] {
    if (!Array.isArray(value) || !value.length || value.length > 1000) throw new Error("选择的记录无效。"); return value.map(id => this.id(id));
  }
  private context(window: BrowserWindow, reason: ClipboardChange["reason"]): ClipboardChange {
    const token = this.targets.get(window.webContents.id);
    return { reason, revision: 0, ...(token ? { targetToken: token } : {}) };
  }
  private broadcast(change: ClipboardChange) {
    if (change.reason === "mutation") { this.prepared.clear(); this.dragTokens.clear(); this.syncDragReferences(); }
    for (const id of this.subscribers) {
      const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.id === id);
      if (!window || !this.validWindow(window)) { this.subscribers.delete(id); continue; }
      window.webContents.send(CHANNEL + "change", change);
    }
  }
  private fit(bounds: Rectangle): Rectangle {
    const area = screen.getDisplayMatching(bounds).workArea;
    const width = Math.min(Math.max(320, bounds.width), area.width), height = Math.min(Math.max(300, bounds.height), area.height);
    return { width, height, x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)), y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)) };
  }
  private create(surface: Surface): BrowserWindow {
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const bounds = surface === "shelf" && this.shelfBounds ? this.fit(this.shelfBounds) : this.fit({ x: area.x + 40, y: area.y + 60, width: surface === "quick" ? 760 : 360, height: surface === "quick" ? 540 : 420 });
    const window = new BrowserWindow({ ...bounds, minWidth: Math.min(320, area.width), minHeight: Math.min(300, area.height),
      show: false, frame: false, title: surface === "quick" ? "Piora 剪贴板" : "Piora 屏幕暂存", backgroundColor: "#181a1e",
      alwaysOnTop: surface === "shelf", skipTaskbar: true, autoHideMenuBar: true,
      webPreferences: { preload: join(__dirname, "preload.js"), partition: this.options.partition, sandbox: true, contextIsolation: true,
        nodeIntegration: false, nodeIntegrationInWorker: false, webviewTag: false, webSecurity: true, navigateOnDragDrop: false, safeDialogs: true, devTools: !app.isPackaged },
    });
    this.windows.set(surface, window);
    const webContentsId = window.webContents.id;
    const unexclude = this.runtime.native?.exclude(window);
    const allowed = new URL(`/desktop-clipboard?surface=${surface}`, this.options.origin);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => { if (url !== allowed.href) event.preventDefault(); });
    window.webContents.on("will-attach-webview", event => event.preventDefault());
    window.webContents.on("render-process-gone", () => {
      this.prepared.delete(webContentsId);
      this.dragTokens.delete(webContentsId); this.syncDragReferences();
      void this.runtime.store.cancelQuery(`renderer:${webContentsId}`).catch(() => {});
    });
    window.on("blur", () => {
      // Focus events can arrive after a rapid host-to-quick handoff. Verify the
      // current focus on the next turn instead of hiding a newly focused window.
      if (surface === "quick") setTimeout(() => {
        if (!window.isDestroyed() && !this.protectedWindows.get(window.id) && !window.isFocused() && !this.runtime.native?.isForeground(window)) window.hide();
      }, 0);
    });
    window.on("close", event => { if (!this.stopping) { event.preventDefault(); if (surface === "quick") this.openGeneration++; window.hide(); } });
    window.on("closed", () => {
      unexclude?.(); this.windows.delete(surface); this.loading.delete(surface); this.targets.delete(webContentsId);
      this.subscribers.delete(webContentsId); this.prepared.delete(webContentsId);
      this.locales.delete(webContentsId);
      this.dragTokens.delete(webContentsId); this.syncDragReferences(); this.protectedWindows.delete(window.id);
      void this.runtime.store.cancelQuery(`renderer:${webContentsId}`).catch(() => {});
      for (const [token, lease] of this.leases) if (lease.window === window) this.leases.delete(token);
      this.leaseKeys.clear();
    });
    if (surface === "shelf") {
      const persist = () => {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.shelfBounds = window.getBounds();
        this.saveTimer = setTimeout(() => { void this.saveGeometry().catch(this.options.onError); }, 250);
      };
      window.on("move", persist); window.on("resize", persist);
    }
    const loaded = window.loadURL(allowed.href);
    this.loading.set(surface, loaded);
    void loaded.catch(this.options.onError);
    return window;
  }
  async warm() { if (!this.stopping && !this.windows.has("quick")) { this.create("quick"); await this.loading.get("quick"); } }
  async open(surface: Surface | "manager") {
    if (this.stopping) return;
    if (surface === "manager") {
      const window = this.options.openManager();
      if (window) this.runtime.native?.exclude(window);
      return;
    }
    const generation = ++this.openGeneration;
    const target = this.runtime.native?.target();
    const window = this.windows.get(surface) ?? this.create(surface);
    if (target) this.targets.set(window.webContents.id, target.token); else this.targets.delete(window.webContents.id);
    if (surface === "quick") {
      const area = target?.bounds ? screen.getDisplayMatching(screen.screenToDipRect(null, target.bounds)).workArea : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      window.setBounds(this.fit({ x: Math.round(area.x + (area.width - 760) / 2), y: Math.round(area.y + Math.min(140, (area.height - 540) / 2)), width: 760, height: 540 }));
    }
    await this.loading.get(surface);
    if (this.stopping || window.isDestroyed() || surface === "quick" && generation !== this.openGeneration) return;
    window.webContents.send(CHANNEL + "change", this.context(window, "open"));
    window.show(); window.focus();
  }
  private saveGeometry(): Promise<void> {
    if (!this.shelfBounds) return this.geometryTail;
    const content = JSON.stringify(this.shelfBounds);
    const write = this.geometryTail.catch(() => {}).then(async () => {
      const file = join(this.options.directory, "shelf-window.json"), temporary = `${file}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, content, { mode: 0o600 }); await rename(temporary, file); }
      finally { await unlink(temporary).catch(() => {}); }
    });
    this.geometryTail = write; return write;
  }
  private async protect<T>(window: BrowserWindow, task: () => Promise<T>): Promise<T> {
    this.protectedWindows.set(window.id, (this.protectedWindows.get(window.id) ?? 0) + 1);
    try { return await task(); } finally { this.protectedWindows.set(window.id, Math.max(0, (this.protectedWindows.get(window.id) ?? 1) - 1)); }
  }
  private async asset(window: BrowserWindow, value: unknown): Promise<string> {
    if (!value || typeof value !== "object") throw new Error("图片请求无效。");
    const input = value as { id: unknown; thumbnail: unknown }, id = this.id(input.id);
    if (input.thumbnail !== undefined && typeof input.thumbnail !== "boolean") throw new Error("图片尺寸请求无效。");
    await this.runtime.store.asset(id);
    const key = `${window.webContents.id}:${id}:${input.thumbnail === true}`, previous = this.leaseKeys.get(key);
    if (previous && this.leases.has(previous)) return `${SCHEME}://asset/${previous}`;
    const token = randomUUID();
    if (this.leases.size >= 2000) { const oldest = this.leases.keys().next().value!; this.leases.delete(oldest); for (const [key, value] of this.leaseKeys) if (value === oldest) this.leaseKeys.delete(key); }
    this.leases.set(token, { window, id, thumbnail: input.thumbnail === true }); this.leaseKeys.set(key, token);
    return `${SCHEME}://asset/${token}`;
  }
  private async serveAsset(request: Request): Promise<Response> {
    const url = new URL(request.url), lease = this.leases.get(url.pathname.slice(1));
    if (request.method !== "GET" || url.hostname !== "asset" || !lease || !this.validWindow(lease.window)) return new Response(null, { status: 404 });
    if (request.referrer && new URL(request.referrer).origin !== this.options.origin.origin) return new Response(null, { status: 403 });
    try {
      const asset = await this.runtime.store.asset(lease.id);
      if (lease.thumbnail) {
        // Windows shell thumbnails are asynchronous; full-size decoding stays out
        // of the hot list-render path. A failed thumbnail can use the type icon.
        const thumbnail = await this.thumbnail(asset.path);
        return new Response(new Uint8Array(thumbnail), { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": this.options.origin.origin } });
      }
      const response = await net.fetch(pathToFileURL(asset.path).href);
      return new Response(response.body, { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": this.options.origin.origin } });
    } catch { return new Response(null, { status: 404 }); }
  }
  private thumbnail(path: string): Promise<Buffer> {
    const cached = this.thumbnails.get(path);
    if (cached) { this.thumbnails.delete(path); this.thumbnails.set(path, cached); return Promise.resolve(cached); }
    const pending = this.thumbnailJobs.get(path); if (pending) return pending;
    const job = (async () => {
      const directory = join(this.options.directory, "thumbnail-sources");
      await mkdir(directory, { recursive: true });
      // Windows chooses its shell image handler by extension. The archive keeps
      // extensionless hashes, so create a temporary hard link without duplicating
      // the original bytes or synchronously decoding large images on the UI thread.
      const source = join(directory, `${randomUUID()}.png`);
      try {
        await link(path, source).catch(() => copyFile(path, source));
        const image = await nativeImage.createThumbnailFromPath(source, { width: 96, height: 96 });
        if (image.isEmpty()) throw new Error("图片缩略图不可用。");
        const png = image.toPNG();
        if (this.thumbnails.size >= 128) this.thumbnails.delete(this.thumbnails.keys().next().value!);
        this.thumbnails.set(path, png); return png;
      } finally { await unlink(source).catch(() => {}); }
    })();
    this.thumbnailJobs.set(path, job);
    void job.finally(() => this.thumbnailJobs.delete(path)).catch(() => {});
    return job;
  }
  private async saveAs(window: BrowserWindow, id: string): Promise<boolean> {
    const entry = await this.runtime.store.detail(id), isImage = entry.kind === "image";
    if (!isImage && entry.text === null) throw new Error("这条记录没有可另存的文字或图片。");
    return this.protect(window, async () => {
      const file = await dialog.showSaveDialog(window, { title: this.text(window, "另存剪贴板内容"), defaultPath: `${entry.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 80) || "clipboard"}.${isImage ? "png" : "txt"}`, filters: [{ name: this.text(window, isImage ? "PNG 图片" : "文字"), extensions: [isImage ? "png" : "txt"] }] });
      if (file.canceled || !file.filePath) return false;
      if (isImage) await copyFile((await this.runtime.store.asset(id)).path, file.filePath);
      else await writeFile(file.filePath, entry.text!, "utf8");
      return true;
    });
  }
  private startDrag = (event: IpcMainEvent, value: unknown) => {
    let window: BrowserWindow | undefined;
    try {
      window = this.trusted(event);
      const ids = this.ids(value), prepared = this.prepared.get(window.webContents.id);
      if (!prepared || prepared.key !== JSON.stringify(ids)) throw new Error("拖拽内容正在准备，请重新选择后再试。");
      if (prepared.files.some(file => !existsSync(file))) throw new Error("部分源文件已不存在，请在预览中检查后重新选择。");
      this.runtime.retainDragFiles(prepared.files);
      const draggingWindow = window;
      this.protectedWindows.set(window.id, (this.protectedWindows.get(window.id) ?? 0) + 1);
      try {
        // A small app-owned image avoids decoding an arbitrarily large dragged PNG.
        const icon = nativeImage.createFromBitmap(Buffer.alloc(16 * 16 * 4, 0xbb), { width: 16, height: 16 });
        event.sender.startDrag({ file: prepared.files[0]!, files: prepared.files, icon });
      } finally {
        // Native dragging may yield focus before completion; give the renderer a
        // chance to process its drag end before ordinary blur hiding resumes.
        setTimeout(() => {
          if (draggingWindow.isDestroyed()) return;
          const count = Math.max(0, (this.protectedWindows.get(draggingWindow.id) ?? 1) - 1);
          this.protectedWindows.set(draggingWindow.id, count);
          if (!count && draggingWindow === this.windows.get("quick") && !draggingWindow.isFocused()) draggingWindow.hide();
        }, 250);
      }
    } catch (error) {
      if (window && !window.isDestroyed()) {
        this.prepared.delete(window.webContents.id);
        this.syncDragReferences();
        window.webContents.send(CHANNEL + "change", { reason: "status", revision: 0, error: error instanceof Error ? error.message : "拖拽失败，请重试。" } satisfies ClipboardChange);
      } else this.options.onError(error);
    }
  };
  private async menu(window: BrowserWindow, ids: string[]): Promise<MenuAction> {
    const entries = await this.runtime.details(ids), deleted = entries.some(entry => entry.deletedAt !== null && entry.shelfOrder === null);
    const actions: Array<[MenuAction, string]> = deleted ? [["restore", "恢复"], ["purge", "永久删除"]] : [["paste", "粘贴"], ["plain", "纯文本粘贴"], ["copy", "复制"], ["star", entries.every(entry => entry.starred) ? "取消收藏" : "收藏"], ["shelf-add", "加入屏幕暂存"], ["shelf-remove", "移出屏幕暂存"], ["save", "另存为…"], ["delete", "移到回收站"]];
    if (window === this.windows.get("shelf") && entries.every(entry => entry.shelfOrder !== null)) {
      actions.splice(0, actions.length, ["copy", "复制"], ["paste", "粘贴"], ...(ids.length === 1 ? [["shelf-top", "移到顶部"], ["shelf-up", "上移"], ["shelf-down", "下移"]] as Array<[MenuAction, string]> : []), ["shelf-remove", "移出暂存"]);
    }
    return this.protect(window, () => new Promise<MenuAction>(resolve => {
      let selected: MenuAction = null;
      const menu = Menu.buildFromTemplate(actions.map(([action, label]) => ({ label: this.text(window, label), enabled: action !== "save" || ids.length === 1, click: () => { selected = action; } })));
      menu.popup({ window, callback: () => resolve(selected) });
    }));
  }
  async stop() {
    await this.prepareQuit();
    this.stopping = true; this.openGeneration++; this.unwatch?.();
    if (this.shortcut) globalShortcut.unregister(this.shortcut);
    for (const channel of this.registrations) ipcMain.removeHandler(channel);
    ipcMain.removeListener(CHANNEL + "drag", this.startDrag);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    await this.saveGeometry();
    await Promise.allSettled(this.thumbnailJobs.values());
    await Promise.allSettled(this.dragJobs);
    await this.runtime.stop();
    for (const window of this.windows.values()) window.destroy();
    if (this.started) session.fromPartition(this.options.partition).protocol.unhandle(SCHEME);
    this.leases.clear(); this.leaseKeys.clear(); this.subscribers.clear();
    this.locales.clear();
    this.prepared.clear(); this.dragTokens.clear(); this.protectedWindows.clear();
  }
  prepareQuit(): Promise<void> {
    return this.quitPreparation ??= this.flushBeforeQuit().finally(() => { this.quitPreparation = undefined; });
  }
  private async flushBeforeQuit() {
    const windows = BrowserWindow.getAllWindows().filter(window => this.locales.has(window.webContents.id) && this.validWindow(window));
    const results = await Promise.all(windows.map(window => new Promise<boolean>(resolve => {
      const token = randomUUID();
      const finish = (ok: boolean) => { clearTimeout(timer); this.closing.delete(token); resolve(ok); };
      const timer = setTimeout(() => finish(false), 10_000);
      this.closing.set(token, { sender: window.webContents.id, resolve: finish });
      try { window.webContents.send(CHANNEL + "prepare-close", token); } catch { finish(false); }
    })));
    if (results.some(ok => !ok)) {
      for (const window of windows) if (!window.isDestroyed()) window.webContents.send(CHANNEL + "cancel-close");
      throw new ClipboardDraftFlushError();
    }
  }
}
