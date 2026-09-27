import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, nativeImage, screen,
  type IpcMainInvokeEvent,
} from "electron";
import { planCaptureSelection, rectFromPoints, type CapturePoint, type CaptureRect } from "./screenshot-geometry.js";
import { ScreenshotPointer } from "./screenshot-pointer.js";
import type {
  PendingScreenshotAttachment, ScreenshotFrame, ScreenshotOutputAction,
  ScreenshotOutputResult, ScreenshotWindowState, ScreenshotWindowUpdate,
} from "./screenshot-types.js";

const CHANNEL = "pi:screenshot:";
const MAX_PNG_BYTES = 100 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

interface CaptureSession {
  id: string;
  frames: ScreenshotFrame[];
  windows: Map<string, BrowserWindow>;
  targetDraftKey: string | null;
  phase: "selection" | "editing" | "pending";
  startPoint: CapturePoint | null;
  selection: CaptureRect | null;
  dragTimer: ReturnType<typeof setInterval> | null;
  editWindow: BrowserWindow | null;
  pending: PendingScreenshotAttachment | null;
  ready: Set<string>;
  readyWaiters: Map<string, () => void>;
  editUpdate: Extract<ScreenshotWindowUpdate, { phase: "editing" }> | null;
}

interface Options {
  host: BrowserWindow;
  origin: URL;
  partition: string;
  trustedMain: (event: IpcMainInvokeEvent) => boolean;
  onError: (error: unknown) => void;
}

export class ScreenshotController {
  private active: CaptureSession | null = null;
  private target: { token: string; draftKey: string; available: boolean } | null = null;
  private pointer: ScreenshotPointer | null = null;
  private starting = false;
  private closing = false;
  private readonly channels = ["start", "state", "ready", "begin", "end", "cancel", "output", "target", "pending", "ack"];

  private reportSelectionError(session: CaptureSession, error: unknown): void {
    this.options.onError(error);
    if (this.active !== session || session.phase !== "selection") return;
    if (session.dragTimer) clearInterval(session.dragTimer);
    session.dragTimer = null;
    session.startPoint = null;
    session.selection = null;
    const message = error instanceof Error ? error.message : String(error);
    for (const window of session.windows.values()) {
      if (!window.isDestroyed()) window.webContents.send(CHANNEL + "update", { phase: "error", message } satisfies ScreenshotWindowUpdate);
    }
  }

  constructor(private readonly options: Options) {
    this.register();
  }

  private getPointer(): ScreenshotPointer {
    return this.pointer ??= new ScreenshotPointer();
  }

  private trustedCapture(event: IpcMainInvokeEvent): { session: CaptureSession; frame: ScreenshotFrame; window: BrowserWindow } {
    const current = this.active;
    const window = BrowserWindow.fromWebContents(event.sender);
    const frame = current?.frames.find((item) => current.windows.get(item.id) === window);
    if (!current || !window || !frame || event.senderFrame !== event.sender.mainFrame) {
      throw new Error("Untrusted screenshot request");
    }
    let url: URL;
    try { url = new URL(event.senderFrame.url); } catch { throw new Error("Untrusted screenshot page"); }
    if (url.origin !== this.options.origin.origin || url.pathname !== "/desktop-screenshot") {
      throw new Error("Untrusted screenshot page");
    }
    return { session: current, frame, window };
  }

