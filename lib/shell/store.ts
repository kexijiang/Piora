import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { CommandBlock, HistoryQuery, HistoryRecord, ShellRun, ShellSession } from "./types";

export function shellDataDirectory(): string { return join(getAgentDir(), "piora", "shell"); }
export function shellAssetPath(name: string): string {
  const root = process.env.PIORA_WEB_RUNTIME_ROOT?.trim() || process.cwd();
  const unpacked = root.endsWith(".asar") ? `${root}.unpacked` : root;
  const candidates = [join(unpacked, "shell-runtime", name), join(unpacked, "lib", "shell", "runtime", name)];
  const found = candidates.find(existsSync);
  if (!found) throw new Error(`Missing Shell runtime asset: ${name}`);
  return found;
}

export class ShellStore {
  private worker: Worker;
  private sequence = 0;
  private failure: Error | null = null;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  readonly ready: Promise<unknown>;

  constructor(directory = shellDataDirectory(), recover = true) {
    this.worker = new Worker(shellAssetPath("store-worker.cjs"), { workerData: { directory } });
    this.worker.on("message", (message: { id: number; result?: unknown; error?: string }) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
      if (!this.pending.size) this.worker.unref();
    });
    const fail = (error: Error) => { this.failure = error; for (const request of this.pending.values()) request.reject(error); this.pending.clear(); };
    this.worker.on("error", fail);
    this.worker.on("exit", code => fail(new Error(`Shell database worker exited (${code})`)));
    this.worker.unref();
    this.ready = recover ? this.call("recover") : Promise.resolve();
    // Preserve the rejected readiness for callers without an unhandled rejection.
    void this.ready.catch(() => {});
  }
  call<T = unknown>(op: string, args: unknown = {}): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    this.worker.ref();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject });
      this.worker.postMessage({ id, op, args });
    });
  }
  async put(kind: "session" | "command" | "run" | "transcript", id: string, data: unknown, parent?: string): Promise<void> {
    await this.ready; await this.call("putEntity", { kind, id, data, parent });
  }
  async get<T>(kind: string, id: string): Promise<T | null> { await this.ready; return this.call("getEntity", { kind, id }); }
  async list<T>(kind: string, parent?: string, limit = 100, offset = 0): Promise<T[]> { await this.ready; return this.call("listEntities", { kind, parent, limit, offset }); }
  async history(query: HistoryQuery): Promise<{ records: HistoryRecord[]; hasMore: boolean }> { await this.ready; return this.call("queryHistory", query); }
  async recordHistory(records: HistoryRecord[]): Promise<void> { await this.ready; await this.call("historyUpsert", { records }); }
  async accept(terminalId: string, requestId: string, fingerprint: string, kind: "command" | "run", entity: CommandBlock | ShellRun) {
    await this.ready;
    return this.call<{ accepted: boolean; kind: "command" | "run"; id: string }>("accept", { terminalId, requestId, fingerprint, kind, id: entity.id, parent: terminalId, data: entity });
  }
  async close(): Promise<void> { await this.ready; await this.call("close"); await this.worker.terminate(); }
}
declare global { var __pioraShellStore: ShellStore | undefined }
export function getShellStore(): ShellStore { return globalThis.__pioraShellStore ??= new ShellStore(); }
export type PersistedShellEntity = ShellSession | ShellRun | CommandBlock;
