import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { statSync } from "node:fs";
import type * as Koffi from "koffi" with { "resolution-mode": "import" };
import type { ClipboardFile, ClipboardOperationResult, ClipboardSource } from "./clipboard-types.js";

export interface ClipboardNativeWindow {
  getNativeWindowHandle(): Buffer;
  hookWindowMessage(message: number, callback: () => void): void;
  unhookWindowMessage(message: number): void;
}
interface Target { token: string; handle: bigint; pid: number; source: ClipboardSource }
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Win32 calls are intentionally private to the desktop process; no arbitrary FFI bridge. */
export class WindowsClipboard {
  // Keep FFI loading inside ClipboardRuntime's guarded Windows initialization.
  // A missing platform binding must not prevent polling/history from starting.
  // Koffi's CommonJS entrypoint has ESM declarations.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  private readonly koffi: typeof Koffi = require("koffi");
  private user = this.koffi.load("user32.dll");
  private kernel = this.koffi.load("kernel32.dll");
  private shell = this.koffi.load("shell32.dll");
  private foreground = this.user.func("void * __stdcall GetForegroundWindow()");
  private owner = this.user.func("void * __stdcall GetClipboardOwner()");
  private sequence = this.user.func("uint32_t __stdcall GetClipboardSequenceNumber()");
  private addListener = this.user.func("int __stdcall AddClipboardFormatListener(void *hwnd)");
  private removeListener = this.user.func("int __stdcall RemoveClipboardFormatListener(void *hwnd)");
  private processId = this.user.func("uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)");
  private openProcess = this.kernel.func("void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)");
  private processImage = this.kernel.func("int __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, _Out_ uint8_t *name, _Inout_ uint32_t *size)");
  private closeHandle = this.kernel.func("int __stdcall CloseHandle(void *handle)");
  private isWindow = this.user.func("int __stdcall IsWindow(void *hwnd)");
  private isIconic = this.user.func("int __stdcall IsIconic(void *hwnd)");
  private showWindow = this.user.func("int __stdcall ShowWindowAsync(void *hwnd, int command)");
  private setForeground = this.user.func("int __stdcall SetForegroundWindow(void *hwnd)");
  private keyState = this.user.func("int16_t __stdcall GetAsyncKeyState(int key)");
  private sendInput = this.user.func("uint32_t __stdcall SendInput(uint32_t count, const void *input, int size)");
  private openClipboard = this.user.func("int __stdcall OpenClipboard(void *hwnd)");
  private closeClipboard = this.user.func("int __stdcall CloseClipboard()");
  private emptyClipboard = this.user.func("int __stdcall EmptyClipboard()");
  private getData = this.user.func("void * __stdcall GetClipboardData(uint32_t format)");
  private formatAvailable = this.user.func("int __stdcall IsClipboardFormatAvailable(uint32_t format)");
  private setData = this.user.func("void * __stdcall SetClipboardData(uint32_t format, void *memory)");
  private registerFormat = this.user.func("uint32_t __stdcall RegisterClipboardFormatW(const char16_t *name)");
  private dragQuery = this.shell.func("uint32_t __stdcall DragQueryFileW(void *drop, uint32_t index, _Out_ uint8_t *file, uint32_t count)");
  private globalAlloc = this.kernel.func("void * __stdcall GlobalAlloc(uint32_t flags, size_t bytes)");
  private globalLock = this.kernel.func("void * __stdcall GlobalLock(void *memory)");
  private globalUnlock = this.kernel.func("int __stdcall GlobalUnlock(void *memory)");
  private globalFree = this.kernel.func("void * __stdcall GlobalFree(void *memory)");
  private rect = this.user.func("int __stdcall GetWindowRect(void *hwnd, _Out_ int32_t *rect)");
  private unhookEvent = this.user.func("int __stdcall UnhookWinEvent(void *hook)");
  private eventCallback: bigint | null = null;
  private eventHook: bigint | null = null;
  private listening: { window: ClipboardNativeWindow; handle: bigint } | null = null;
  private excluded = new Set<bigint>();
  private lastTarget: Omit<Target, "token"> | null = null;
  private targets = new Map<string, Target>();
  private sourceCache = new Map<number, { source: ClipboardSource; until: number }>();

