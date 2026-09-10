import { randomUUID } from "node:crypto";

type Pending = { resolve: (id: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
declare global { var __pioraClipboardBackupRequests: { pending: Map<string, Pending>; listening: boolean } | undefined; }
const runtime = globalThis.__pioraClipboardBackupRequests ??= { pending: new Map(), listening: false };

/** Server ↔ desktop process transport. No clipboard content crosses this message channel. */
export function requestDesktopClipboardBackup(): Promise<string> {
  if (typeof process.send !== "function") return Promise.reject(new Error("backup_clipboard_unavailable"));
  if (!runtime.listening) {
    runtime.listening = true;
    process.on("message", (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const value = message as { type?: unknown; requestId?: unknown; ok?: unknown; snapshotId?: unknown; error?: unknown };
      if (value.type !== "pi-desktop:clipboard-backup-response" || typeof value.requestId !== "string") return;
      const pending = runtime.pending.get(value.requestId); if (!pending) return;
      clearTimeout(pending.timer); runtime.pending.delete(value.requestId);
      if (value.ok === true && value.snapshotId === value.requestId) pending.resolve(value.requestId);
      else pending.reject(new Error(typeof value.error === "string" ? value.error : "backup_clipboard_unavailable"));
    });
    process.on("disconnect", () => { for (const item of runtime.pending.values()) { clearTimeout(item.timer); item.reject(new Error("backup_clipboard_unavailable")); } runtime.pending.clear(); });
  }
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { runtime.pending.delete(requestId); reject(new Error("backup_clipboard_timeout")); }, 300_000); timer.unref();
    runtime.pending.set(requestId, { resolve, reject, timer });
    try { process.send!({ type: "pi-desktop:clipboard-backup-request", requestId }); }
    catch (error) { clearTimeout(timer); runtime.pending.delete(requestId); reject(error); }
  });
}