  private register(): void {
    for (const name of this.channels) ipcMain.removeHandler(CHANNEL + name);
    ipcMain.handle(CHANNEL + "start", (event): Promise<{ ok: boolean; error?: string }> => {
      if (!this.options.trustedMain(event)) return Promise.resolve({ ok: false, error: "Untrusted screenshot request" });
      return this.start();
    });
    ipcMain.handle(CHANNEL + "target", (event, input: unknown): boolean => {
      if (!this.options.trustedMain(event) || !input || typeof input !== "object") return false;
      const value = input as { token?: unknown; draftKey?: unknown; available?: unknown };
      if (typeof value.token !== "string" || value.token.length < 1 || value.token.length > 100
        || typeof value.available !== "boolean") return false;
      if (value.draftKey === null) {
        if (this.target?.token === value.token) this.target = null;
        return true;
      }
      if (typeof value.draftKey !== "string" || !value.draftKey || value.draftKey.length > 1024
        || /[\u0000-\u001f\u007f]/.test(value.draftKey)) return false;
      this.target = { token: value.token, draftKey: value.draftKey, available: value.available };
      return true;
    });
    ipcMain.handle(CHANNEL + "state", (event): ScreenshotWindowState => {
      const { session, frame } = this.trustedCapture(event);
      return { captureId: session.id, displayId: frame.id, frame, targetDraftKey: session.targetDraftKey,
        update: session.editWindow === session.windows.get(frame.id) ? session.editUpdate : session.phase === "selection" ? { phase: "selection", bounds: session.selection } : null };
    });
    ipcMain.handle(CHANNEL + "ready", (event): boolean => {
      const { session, frame } = this.trustedCapture(event);
      session.ready.add(frame.id);
      session.readyWaiters.get(frame.id)?.();
      session.readyWaiters.delete(frame.id);
      return true;
    });
    ipcMain.handle(CHANNEL + "begin", (event): boolean => {
      const { session } = this.trustedCapture(event);
      if (session.phase !== "selection" || session.startPoint) return false;
      session.startPoint = this.physicalCursor();
      session.selection = null;
      session.dragTimer = setInterval(() => this.pollSelection(session), 16);
      return true;
    });
    ipcMain.handle(CHANNEL + "end", (event): boolean => {
      const { session } = this.trustedCapture(event);
      if (session.phase !== "selection" || !session.startPoint) return false;
      void this.finishSelection(session).catch((error) => this.reportSelectionError(session, error));
      return true;
    });
    ipcMain.handle(CHANNEL + "cancel", (event): boolean => {
      this.trustedCapture(event);
      this.close();
      return true;
    });
    ipcMain.handle(CHANNEL + "output", (event, input: unknown): Promise<ScreenshotOutputResult> => {
      const { session, window } = this.trustedCapture(event);
      return this.output(session, window, input);
    });
    ipcMain.handle(CHANNEL + "pending", (event): PendingScreenshotAttachment | null => (
      this.options.trustedMain(event) ? this.active?.pending ?? null : null
    ));
    ipcMain.handle(CHANNEL + "ack", (event, input: unknown): boolean => {
      if (!this.options.trustedMain(event) || !input || typeof input !== "object") return false;
      const { captureId, success, message } = input as Record<string, unknown>;
      const current = this.active;
      if (!current?.pending || captureId !== current.id || typeof success !== "boolean") return false;
      if (success) {
        this.close();
      } else {
        current.pending = null;
        current.phase = "editing";
        const window = current.editWindow;
        if (window && !window.isDestroyed()) {
          window.show();
          window.focus();
          window.webContents.send(CHANNEL + "update", {
            phase: "error",
            message: typeof message === "string" ? message.slice(0, 500) : "无法添加截图到聊天",
          } satisfies ScreenshotWindowUpdate);
        }
      }
      return true;
    });
  }

  private physicalCursor(): CapturePoint {
    return screen.dipToScreenPoint(screen.getCursorScreenPoint());
  }

