import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HarmonyError } from "./errors";
import type { HarmonyFileScope } from "./device-files";

export type HarmonyTransferInput =
  | { direction: "download"; path: string; destinationPath: string }
  | { direction: "upload"; sourcePath: string; path: string; overwrite: boolean };
export type HarmonyTransferItem = HarmonyTransferInput & {
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
  size?: number;
  error?: string;
  effect?: "unknown";
};
export interface HarmonyTransferJob {
  id: string;
  serial: string;
  scope: HarmonyFileScope;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
  createdAt: string;
  updatedAt: string;
  completedItems: number;
  totalItems: number;
  completedBytes: number;
  items: HarmonyTransferItem[];
  error?: string;
}

type TransferRunner = (job: HarmonyTransferJob, item: HarmonyTransferInput, leaseToken: string | undefined, signal: AbortSignal) => Promise<{ size: number }>;
type LeaseHooks = { renew: (token: string) => void; release: (token: string) => void };
const MAX_JOBS = 500;

/** A process-owned queue with an atomic local journal; bearer tokens are never persisted. */
export class HarmonyTransferJobs {
  private readonly jobs = new Map<string, HarmonyTransferJob>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly serialTails = new Map<string, Promise<void>>();
  private readonly renewalTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly jobLeaseTokens = new Map<string, string>();

  private releaseJobLease(id: string): void {
    const token = this.jobLeaseTokens.get(id);
    if (!token) return;
    this.jobLeaseTokens.delete(id);
    this.leaseHooks?.release(token);
  }