  handle(window: ClipboardNativeWindow): bigint {
    const buffer = window.getNativeWindowHandle(); return buffer.length === 8 ? buffer.readBigUInt64LE() : BigInt(buffer.readUInt32LE());
  }
  exclude(window: ClipboardNativeWindow) { const handle = this.handle(window); this.excluded.add(handle); return () => this.excluded.delete(handle); }
  currentSequence(): number { return Number(this.sequence()); }
  isForeground(window: ClipboardNativeWindow): boolean { return this.foreground() === this.handle(window); }
  hasFiles(): boolean { return Boolean(this.formatAvailable(15)); }
  private pid(handle: bigint): number { const output = [0]; this.processId(handle, output); return output[0] ?? 0; }
  private sourceFor(handle: bigint): ClipboardSource {
    const pid = this.pid(handle), cached = this.sourceCache.get(pid);
    if (cached && cached.until > Date.now()) return cached.source;
    const process = this.openProcess(0x1000, 0, pid);
    if (!process) return { name: "未知应用", executable: "" };
    try {
      const output = Buffer.alloc(65536), length = [32768];
      if (!this.processImage(process, 0, output, length)) return { name: "未知应用", executable: "" };
      const executable = output.subarray(0, (length[0] ?? 0) * 2).toString("utf16le");
      const source = { executable, name: basename(executable).replace(/\.exe$/i, "") };
      if (this.sourceCache.size > 200) this.sourceCache.clear(); this.sourceCache.set(pid, { source, until: Date.now() + 30_000 }); return source;
    } finally { this.closeHandle(process); }
  }
  clipboardSource(): ClipboardSource {
    const handle = this.owner() as bigint | null;
    // The foreground window may have changed since copying. An absent owner
    // means unknown provenance, not permission to attribute its data elsewhere.
    return this.sourceFor(handle || BigInt(0));
  }
  observeForeground() {
    const handle = this.foreground() as bigint | null;
    if (handle && !this.excluded.has(handle) && this.isWindow(handle)) this.lastTarget = { handle, pid: this.pid(handle), source: this.sourceFor(handle) };
  }
  startForegroundTracking() {
    if (this.eventHook) return;
    const callback = this.koffi.proto("void __stdcall PioraClipboardForeground(void *hook, uint32_t event, void *window, int32_t object, int32_t child, uint32_t thread, uint32_t time)");
    this.eventCallback = this.koffi.register(() => this.observeForeground(), this.koffi.pointer(callback));
    const setHook = this.user.func("void * __stdcall SetWinEventHook(uint32_t first, uint32_t last, void *module, void *callback, uint32_t process, uint32_t thread, uint32_t flags)");
    this.eventHook = setHook(3, 3, null, this.eventCallback, 0, 0, 0) as bigint | null;
    this.observeForeground();
  }
  listen(window: ClipboardNativeWindow, onChange: () => void): boolean {
    if (this.listening) this.stopListener();
    const handle = this.handle(window);
    window.hookWindowMessage(0x031d, onChange);
    if (!this.addListener(handle)) { window.unhookWindowMessage(0x031d); return false; }
    this.listening = { window, handle }; return true;
  }
  private stopListener() {
    if (!this.listening) return;
    this.removeListener(this.listening.handle); this.listening.window.unhookWindowMessage(0x031d); this.listening = null;
  }
  target(): { token: string; name: string; bounds: { x: number; y: number; width: number; height: number } | null } | null {
    this.observeForeground();
    if (!this.lastTarget || !this.isWindow(this.lastTarget.handle) || this.pid(this.lastTarget.handle) !== this.lastTarget.pid) return null;
    const target = { ...this.lastTarget, token: randomUUID() };
    if (this.targets.size >= 20) this.targets.delete(this.targets.keys().next().value!);
    this.targets.set(target.token, target);
    const rectangle = [0, 0, 0, 0];
    const bounds = this.rect(target.handle, rectangle) ? { x: rectangle[0]!, y: rectangle[1]!, width: rectangle[2]! - rectangle[0]!, height: rectangle[3]! - rectangle[1]! } : null;
    return { token: target.token, name: target.source.name, bounds };
  }
  targetName(token?: string): string | null { return token ? this.targets.get(token)?.source.name ?? null : this.lastTarget?.source.name ?? null; }
  async paste(token: string | undefined, hide: () => void): Promise<ClipboardOperationResult> {
    const target = token ? this.targets.get(token) : undefined;
    if (!target) return { status: "no-target", message: "已复制，未找到可粘贴窗口。请回到目标应用手动粘贴。" };
    const valid = () => Boolean(this.isWindow(target.handle) && this.pid(target.handle) === target.pid && !this.excluded.has(target.handle));
    if (!valid()) return { status: "target-lost", message: "已复制，原窗口已关闭或发生变化。" };
    hide();
    if (this.isIconic(target.handle)) this.showWindow(target.handle, 9);
    this.setForeground(target.handle);
    const deadline = Date.now() + 400;
    while (Date.now() < deadline && this.foreground() !== target.handle) await wait(15);
    if (!valid() || this.foreground() !== target.handle) return { status: "target-lost", message: "已复制，无法恢复原窗口焦点，请手动粘贴。" };
    const modifiers = [0x10, 0x11, 0x12, 0x5b, 0x5c];
    while (Date.now() < deadline && modifiers.some(key => (this.keyState(key) & 0x8000) !== 0)) await wait(15);
    if (modifiers.some(key => (this.keyState(key) & 0x8000) !== 0)) return { status: "modifiers-held", message: "已复制，请松开修饰键后再粘贴。" };
    if (!valid() || this.foreground() !== target.handle) return { status: "target-lost", message: "焦点已改变，已停止自动粘贴。内容仍在剪贴板。" };
    const size = process.arch === "ia32" ? 28 : 40, keyboard = process.arch === "ia32" ? 4 : 8;
    const buffer = Buffer.alloc(size * 4);
    [[0x11, 0], [0x56, 0], [0x56, 2], [0x11, 2]].forEach(([key, flags], index) => {
      const offset = size * index; buffer.writeUInt32LE(1, offset); buffer.writeUInt16LE(key!, offset + keyboard); buffer.writeUInt32LE(flags!, offset + keyboard + 4);
    });
    const sent = Number(this.sendInput(4, buffer, size));
    if (sent !== 4) {
      // A partial insertion may have delivered Ctrl-down or V-down. Release
      // only keys this sequence could have pressed; never leave Ctrl latched.
      if (sent > 0) {
        const release = Buffer.alloc(size * (sent >= 2 ? 2 : 1));
        const keys = sent >= 2 ? [0x56, 0x11] : [0x11];
        keys.forEach((key, index) => { const offset = index * size; release.writeUInt32LE(1, offset); release.writeUInt16LE(key, offset + keyboard); release.writeUInt32LE(2, offset + keyboard + 4); });
        this.sendInput(keys.length, release, size);
      }
      return { status: "input-blocked", message: "已复制，系统未完成粘贴按键输入。目标应用可能需要更高权限，请手动粘贴。" };
    }
    return { status: "input-sent", message: "已向原窗口发送粘贴操作。" };
  }
  readFiles(): ClipboardFile[] {
    if (!this.openClipboard(null)) throw new Error("系统剪贴板正被占用。");
    try {
      const drop = this.getData(15); if (!drop) return [];
      const count = Number(this.dragQuery(drop, 0xffffffff, null, 0));
      if (count > 1000) throw new Error("单次文件数量超过 1000，已跳过。");
      const files: ClipboardFile[] = [];
      for (let i = 0; i < count; i++) {
        const length = Number(this.dragQuery(drop, i, null, 0));
        if (length > 32767) throw new Error("文件路径过长。");
        const buffer = Buffer.alloc((length + 1) * 2); this.dragQuery(drop, i, buffer, length + 1);
        const path = buffer.subarray(0, length * 2).toString("utf16le");
        let directory = false; try { directory = statSync(path).isDirectory(); } catch { /* Keep missing references visible. */ }
        files.push({ path, name: basename(path), directory });
      }
      return files;
    } finally { this.closeClipboard(); }
  }
  private writeMemory(format: number, data: Buffer) {
    const memory = this.globalAlloc(0x42, data.length); if (!memory) throw new Error("剪贴板内存分配失败。");
    let owned = true;
    try {
      const pointer = this.globalLock(memory); if (!pointer) throw new Error("剪贴板内存不可写。");
      try { this.koffi.encode(pointer, "uint8_t", data, data.length); } finally { this.globalUnlock(memory); }
      if (!this.setData(format, memory)) throw new Error("写入系统剪贴板失败。");
      owned = false;
    } finally { if (owned) this.globalFree(memory); }
  }
  writeFiles(paths: string[], owner: ClipboardNativeWindow) {
    if (!paths.length || paths.length > 1000 || paths.some(path => typeof path !== "string" || path.includes("\0"))) throw new Error("文件集合无效。");
    const names = Buffer.from(paths.join("\0") + "\0\0", "utf16le"), drop = Buffer.alloc(20 + names.length);
    drop.writeUInt32LE(20, 0); drop.writeUInt32LE(1, 16); names.copy(drop, 20);
    if (!this.openClipboard(this.handle(owner))) throw new Error("系统剪贴板正被占用，请重试。");
    try {
      if (!this.emptyClipboard()) throw new Error("系统剪贴板不可写。");
      this.writeMemory(15, drop);
      const effect = Buffer.alloc(4); effect.writeUInt32LE(1); this.writeMemory(Number(this.registerFormat("Preferred DropEffect")), effect);
    } finally { this.closeClipboard(); }
  }
  close() {
    this.stopListener();
    if (this.eventHook) this.unhookEvent(this.eventHook);
    if (this.eventCallback) this.koffi.unregister(this.eventCallback);
    this.eventHook = null; this.eventCallback = null; this.targets.clear();
  }
}