  private async captureFrames(): Promise<ScreenshotFrame[]> {
    const displays = screen.getAllDisplays();
    if (!displays.length) throw new Error("没有可用的显示器");
    const physical = displays.map((display) => ({ display, bounds: screen.dipToScreenRect(null, display.bounds) }));
    const width = Math.max(...physical.map(({ bounds }) => bounds.width));
    const height = Math.max(...physical.map(({ bounds }) => bounds.height));
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width, height } });
    const assigned = new Map<string, typeof sources[number]>();
    const used = new Set<typeof sources[number]>();
    for (const { display } of physical) {
      const source = sources.find((item) => item.display_id === String(display.id) && !used.has(item));
      if (source) { assigned.set(String(display.id), source); used.add(source); }
    }
    const unmatched = physical.filter(({ display }) => !assigned.has(String(display.id)));
    const remaining = sources.filter((source) => !used.has(source));
    if (unmatched.length === 1 && remaining.length === 1) assigned.set(String(unmatched[0]!.display.id), remaining[0]!);
    else if (unmatched.length) throw new Error("无法匹配屏幕与截图来源");
    return physical.map(({ display, bounds }) => {
      const source = assigned.get(String(display.id));
      if (!source || source.thumbnail.isEmpty()) throw new Error(`无法截取显示器 ${display.id}`);
      const size = source.thumbnail.getSize();
      if (size.width < 1 || size.height < 1) throw new Error(`显示器 ${display.id} 返回了空图像`);
      return {
        id: String(display.id),
        dipBounds: display.bounds,
        physicalBounds: bounds,
        imageWidth: size.width,
        imageHeight: size.height,
        dataUrl: `data:image/png;base64,${source.thumbnail.toPNG().toString("base64")}`,
      };
    });
  }

  async start(): Promise<{ ok: boolean; error?: string }> {
    if (process.platform !== "win32") return { ok: false, error: "截图当前仅支持 Windows 桌面版" };
    if (this.active || this.starting) return { ok: false, error: "截图窗口已经打开" };
    this.starting = true;
    try {
      let frames: ScreenshotFrame[] | null = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try { frames = await this.captureFrames(); break; }
        catch (error) {
          if (attempt === 2) throw error;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 150 * (attempt + 1)));
        }
      }
      if (!frames) throw new Error("屏幕捕获失败");
      const session: CaptureSession = {
        id: randomUUID(), frames, windows: new Map(),
        targetDraftKey: this.target?.available ? this.target.draftKey : null,
        phase: "selection", startPoint: null, selection: null, dragTimer: null,
        editWindow: null, pending: null, ready: new Set(), readyWaiters: new Map(), editUpdate: null,
      };
      this.active = session;
      screen.on("display-removed", this.onDisplayChange);
      screen.on("display-metrics-changed", this.onDisplayChange);
      for (const frame of frames) {
        const window = new BrowserWindow({
          x: frame.dipBounds.x, y: frame.dipBounds.y,
          width: frame.dipBounds.width, height: frame.dipBounds.height,
          show: false, frame: false, transparent: false, resizable: false,
          movable: false, fullscreenable: false, skipTaskbar: true,
          alwaysOnTop: true, autoHideMenuBar: true, backgroundColor: "#111111",
          webPreferences: {
            preload: join(__dirname, "screenshot-preload.js"),
            partition: this.options.partition, sandbox: true, contextIsolation: true,
            nodeIntegration: false, webviewTag: false, webSecurity: true,
          },
        });
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        window.webContents.on("will-navigate", (event, url) => {
          try {
            const target = new URL(url);
            if (target.origin !== this.options.origin.origin || target.pathname !== "/desktop-screenshot") event.preventDefault();
          } catch { event.preventDefault(); }
        });
        window.webContents.on("render-process-gone", () => this.close());
        window.on("closed", () => { if (!this.closing && this.active === session) this.close(); });
        session.windows.set(frame.id, window);
      }
      await Promise.all([...session.windows.values()].map((window) => (
        window.loadURL(new URL("/desktop-screenshot", this.options.origin).toString())
      )));
      await Promise.all(frames.map((frame) => this.waitForReady(session, frame.id)));
      if (this.active !== session) throw new Error("截图已取消");
      for (const window of session.windows.values()) { window.show(); window.setAlwaysOnTop(true, "screen-saver"); }
      return { ok: true };
    } catch (error) {
      this.close();
      const message = error instanceof Error ? error.message : String(error);
      this.options.onError(error);
      return { ok: false, error: message };
    } finally {
      this.starting = false;
    }
  }

  private readonly onDisplayChange = () => this.close();

  private waitForReady(session: CaptureSession, displayId: string): Promise<void> {
    if (session.ready.has(displayId)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        session.readyWaiters.delete(displayId);
        reject(new Error(`截图窗口 ${displayId} 加载超时`));
      }, 20_000);
      session.readyWaiters.set(displayId, () => { clearTimeout(timeout); resolve(); });
    });
  }

  private pollSelection(session: CaptureSession): void {
    if (this.active !== session || session.phase !== "selection" || !session.startPoint) return;
    try {
      const current = this.physicalCursor();
      session.selection = rectFromPoints(session.startPoint, current);
      for (const window of session.windows.values()) {
        if (!window.isDestroyed()) window.webContents.send(CHANNEL + "update", { phase: "selection", bounds: session.selection } satisfies ScreenshotWindowUpdate);
      }
      if (!this.getPointer().leftButtonDown()) void this.finishSelection(session).catch((error) => this.reportSelectionError(session, error));
    } catch (error) {
      this.options.onError(error);
      this.close();
    }
  }

  private async finishSelection(session: CaptureSession): Promise<void> {
    if (this.active !== session || session.phase !== "selection" || !session.startPoint) return;
    if (session.dragTimer) clearInterval(session.dragTimer);
    session.dragTimer = null;
    const cursor = this.physicalCursor();
    let selection = rectFromPoints(session.startPoint, cursor);
    if (selection.width < 2 || selection.height < 2) {
      const frame = session.frames.find((item) => (
        cursor.x >= item.physicalBounds.x && cursor.x < item.physicalBounds.x + item.physicalBounds.width
        && cursor.y >= item.physicalBounds.y && cursor.y < item.physicalBounds.y + item.physicalBounds.height
      )) ?? session.frames[0];
      if (!frame) throw new Error("没有可用的显示器");
      selection = frame.physicalBounds;
    }
    const plan = planCaptureSelection(selection, session.frames);
    const firstTile = plan.tiles[0];
    if (!firstTile) throw new Error("选区不在任何屏幕上");
    const editorId = plan.tiles.length === 1
      ? firstTile.displayId
      : session.frames.find((item) => (
        cursor.x >= item.physicalBounds.x && cursor.x < item.physicalBounds.x + item.physicalBounds.width
        && cursor.y >= item.physicalBounds.y && cursor.y < item.physicalBounds.y + item.physicalBounds.height
      ))?.id ?? firstTile.displayId;
    if (!editorId) throw new Error("没有可用的截图编辑窗口");
    const editor = session.windows.get(editorId);
    if (!editor || editor.isDestroyed()) throw new Error("截图编辑窗口不可用");
    session.phase = "editing";
    session.selection = selection;
    session.editWindow = editor;
    for (const [id, window] of session.windows) if (id !== editorId && !window.isDestroyed()) window.hide();
    const update = {
      phase: "editing", selection, plan, frames: session.frames,
      targetDraftKey: session.targetDraftKey,
    } satisfies ScreenshotWindowUpdate;
    session.editUpdate = update;
    editor.webContents.send(CHANNEL + "update", update);
    editor.focus();
  }

  private async output(session: CaptureSession, window: BrowserWindow, input: unknown): Promise<ScreenshotOutputResult> {
    if (this.active !== session || session.phase !== "editing" || session.editWindow !== window) {
      return { status: "error", message: "截图编辑已结束" };
    }
    if (!input || typeof input !== "object") return { status: "error", message: "截图输出无效" };
    const value = input as { captureId?: unknown; action?: unknown; bytes?: unknown };
    if (value.captureId !== session.id || !["copy", "save", "attach"].includes(String(value.action))) {
      return { status: "error", message: "截图输出无效" };
    }
    if (!(value.bytes instanceof Uint8Array) || value.bytes.byteLength < 24 || value.bytes.byteLength > MAX_PNG_BYTES) {
      return { status: "error", message: "截图数据过大或无效" };
    }
    const png = Buffer.from(value.bytes);
    if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) return { status: "error", message: "只接受 PNG 截图" };
    const image = nativeImage.createFromBuffer(png);
    const size = image.getSize();
    if (image.isEmpty() || size.width < 1 || size.height < 1 || size.width * size.height > 100_000_000) {
      return { status: "error", message: "截图图像无效" };
    }
    const action = value.action as ScreenshotOutputAction;
    try {
      if (action === "copy") {
        clipboard.writeImage(image);
        this.close();
        return { status: "done" };
      }
      if (action === "save") {
        const date = new Date();
        const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}-${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}${String(date.getSeconds()).padStart(2, "0")}`;
        const result = await dialog.showSaveDialog(window, {
          defaultPath: `Piora-截图-${stamp}.png`, filters: [{ name: "PNG", extensions: ["png"] }],
        });
        if (result.canceled || !result.filePath) return { status: "cancelled" };
        await writeFile(result.filePath, png, { flag: "w" });
        this.close();
        return { status: "done" };
      }
      if (!session.targetDraftKey) return { status: "error", message: "请先打开可输入的聊天" };
      session.pending = { captureId: session.id, targetDraftKey: session.targetDraftKey, mimeType: "image/png", data: png.toString("base64") };
      session.phase = "pending";
      window.hide();
      if (!this.options.host.isDestroyed()) {
        this.options.host.show();
        this.options.host.focus();
        this.options.host.webContents.send(CHANNEL + "attachment", session.pending);
      }
      return { status: "pending" };
    } catch (error) {
      this.options.onError(error);
      return { status: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    const session = this.active;
    this.active = null;
    screen.off("display-removed", this.onDisplayChange);
    screen.off("display-metrics-changed", this.onDisplayChange);
    if (session?.dragTimer) clearInterval(session.dragTimer);
    if (session) for (const window of session.windows.values()) {
      if (!window.isDestroyed()) window.destroy();
    }
    this.closing = false;
  }

  dispose(): void {
    this.close();
    for (const name of this.channels) ipcMain.removeHandler(CHANNEL + name);
  }
}
