import { createHash } from "node:crypto";
import { join } from "node:path";
import { clipboard, nativeImage, powerMonitor, type BrowserWindow } from "electron";
import { ClipboardStore } from "./clipboard-store.js";
import { WindowsClipboard } from "./clipboard-windows.js";
import { ClipboardDragFiles } from "./clipboard-drag-files.js";
import { CLIPBOARD_PAYLOAD_LIMIT, DEFAULT_CLIPBOARD_SETTINGS, type ClipboardCapture, type ClipboardChange, type ClipboardDetail, type ClipboardMutation, type ClipboardOperation, type ClipboardOperationResult, type ClipboardSettings, type ClipboardStatus } from "./clipboard-types.js";

const fingerprint = (input: ClipboardCapture) => createHash("sha256").update(JSON.stringify({ ...input, image: input.image ? createHash("sha256").update(input.image).digest("hex") : undefined, source: undefined })).digest("hex");
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export class ClipboardRuntime {
  readonly store: ClipboardStore;
  private dragCache: ClipboardDragFiles;
  native: WindowsClipboard | null = null;
  shortcut: string | null = null;
  private settings: ClipboardSettings = { ...DEFAULT_CLIPBOARD_SETTINGS };
  private listener: ClipboardStatus["listener"] = "unavailable";
  private locked = false;
  private error = "";
  private nativeError = "";
  private skipped = 0;
  private full = false;
  private stopped = false;
  private initialized = false;
  private starting: Promise<void> | null = null;
  private reconnecting: Promise<void> | null = null;
  private cachedStatus: Awaited<ReturnType<ClipboardStore["status"]>> | null = null;
  private lastSequence = -1;
  private lastFingerprint = "";
  private admittedBytes = 0;
  private pending = new Set<Promise<unknown>>();
  private operationTail: Promise<unknown> = Promise.resolve();
  private mutationTail: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(change: ClipboardChange) => void>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private notification: ReturnType<typeof setTimeout> | undefined;
  private notificationReason: ClipboardChange["reason"] = "status";
  private revision = 0;
  private captureEpoch = 0;
  private host: BrowserWindow | null = null;
  private lastHousekeeping = Date.now();
  private lock = () => { this.locked = true; this.captureEpoch++; this.emit("status"); };
  private unlock = () => { this.locked = false; this.captureEpoch++; this.resetBaseline(); this.emit("status"); };
  constructor(readonly directory: string) {
    this.store = new ClipboardStore(directory); this.dragCache = new ClipboardDragFiles(join(directory, "drag"));
    this.store.onFailure(() => { this.captureEpoch++; this.resetBaseline(); this.emit("status"); });
  }
  async start(host: BrowserWindow) {
    if (this.stopped) throw new Error("剪贴板存储正在关闭。");
    this.host = host;
    if (this.initialized) return;
    return this.starting ??= this.startRuntime(host).finally(() => { this.starting = null; });
  }
  private async startRuntime(host: BrowserWindow) {
    await this.store.start(); this.settings = await this.store.settings();
    this.cachedStatus = await this.store.status(); this.revision = this.cachedStatus.revision;
    if (process.platform === "win32") {
      try {
        this.native = new WindowsClipboard(); this.native.startForegroundTracking();
        this.listener = this.native.listen(host, () => { void this.capture(false).catch(() => {}); }) ? "native" : "polling";
      } catch (cause) { this.nativeError = `原生剪贴板监听未启用，已降级采样：${cause instanceof Error ? cause.message : String(cause)}`; this.listener = "polling"; }
    } else this.listener = "polling";
    this.resetBaseline();
    powerMonitor.on("lock-screen", this.lock); powerMonitor.on("unlock-screen", this.unlock);
    this.timer = setInterval(() => {
      if (this.listener === "polling") void this.capture(false).catch(() => {});
      if (Date.now() - this.lastHousekeeping > 60_000) {
        this.lastHousekeeping = Date.now();
        void Promise.all([this.store.prune(), this.dragCache.clean()]).catch(cause => { this.error = String(cause); this.emit("status"); });
      }
    }, 500);
    this.initialized = true;
    await this.dragCache.clean().catch(() => { this.error = "临时拖拽文件清理失败，稍后将重试。"; });
  }
  reconnect(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("剪贴板存储正在关闭。"));
    if (this.reconnecting) return this.reconnecting;
    if (!this.store.failure && this.initialized) return Promise.resolve();
    this.captureEpoch++; this.resetBaseline();
    const task = (async () => {
      await Promise.allSettled([...this.pending, this.mutationTail, this.operationTail]);
      if (this.stopped) throw new Error("剪贴板存储正在关闭。");
      await this.store.reconnect();
      if (!this.initialized && this.host) await this.start(this.host);
      this.settings = await this.store.settings(); this.cachedStatus = await this.store.status();
      this.revision = this.cachedStatus.revision; this.full = this.cachedStatus.budgetState === "full"; this.error = "";
      this.emit("mutation");
    })().finally(() => { this.reconnecting = null; this.captureEpoch++; this.resetBaseline(); this.emit("status"); });
    this.reconnecting = task; this.emit("status"); return task;
  }
  private resetBaseline() {
    this.lastSequence = this.native?.currentSequence() ?? -1;
    // Polling environments deliberately establish their baseline without recording it.
    this.lastFingerprint = "";
  }
  subscribe(listener: (change: ClipboardChange) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(reason: ClipboardChange["reason"]) {
    if (this.stopped) return;
    const priority = { status: 0, open: 1, capture: 2, mutation: 3 };
    if (!this.notification || priority[reason] > priority[this.notificationReason]) this.notificationReason = reason;
    if (this.notification) return;
    this.notification = setTimeout(() => {
      this.notification = undefined;
      for (const listener of this.listeners) listener({ reason: this.notificationReason, revision: this.revision });
    }, 16);
  }
  async status(targetToken?: string): Promise<ClipboardStatus> {
    if (!this.store.failure && !this.reconnecting) {
      try { this.cachedStatus = await this.store.status(); } catch (error) { if (!this.store.failure) throw error; }
    }
    const stored = this.cachedStatus ?? { settings: this.settings, total: 0, trash: 0, shelf: 0, bytes: 0, budgetState: "ok" as const, revision: 0, sources: [], migrationWarnings: [], backupBytes: 0, databaseBytes: 0 };
    const storage = this.reconnecting ? "recovering" : this.store.failure ? "failed" : "ready";
    return { ...stored, storage, listener: this.listener, locked: this.locked, error: this.store.failure?.message ?? (this.error || this.nativeError), skipped: this.skipped,
      shortcut: this.shortcut, target: this.native?.targetName(targetToken) ?? null, canPaste: storage === "ready" && Boolean(this.native), canDrag: storage === "ready",
      budgetState: this.full || stored.budgetState === "full" ? "full" : stored.budgetState };
  }
  private snapshot(): ClipboardCapture | null {
    const formats = clipboard.availableFormats();
    if (formats.some(f => /password|concealed|transient|excludeclipboardcontentfrommonitorprocessing/i.test(f))) return null;
    const source = this.native?.clipboardSource() ?? { name: "", executable: "" };
    // Unknown provenance cannot establish that an application exclusion is
    // satisfied. Preserve that rule when native source lookup is unavailable.
    if (this.settings.excludedApps.length && !source.executable) return null;
    if (this.settings.excludedApps.some(rule => rule.toLocaleLowerCase() === source.executable.toLocaleLowerCase() || rule.toLocaleLowerCase() === source.name.toLocaleLowerCase())) return null;
    const fileFormat = this.native?.hasFiles() || formats.some(f => /hdrop|filenamew|cf_hdrop|text\/uri-list/i.test(f));
    if (fileFormat && !this.settings.captureFiles) return null;
    const input: ClipboardCapture = { source };
    if (this.settings.captureFiles && this.native) { const files = this.native.readFiles(); if (files.length) input.files = files; }
    if (this.settings.captureText) {
      const text = clipboard.readText(), html = clipboard.readHTML(), rtf = clipboard.readRTF();
      if (text) input.text = text; if (html) input.html = html; if (rtf) input.rtf = rtf;
    }
    if (this.settings.captureImages && formats.some(f => /image|bitmap|dib|png/i.test(f))) {
      const image = clipboard.readImage();
      if (!image.isEmpty()) {
        const size = image.getSize();
        if (size.width * size.height > 100_000_000) throw new Error("图片尺寸超过采集上限，已跳过。");
        input.image = image.toPNG(); input.width = size.width; input.height = size.height;
      }
    }
    return input.text || input.html || input.rtf || input.image || input.files?.length ? input : null;
  }
  async capture(manual: boolean): Promise<void> {
    if (this.store.failure || this.reconnecting) { if (manual) throw this.store.failure ?? new Error("正在重新连接剪贴板存储，请稍后再试。"); return; }
    if (this.stopped || this.locked) { if (manual) throw new Error("请解锁后再收录。"); return; }
    if (!manual && (!this.settings.enabled || this.full)) return;
    const epoch = this.captureEpoch;
    let persisted = false;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const sequence = this.native?.currentSequence() ?? -1;
        if (!manual && this.native && sequence === this.lastSequence) return;
        const input = this.snapshot();
        if (this.native && sequence !== this.native.currentSequence()) { await delay(10); continue; }
        if (epoch !== this.captureEpoch || this.stopped || this.locked) return;
        this.lastSequence = sequence;
        if (!input) { if (manual) throw new Error("没有可收录的内容，或来源应用禁止记录。"); return; }
        const identity = fingerprint(input);
        // On Windows the sequence identifies a copy action: copying identical
        // content again must still update its timestamp and copy count.
        if (!manual && !this.native && (!this.lastFingerprint || identity === this.lastFingerprint)) { this.lastFingerprint = identity; return; }
        this.lastFingerprint = identity;
        const bytes = (input.image?.byteLength ?? 0) + Buffer.byteLength(input.text ?? "") + Buffer.byteLength(input.html ?? "") + Buffer.byteLength(input.rtf ?? "");
        if (this.admittedBytes + bytes > 128 * 1024 ** 2) throw new Error("剪贴板写入队列繁忙，已跳过本条。现有历史未受影响。");
        this.admittedBytes += bytes;
        const operation = this.store.capture(input).then(async () => {
          persisted = true;
          const state = await this.store.status(); this.revision = state.revision; this.full = this.full || state.budgetState === "full"; if (!this.full) this.error = ""; this.emit("capture");
        }).finally(() => { this.admittedBytes -= bytes; });
        this.pending.add(operation);
        try { await operation; } finally { this.pending.delete(operation); }
        return;
      } catch (cause) {
        lastError = cause;
        if (String(cause).includes("正被占用") && attempt < 2) { await delay(20); continue; }
        break;
      }
    }
    this.error = lastError instanceof Error ? lastError.message : "复制内容变化过快，未取得一致快照。";
    if (this.error.includes("空间预算")) this.full = true;
    if (!persisted && !this.store.failure) this.skipped++;
    this.emit("status");
    if (manual) throw new Error(this.error);
  }
  mutate(value: ClipboardMutation) {
    const operation = this.mutationTail.then(() => this.performMutation(value));
    this.mutationTail = operation.then(() => {}, () => {});
    return operation;
  }
  private async performMutation(value: ClipboardMutation) {
    const transition = value?.type === "settings";
    const previous = this.settings;
    if (transition) { this.captureEpoch++; this.settings = { ...previous, enabled: false }; await Promise.allSettled([...this.pending]); }
    try {
      const result = await this.store.mutate(value);
      this.settings = await this.store.settings();
      if (transition) this.resetBaseline();
      const stored = await this.store.status(); this.revision = stored.revision; this.full = stored.budgetState === "full"; this.error = ""; this.emit("mutation");
      return result;
    } catch (cause) { if (transition) this.settings = previous; throw cause; }
  }
  private validateOperation(value: ClipboardOperation) {
    if (!value || !Array.isArray(value.ids) || !value.ids.length || value.ids.length > 1000 || value.ids.some(id => typeof id !== "string" || id.length > 128)) throw new Error("选择的记录无效。");
    if (value.plain !== undefined && typeof value.plain !== "boolean") throw new Error("粘贴格式无效。");
    if (value.separator !== undefined && (typeof value.separator !== "string" || value.separator.length > 100)) throw new Error("分隔符最多 100 字符。");
    if (value.targetToken !== undefined && typeof value.targetToken !== "string") throw new Error("目标无效。");
  }
  async details(ids: string[]) {
    this.validateOperation({ ids });
    const result: ClipboardDetail[] = []; let bytes = 0;
    for (const id of ids) {
      const entry = await this.store.detail(id);
      bytes += entry.bytes;
      if (bytes > CLIPBOARD_PAYLOAD_LIMIT) throw new Error("所选内容合计超过 64 MiB，请减少选择的记录。");
      result.push(entry);
    }
    return result;
  }
  private async dragFiles(entries: ClipboardDetail[], cancelled: () => boolean = () => false): Promise<string[]> {
    const result: string[] = [];
    for (const entry of entries) {
      if (cancelled()) return [];
      if (entry.deletedAt !== null && entry.shelfOrder === null) throw new Error("请先恢复最近删除中的记录。");
      if (entry.kind === "files") {
        if (entry.files.some(file => !file.exists)) throw new Error("部分源文件已不存在。请在预览中检查文件后重新选择。");
        result.push(...entry.files.map(file => file.path));
      } else if (entry.kind === "image" && entry.image) {
        const asset = await this.store.asset(entry.id);
        if (cancelled()) return [];
        result.push(await this.dragCache.image(asset.asset.hash, asset.path));
      } else throw new Error("文字不能与图片或文件合并为文件集合。");
    }
    const files = [...new Set(result)];
    if (files.length > 1000) throw new Error("合并后的文件集合超过 1000 个，请减少选择。");
    return files;
  }
  async prepareDrag(ids: string[], cancelled: () => boolean = () => false) { return this.dragFiles(await this.details(ids), cancelled); }
  protectDragFiles(files: string[]) { this.dragCache.protect(files); }
  retainDragFiles(files: string[]) { this.dragCache.retain(files); }
  async importArchive(file: string) {
    const result = await this.store.importArchive(file);
    const state = await this.store.status(); this.revision = state.revision; this.full = state.budgetState === "full"; this.emit("mutation");
    return result;
  }
  private async write(value: ClipboardOperation): Promise<void> {
    this.validateOperation(value);
    const entries = await this.details(value.ids), first = entries[0]!;
    if (entries.some(entry => entry.deletedAt !== null && entry.shelfOrder === null)) throw new Error("请先恢复最近删除中的记录。");
    const mergedText = () => {
      const separator = value.separator ?? "\n";
      if (entries.reduce((size, entry) => size + Buffer.byteLength(entry.text ?? ""), Buffer.byteLength(separator) * (entries.length - 1)) > CLIPBOARD_PAYLOAD_LIMIT) throw new Error("合并文字超过 64 MiB，请减少选择。");
      return entries.map(entry => entry.text ?? "").join(separator);
    };
    if (value.plain) {
      if (entries.some(e => e.text === null)) throw new Error("所选内容没有纯文本表示。");
      clipboard.writeText(mergedText());
    } else if (entries.length === 1 && first.kind !== "files") {
      const data: Electron.Data = {};
      if (first.text !== null) data.text = first.text;
      if (first.html !== null) data.html = first.html;
      if (first.rtf !== null) data.rtf = first.rtf;
      if (first.image) { const asset = await this.store.asset(first.id); data.image = nativeImage.createFromPath(asset.path); if (data.image.isEmpty()) throw new Error("图片内容损坏。"); }
      clipboard.write(data);
    } else if (entries.every(e => e.kind === "text" || e.kind === "link")) {
      clipboard.writeText(mergedText());
    } else {
      if (!this.native || !this.host) throw new Error("当前平台不支持文件集合写入剪贴板，可以拖出文件使用。");
      this.native.writeFiles(await this.dragFiles(entries), this.host);
    }
    this.lastSequence = this.native?.currentSequence() ?? -1;
    // Native events caused by the write cannot run until this turn yields.
    if (!this.native) { try { const input = this.snapshot(); this.lastFingerprint = input ? fingerprint(input) : ""; } catch { this.lastFingerprint = ""; } }
  }
  operate(value: ClipboardOperation, paste: boolean, hide: () => void): Promise<ClipboardOperationResult> {
    const operation = this.operationTail.then(async () => {
      await this.write(value);
      if (!paste) return { status: "copied" as const, message: "已复制。" };
      if (!this.native) return { status: "no-target" as const, message: "已复制；当前平台请手动粘贴。" };
      return this.native.paste(value.targetToken, hide);
    });
    this.operationTail = operation.catch(() => {}); return operation;
  }
  async stop() {
    this.stopped = true; this.captureEpoch++; clearInterval(this.timer); if (this.notification) clearTimeout(this.notification);
    powerMonitor.removeListener("lock-screen", this.lock); powerMonitor.removeListener("unlock-screen", this.unlock);
    await this.operationTail; await this.mutationTail; this.native?.close(); await Promise.allSettled([...this.pending]); await this.dragCache.close(); await this.store.close();
  }
}
