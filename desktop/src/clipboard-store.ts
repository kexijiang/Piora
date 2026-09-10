import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ClipboardDatabase } from "./clipboard-database.js";
import type { ClipboardCapture, ClipboardMutation, ClipboardQuery } from "./clipboard-types.js";

/** All archive I/O and SQL stay off Electron's UI / native-event thread. */
export class ClipboardStore {
  private worker!: Worker;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private nextId = 0;
  private ready!: Promise<void>;
  private dead: Error | null = null;
  private generation = 0;
  private exports = new Set<Promise<void>>();
  private snapshotIds = new Set<string>();
  private closing: Promise<void> | null = null;
  private closed = false;
  private restarting: Promise<void> | null = null;
  private failureListeners = new Set<(error: Error) => void>();
  constructor(private directory: string, private snapshot = false) { this.spawn(); }
  get failure() { return this.dead; }
  onFailure(listener: (error: Error) => void) { this.failureListeners.add(listener); return () => { this.failureListeners.delete(listener); }; }
  private spawn() {
    const generation = ++this.generation;
    this.dead = null;
    let readyResolve!: () => void, readyReject!: (error: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    // Startup can fail before the owner has reached start(). It remains rejected
    // for callers without becoming a process-level unhandled rejection.
    void this.ready.catch(() => {});
    const fail = (error: Error) => {
      if (generation !== this.generation || this.dead) return;
      this.dead = error; readyReject(error);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      if (!this.closed) for (const listener of this.failureListeners) listener(error);
    };
    try { this.worker = new Worker(join(__dirname, "clipboard-worker.js"), { workerData: { directory: this.directory, snapshot: this.snapshot } }); }
    catch { fail(new Error("剪贴板存储进程无法启动，请重新连接存储。")); return; }
    this.worker.on("message", (response: { ready?: boolean; id?: number; error?: string; result?: unknown }) => {
      if (generation !== this.generation || this.dead) return;
      if (response.ready !== undefined) { if (response.ready) readyResolve(); else fail(new Error(response.error || "剪贴板数据库无法打开。")); return; }
      if (response.id === undefined) return;
      const pending = this.pending.get(response.id); if (!pending) return;
      this.pending.delete(response.id);
      if (response.error) pending.reject(new Error(response.error)); else pending.resolve(response.result);
    });
    this.worker.on("error", () => fail(new Error("剪贴板存储连接中断，未确认的操作不会自动重放。请重新连接后检查最近记录。")));
    this.worker.on("exit", () => fail(new Error("剪贴板存储连接中断，未确认的操作不会自动重放。请重新连接后检查最近记录。")));
  }
  async start() { await this.ready; if (this.dead) throw this.dead; }
  reconnect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("剪贴板存储正在关闭。"));
    if (this.restarting) return this.restarting;
    if (!this.dead) return this.start();
    return this.restarting = (async () => {
      // Existing exports own independent snapshot workers. Let them settle before
      // replacing the live connection; no admitted write is retried here.
      await Promise.allSettled([...this.exports]);
      await this.worker?.terminate();
      if (this.closed) throw new Error("剪贴板存储正在关闭。");
      this.spawn(); await this.start();
      // Clean only snapshots requested by this store instance, after their
      // independent export workers have settled. Unknown directories are kept.
      await this.cleanSnapshots();
    })().finally(() => { this.restarting = null; });
  }
  private async request<T>(method: string, value?: unknown): Promise<T> {
    if (this.closed && method !== "close" && method !== "remove-snapshot") throw new Error("剪贴板存储正在关闭。");
    const worker = this.worker, generation = this.generation;
    await this.ready;
    if (this.dead) throw this.dead;
    if (generation !== this.generation) throw new Error("剪贴板存储连接已更换，请重新执行此操作。");
    const limit = ["cancel-query", "close", "remove-snapshot"].includes(method) ? 272 : 256;
    if (this.pending.size >= limit) throw new Error("剪贴板存储请求过多，请稍后重试。");
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject });
      try { worker.postMessage({ id, method, value }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  query(value: ClipboardQuery = {}, scope?: string) { return this.request<ReturnType<ClipboardDatabase["query"]>>("query", { query: value, scope }); }
  cancelQuery(scope: string, requestId?: number) { return this.request<void>("cancel-query", { scope, requestId }); }
  detail(id: string) { return this.request<ReturnType<ClipboardDatabase["detail"]>>("detail", id); }
  status() { return this.request<ReturnType<ClipboardDatabase["status"]>>("status"); }
  settings() { return this.request<ReturnType<ClipboardDatabase["settings"]>>("settings"); }
  capture(value: ClipboardCapture) { return this.request<string>("capture", value); }
  mutate(value: ClipboardMutation) { return this.request<ReturnType<ClipboardDatabase["mutate"]>>("mutate", value); }
  asset(id: string) { return this.request<ReturnType<ClipboardDatabase["assetForClip"]>>("asset", id); }
  prune() { return this.request<void>("prune"); }
  importArchive(file: string) { return this.request<{ imported: number; merged: number; warnings: string[] }>("import", file); }
  exportArchive(file: string): Promise<void> {
    const operation = (async () => {
      const id = randomUUID(); this.snapshotIds.add(id);
      const directory = await this.request<string>("snapshot", id);
      const snapshot = new ClipboardStore(directory, true);
      try { await snapshot.request<void>("export", file); }
      finally { try { await snapshot.close(); } finally { await this.request<void>("remove-snapshot", id); this.snapshotIds.delete(id); } }
    })();
    this.exports.add(operation); void operation.finally(() => this.exports.delete(operation)).catch(() => {});
    return operation;
  }
  private async cleanSnapshots() {
    for (const id of this.snapshotIds) {
      try { await this.request<void>("remove-snapshot", id); this.snapshotIds.delete(id); }
      catch { /* Keep a failed cleanup for the next orderly close. Never replace the database. */ }
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    return this.closing = (async () => {
      await this.restarting?.catch(() => {});
      await Promise.allSettled([...this.exports]);
      try { if (!this.dead) { await this.cleanSnapshots(); await this.request<void>("close"); } }
      finally { await this.worker?.terminate(); this.failureListeners.clear(); }
    })();
  }
}