  constructor(private readonly journalPath: string, private readonly runner: TransferRunner, private readonly leaseHooks?: LeaseHooks) {
    if (!existsSync(journalPath)) return;
    const info = lstatSync(journalPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new HarmonyError("INVALID_RESPONSE", "Invalid Harmony transfer journal");
    const parsed = JSON.parse(readFileSync(journalPath, "utf8")) as HarmonyTransferJob[];
    if (!Array.isArray(parsed) || parsed.length > MAX_JOBS || parsed.some(job => typeof job?.id !== "string" || !Array.isArray(job.items))) {
      throw new HarmonyError("INVALID_RESPONSE", "Invalid Harmony transfer journal");
    }
    let changed = false;
    for (const job of parsed) {
      if (job.status === "running" || job.status === "queued") {
        job.status = "interrupted"; job.error = "Piora restarted before this transfer finished; inspect both sides before retrying";
        for (const item of job.items) if (item.status === "running" || item.status === "queued") {
          item.status = "interrupted";
          if (item.direction === "upload") item.effect = "unknown";
        }
        job.updatedAt = new Date().toISOString(); changed = true;
      }
      this.jobs.set(job.id, job);
    }
    if (changed) this.persist();
  }

  private persist(): void {
    mkdirSync(dirname(this.journalPath), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(this.journalPath), `.harmony-transfers-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify([...this.jobs.values()]), { flag: "wx", mode: 0o600 });
      renameSync(temporary, this.journalPath);
    } catch (error) {
      try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* Preserve the original write error. */ }
      throw error;
    }
  }

  list(serial?: string): HarmonyTransferJob[] {
    return [...this.jobs.values()].filter(job => !serial || job.serial === serial).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(job => structuredClone(job));
  }

  create(serial: string, scope: HarmonyFileScope, items: HarmonyTransferInput[], leaseToken?: string, id = randomUUID()): HarmonyTransferJob {
    if (!/^[A-Za-z0-9._:\[\]-]{1,256}$/.test(serial) || !items.length || items.length > 20 || this.jobs.size >= MAX_JOBS
      || (items.some(item => item.direction === "upload") && !leaseToken)) {
      throw new HarmonyError("INVALID_ARGUMENT", "Choose a device and 1–20 transfers; uploads require device control (maximum 500 saved jobs)");
    }
    const timestamp = new Date().toISOString();
    const job: HarmonyTransferJob = { id, serial, scope, status: "queued", createdAt: timestamp, updatedAt: timestamp,
      completedItems: 0, totalItems: items.length, completedBytes: 0, items: items.map(item => ({ ...item, status: "queued" })) };
    this.jobs.set(job.id, job);
    try { this.persist(); }
    catch (error) { this.jobs.delete(job.id); throw error; }
    const controller = new AbortController(); this.controllers.set(job.id, controller);
    if (leaseToken && this.leaseHooks) {
      this.jobLeaseTokens.set(job.id, leaseToken);
      const timer = setInterval(() => {
        try { this.leaseHooks?.renew(leaseToken); }
        catch (error) {
          job.error = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
          controller.abort();
          try { this.persist(); } catch { /* Final task settlement retries persistence. */ }
        }
      }, 60_000);
      timer.unref?.(); this.renewalTimers.set(job.id, timer);
    }
    const previous = this.serialTails.get(serial) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(() => this.run(job, leaseToken, controller.signal));
    this.serialTails.set(serial, task);
    void task.finally(() => {
      this.controllers.delete(job.id);
      const timer = this.renewalTimers.get(job.id);
      if (timer) { clearInterval(timer); this.renewalTimers.delete(job.id); }
      this.releaseJobLease(job.id);
      if (this.serialTails.get(serial) === task) this.serialTails.delete(serial);
    }).catch(() => undefined);
    return structuredClone(job);
  }

  cancel(id: string): HarmonyTransferJob {
    const job = this.jobs.get(id);
    if (!job) throw new HarmonyError("INVALID_ARGUMENT", "Transfer job was not found");
    if (job.status === "queued" || job.status === "running") {
      this.controllers.get(id)?.abort();
      if (job.status === "queued") {
        job.status = "cancelled";
        for (const item of job.items) item.status = "cancelled";
        const timer = this.renewalTimers.get(id);
        if (timer) { clearInterval(timer); this.renewalTimers.delete(id); }
        // A queued job owns no active device call, so control can be released now.
        this.releaseJobLease(id);
      }
      job.updatedAt = new Date().toISOString(); this.persist();
    }
    return structuredClone(job);
  }

  remove(id: string): void {
    const job = this.jobs.get(id);
    if (!job) throw new HarmonyError("INVALID_ARGUMENT", "Transfer job was not found");
    if (job.status === "queued" || job.status === "running") throw new HarmonyError("DEVICE_BUSY", "Cancel and settle the transfer before removing its history");
    this.jobs.delete(id);
    try { this.persist(); } catch (error) { this.jobs.set(id, job); throw error; }
  }

  private async run(job: HarmonyTransferJob, leaseToken: string | undefined, signal: AbortSignal): Promise<void> {
    try {
      if (!signal.aborted) { job.status = "running"; job.updatedAt = new Date().toISOString(); this.persist(); }
      for (const item of job.items) {
        if (signal.aborted) break;
        item.status = "running"; job.updatedAt = new Date().toISOString(); this.persist();
        try {
          const result = await this.runner(job, item, leaseToken, signal);
          if (signal.aborted) {
            item.status = "interrupted";
            if (item.direction === "upload") item.effect = "unknown";
            break;
          }
          if (!Number.isSafeInteger(result.size) || result.size < 0) throw new HarmonyError("INVALID_RESPONSE", "Transfer returned an invalid byte count");
          item.status = "completed"; item.size = result.size;
          job.completedItems += 1; job.completedBytes += result.size;
          job.updatedAt = new Date().toISOString(); this.persist();
        } catch (error) {
          item.status = signal.aborted ? "interrupted" : "failed";
          item.error = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
          if (item.direction === "upload") item.effect = "unknown";
          if (!signal.aborted) job.error = item.error;
          break;
        }
      }
      if (signal.aborted) job.status = job.error ? "failed" : "cancelled";
      else job.status = job.error ? "failed" : "completed";
      for (const item of job.items) if (item.status === "queued") item.status = signal.aborted ? "cancelled" : "interrupted";
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      for (const item of job.items) if (item.status === "queued" || item.status === "running") item.status = "interrupted";
    } finally {
      job.updatedAt = new Date().toISOString();
      try { this.persist(); } catch { /* Live state stays visible; failure is surfaced by the next mutation. */ }
    }
  }
}
