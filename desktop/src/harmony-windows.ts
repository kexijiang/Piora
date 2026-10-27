import { app, BrowserWindow, ipcMain, Menu, screen, type IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { mirrorBounds, applyMirrorBounds } from "./harmony-window-bounds.js";
import type { HarmonyWindowState, MirrorScale, PioraMessage } from "./harmony-window-types.js";

type Dependencies = {
  origin: URL; partition: string; preload: string; main: () => BrowserWindow | null;
  trustedMain: (event: IpcMainInvokeEvent) => boolean;
  request: <T>(path: string, body?: unknown) => Promise<T>;
  workbench: () => void;
};
type SavedWindow = { scale: MirrorScale; x: number; y: number };
type Recording = { recordingId: string; ownerId: string; startedAt: string; systemRecorderStateUnknown?: boolean };
export class HarmonyWindows {
  private mirror: BrowserWindow | null = null;
  private messageWindow: BrowserWindow | null = null;
  private message: PioraMessage | null = null;
  private finishMessage: ((id: string | null) => void) | undefined;
  private messages: Promise<unknown> = Promise.resolve();
  private transition: Promise<unknown> = Promise.resolve();
  private closing: Promise<boolean> | undefined;
  private ratio = 9 / 20;
  private placing = false;
  private pendingPlace = false;
  private pendingPosition: SavedWindow | undefined;
  private notified = new Set<string>();
  private appliedBounds?: { x: number; y: number; width: number; height: number };
  private forceClose = false;
  private prefs = new Map<string, SavedWindow>();
  private state: HarmonyWindowState = { serial: "", scale: 75, alwaysOnTop: false, open: false, minimized: false, ownerId: `desktop-media-${randomUUID()}` };
  constructor(private deps: Dependencies) {
    try {
      const items: unknown = JSON.parse(readFileSync(this.preferencePath(), "utf8"));
      if (Array.isArray(items)) for (const item of items.slice(-100)) {
        if (Array.isArray(item) && typeof item[0] === "string" && this.validScale(item[1]?.scale) && Number.isFinite(item[1]?.x) && Number.isFinite(item[1]?.y)) this.prefs.set(item[0], item[1]);
      }
    } catch { /* First launch or invalid preference file. */ }
    const call = (name: string, run: (event: IpcMainInvokeEvent, value: unknown) => unknown) => ipcMain.handle(`pi:harmony-window-${name}`, (event, value) => {
      if (!deps.trustedMain(event) && !this.trustedMirror(event)) throw new Error("Untrusted Harmony window request");
      return run(event, value);
    });
    call("state", () => this.snapshot());
    call("open", (_event, value) => this.serialized(async () => { await this.select(value); this.state.presentation = "floating"; this.state.open = true; this.create(); this.focus(); this.emit(); return this.snapshot(); }));
    call("presentation", (_event, value) => this.serialized(async () => {
      if (value !== "floating" && value !== "sidebar") throw new Error("Invalid mirror presentation");
      this.state.presentation = value; this.state.open = true;
      if (value === "sidebar") { this.mirror?.hide(); this.deps.workbench(); }
      else { this.create(); this.focus(); }
      this.emit(); return this.snapshot();
    }));
    call("select", (_event, value) => this.serialized(async () => { await this.select(value); return this.snapshot(); }));
    call("close", () => this.requestClose());
    call("focus", () => this.focus());
    call("scale", (_event, value) => { if (!this.validScale(value)) throw new Error("Invalid mirror scale"); this.state.scale = value; this.place(); this.save(); this.emit(); return this.snapshot(); });
    call("top", (_event, value) => { if (typeof value !== "boolean") throw new Error("Invalid window preference"); this.state.alwaysOnTop = value; this.mirror?.setAlwaysOnTop(value); this.emit(); return this.snapshot(); });
    call("frame", (event, value) => {
      if (!this.trustedMirror(event) || !value || typeof value !== "object") return;
      const frame = value as { serial?: unknown; width?: unknown; height?: unknown };
      if (frame.serial !== this.state.serial || typeof frame.width !== "number" || typeof frame.height !== "number" || !Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width < 1 || frame.height < 1 || frame.width > 8192 || frame.height > 8192) return;
      const ratio = frame.width / frame.height;
      if (Math.abs(this.ratio - ratio) > .0001) { this.ratio = ratio; this.place(); }
    });
    call("workbench", () => deps.workbench());
    call("menu", () => this.menu());
    ipcMain.handle("pi:message-show", (event, value) => {
      if (!deps.trustedMain(event) && !this.trustedMirror(event)) throw new Error("Untrusted message request");
      return this.showMessage(this.validateMessage(value), this.trustedMirror(event) ? this.mirror : deps.main());
    });
    ipcMain.handle("pi:message-get", event => this.trustedMessage(event) ? this.message : null);
    ipcMain.handle("pi:message-finish", (event, id) => {
      if (!this.trustedMessage(event)) throw new Error("Untrusted message response");
      if (id === null || this.message?.actions.some(action => action.id === id)) this.finishMessage?.(id);
    });
    screen.on("display-metrics-changed", () => this.place());
    screen.on("display-removed", () => this.place());
  }
  private preferencePath() { return join(app.getPath("userData"), "harmony-mirror-windows.json"); }
  private validScale(value: unknown): value is MirrorScale { return value === 25 || value === 50 || value === 75 || value === 100; }
  private snapshot() { return { ...this.state }; }
  private trusted(event: IpcMainInvokeEvent, window: BrowserWindow | null, pathname: string) {
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false;
    try { const url = new URL(event.senderFrame.url); return url.origin === this.deps.origin.origin && url.pathname === pathname; } catch { return false; }
  }
  trustedMirror(event: IpcMainInvokeEvent) { return this.trusted(event, this.mirror, "/desktop-harmony"); }
  async trustedMediaFile(event: IpcMainInvokeEvent, path: unknown): Promise<boolean> {
    if (!this.trustedMirror(event) || typeof path !== "string") return false;
    const result = await this.deps.request<{ artifacts: Array<{ path: string }> }>(`/api/harmony/media/history?serial=${encodeURIComponent(this.state.serial)}`);
    return result.artifacts.some(artifact => artifact.path === path);
  }
  private trustedMessage(event: IpcMainInvokeEvent) { return this.trusted(event, this.messageWindow, "/desktop-message"); }
  private serialized<T>(action: () => Promise<T>): Promise<T> { const next = this.transition.then(action, action); this.transition = next.catch(() => undefined); return next; }
  private emit() { for (const window of [this.deps.main(), this.mirror]) if (window && !window.isDestroyed()) window.webContents.send("pi:harmony-window-state", this.snapshot()); }
  private save() {
    if (!this.mirror || !this.state.serial) return;
    const { x, y } = this.mirror.getBounds();
    this.prefs.set(this.state.serial, { scale: this.state.scale, x, y });
    try { const path = this.preferencePath(); writeFileSync(`${path}.tmp`, JSON.stringify([...this.prefs].slice(-100))); renameSync(`${path}.tmp`, path); } catch { /* Window placement remains usable if persistence is unavailable. */ }
  }
  private async place(saved?: SavedWindow) {
    if (!this.mirror || this.mirror.isDestroyed()) return;
    if (this.placing) { this.pendingPlace = true; if (saved) this.pendingPosition = saved; return; }
    this.placing = true;
    try {
      const position = saved ?? this.mirror.getBounds();
      const display = screen.getDisplayNearestPoint({ x: position.x, y: position.y });
      this.appliedBounds = await applyMirrorBounds(this.mirror, mirrorBounds(display.workArea, this.ratio, this.state.scale, position));
    } catch { /* The window can close while Win32 settles its final bounds. */ }
    finally { this.placing = false; if (this.pendingPlace) { this.pendingPlace = false; const position = this.pendingPosition; this.pendingPosition = undefined; void this.place(position); } else this.save(); }
  }
  private async select(value: unknown) {
    if (typeof value !== "string" || !value || value.length > 256 || /[\x00-\x1f]/.test(value)) throw new Error("Invalid Harmony device");
    if (value === this.state.serial) return;
    if (this.state.serial && !await this.confirmRecording("切换设备")) return;
    this.save(); this.state.serial = value; this.ratio = 9 / 20;
    const saved = this.prefs.get(value); this.state.scale = saved?.scale ?? 75;
    this.place(saved); this.emit();
  }
  private createSurface(pathname: string, options: Electron.BrowserWindowConstructorOptions) {
    const window = new BrowserWindow({ show: false, backgroundColor: "#fafafa", ...options, webPreferences: {
      preload: this.deps.preload, partition: this.deps.partition, sandbox: true, contextIsolation: true,
      nodeIntegration: false, webviewTag: false, navigateOnDragDrop: false, backgroundThrottling: false,
    } });
    const target = new URL(pathname, this.deps.origin);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => { if (url !== target.href) event.preventDefault(); });
    window.webContents.on("will-redirect", (event, url) => { if (url !== target.href) event.preventDefault(); });
    window.webContents.on("will-attach-webview", event => event.preventDefault());
    window.webContents.setZoomFactor(1);
    void window.webContents.setVisualZoomLevelLimits(1, 1);
    window.once("ready-to-show", () => { if (!window.isDestroyed()) { if (options.focusable === false) window.showInactive(); else window.show(); } });
    void window.loadURL(target.href).catch(() => { if (!window.isDestroyed()) window.destroy(); });
    return window;
  }
  private create() {
    if (this.mirror && !this.mirror.isDestroyed()) return;
    const saved = this.prefs.get(this.state.serial);
    const area = saved ? screen.getDisplayNearestPoint(saved).workArea : screen.getPrimaryDisplay().workArea;
    const window = this.createSurface("/desktop-harmony", { ...mirrorBounds(area, this.ratio, this.state.scale, saved), title: "Piora · 鸿蒙投屏", frame: false, resizable: false, maximizable: false, fullscreenable: false, alwaysOnTop: this.state.alwaysOnTop });
    this.mirror = window; this.state.open = true; this.state.minimized = false;
    window.on("close", event => { if (this.forceClose) return; event.preventDefault(); void this.requestClose(); });
    window.on("closed", () => { this.mirror = null; this.state.open = false; this.state.minimized = false; this.emit(); });
    window.on("moved", () => {
      if (this.placing) return;
      const bounds = window.getBounds();
      if (this.appliedBounds && (["x", "y", "width", "height"] as const).every(key => bounds[key] === this.appliedBounds![key])) return;
      this.place(); this.save();
    });
    window.on("minimize", () => { this.state.minimized = true; this.emit(); });
    window.on("restore", () => { this.state.minimized = false; this.emit(); });
    window.webContents.on("did-finish-load", () => { this.place(saved); this.emit(); });
    window.webContents.on("context-menu", () => this.menu());
    this.emit();
  }
  private focus() { if (this.mirror && !this.mirror.isDestroyed()) { this.mirror.restore(); this.mirror.show(); this.mirror.focus(); } }
  private async confirmRecording(action: string) {
    try {
      const { recording } = await this.deps.request<{ recording: Recording | null }>(`/api/harmony/media?serial=${encodeURIComponent(this.state.serial)}`);
      if (!recording) return true;
      const ours = recording.ownerId === this.state.ownerId;
      const elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(recording.startedAt)) / 1000));
      const clock = Number.isFinite(elapsed) ? `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}` : "";
      const answer = await this.showMessage({ title: ours ? `停止录屏并${action}？` : `录屏任务仍在运行`, message: ours ? recording.systemRecorderStateUnknown ? "请先在手机上停止录屏，再从工作台取回文件。" : `${clock ? `录屏已进行 ${clock}。` : ""}停止后将保存到媒体库；保存成功后继续。` : `其他任务的录屏将继续。是否${action}？`, tone: "confirm", actions: recording.systemRecorderStateUnknown && ours ? [{ id: "cancel", label: "返回" }] : [{ id: "cancel", label: ours ? "继续录屏" : "取消" }, { id: "confirm", label: ours ? "停止并保存" : action, primary: true }] }, this.mirror ?? this.deps.main());
      if (answer !== "confirm") return false;
      if (ours) await this.deps.request("/api/harmony/media", { action: "stop_recording", serial: this.state.serial, ownerId: this.state.ownerId, recordingId: recording.recordingId });
      return true;
    } catch (error) {
      await this.showMessage({ title: "暂时无法继续", message: error instanceof Error ? error.message : String(error), tone: "error", actions: [{ id: "done", label: "返回", primary: true }] }, this.mirror ?? this.deps.main());
      return false;
    }
  }
  async close() {
    if (!this.mirror && !this.state.open) return true;
    if (!await this.confirmRecording("关闭投屏")) return false;
    this.save(); this.forceClose = true; this.mirror?.close(); this.forceClose = false;
    this.state.open = false; this.emit(); return true;
  }
  private requestClose(): Promise<boolean> {
    if (this.closing) return this.closing;
    const pending = this.serialized(() => this.close()); this.closing = pending;
    void pending.finally(() => { if (this.closing === pending) this.closing = undefined; }).catch(() => undefined);
    return pending;
  }
  async prepareQuit() { return this.serialized(() => this.state.serial ? this.confirmRecording("退出 Piora") : Promise.resolve(true)); }
  destroy() { this.forceClose = true; this.finishMessage?.(null); this.mirror?.destroy(); }
  private menu() {
    if (!this.mirror) return;
    const command = (value: string) => this.mirror?.webContents.send("pi:harmony-window-command", value);
    Menu.buildFromTemplate([
      { label: "截图", click: () => command("screenshot") }, { label: "录屏 / 停止录屏", click: () => command("record") },
      { type: "separator" }, ...([25, 50, 75, 100] as const).map(scale => ({ label: `${scale}%`, type: "radio" as const, checked: this.state.scale === scale, click: () => { this.state.scale = scale; this.place(); this.save(); this.emit(); } })),
      { type: "separator" }, { label: "置顶", type: "checkbox", checked: this.state.alwaysOnTop, click: item => { this.state.alwaysOnTop = item.checked; this.mirror?.setAlwaysOnTop(item.checked); this.emit(); } },
      { label: "重连", click: () => command("reconnect") }, { label: "连接详情", click: () => command("details") },
      { label: "返回工作台", click: () => this.deps.workbench() }, { label: "最小化", click: () => this.mirror?.minimize() },
      { label: "关闭投屏", click: () => { void this.requestClose(); } },
    ]).popup({ window: this.mirror });
  }
  private validateMessage(value: unknown): PioraMessage {
    const message = value as PioraMessage;
    if (!message || typeof message.title !== "string" || message.title.length > 200 || typeof message.message !== "string" || message.message.length > 10000 || !Array.isArray(message.actions) || !message.actions.length || message.actions.length > 5 || message.actions.some(a => typeof a.id !== "string" || typeof a.label !== "string" || a.id.length > 80 || a.label.length > 100)) throw new Error("Invalid message");
    if (message.preview && !message.preview.startsWith("/api/harmony/media/preview?")) throw new Error("Invalid media preview");
    if (message.notificationKey !== undefined && (typeof message.notificationKey !== "string" || message.notificationKey.length > 160)) throw new Error("Invalid notification key");
    if (message.presentation !== undefined && message.presentation !== "notice") throw new Error("Invalid presentation");
    if (message.durationMs !== undefined && (!Number.isInteger(message.durationMs) || message.durationMs < 1200 || message.durationMs > 10000)) throw new Error("Invalid notice duration");
    if (message.presentation === "notice" && (message.tone === "confirm" || message.preview)) throw new Error("Notices cannot request confirmation or show previews");
    return message;
  }
  private showMessage(message: PioraMessage, parent: BrowserWindow | null): Promise<string | null> {
    if (message.notificationKey) {
      if (this.notified.has(message.notificationKey)) return Promise.resolve(null);
      this.notified.add(message.notificationKey);
      if (this.notified.size > 1000) this.notified.delete(this.notified.values().next().value!);
    }
    const show = () => new Promise<string | null>(resolve => {
      const host = parent && !parent.isDestroyed() ? parent : this.deps.main();
      const area = host ? screen.getDisplayMatching(host.getBounds()).workArea : screen.getPrimaryDisplay().workArea;
      const bounds = host?.getBounds() ?? area;
      const notice = message.presentation === "notice";
      const width = Math.min(notice ? 340 : 430, area.width - 32), height = Math.min(notice ? 112 : message.preview ? 500 : 320, area.height - 32);
      this.message = message;
      const window = this.createSurface("/desktop-message", { width, height,
        x: Math.max(area.x, Math.min(area.x + area.width - width, Math.round(bounds.x + (bounds.width - width) / 2))),
        y: Math.max(area.y, Math.min(area.y + area.height - height, Math.round(notice ? bounds.y + 44 : bounds.y + (bounds.height - height) / 2))),
        ...(host ? { parent: host, modal: !notice } : {}), ...(notice ? { focusable: false } : {}), frame: false, resizable: false, minimizable: false, maximizable: false, skipTaskbar: true, title: message.title });
      this.messageWindow = window;
      let done = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (id: string | null) => { if (done) return; done = true; clearTimeout(timeout); this.message = null; this.messageWindow = null; this.finishMessage = undefined; if (!window.isDestroyed()) window.destroy(); if (!notice && host && !host.isDestroyed()) host.focus(); resolve(id); };
      this.finishMessage = finish; window.on("closed", () => finish(null));
      if (notice) window.once("ready-to-show", () => { timeout = setTimeout(() => finish(null), message.durationMs ?? 3000); });
    });
    const result = this.messages.then(show, show); this.messages = result.catch(() => undefined); return result;
  }
}
