import { randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { copyFile, link, lstat, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { HarmonyError } from "./errors";
import { assertNewHarmonyLocalFileAllowed } from "./runtime/local-file-access";
import { assertHarmonySqliteSnapshotOwner, exportHarmonySqliteSnapshot, type HarmonySqliteExportOptions, validateHarmonySqliteExportOptions } from "./sqlite-inspector";

export interface HarmonyDatabaseExportJob {
  id: string;
  serial: string;
  source: string;
  format: "csv" | "json";
  range: "all" | "page";
  offset: number;
  encoding: HarmonySqliteExportOptions["encoding"];
  destinationPath?: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
  createdAt: string;
  updatedAt: string;
  bytes?: number;
  rows?: number;
  error?: string;
}

export interface HarmonyDatabaseExportInput {
  serial: string;
  snapshotId: string;
  source: string;
  table?: string;
  sql?: string;
  format: "csv" | "json";
  options: HarmonySqliteExportOptions;
  destinationPath?: string;
}

type ExportRunner = (input: HarmonyDatabaseExportInput, signal: AbortSignal) => Promise<{ stream: Readable; size: number; rows: number }>;
const MAX_JOBS = 100;
const MAX_STORED_BYTES = 512 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Persisted local jobs; snapshots and SQL stay in process memory and are never written to the journal. */
export class HarmonyDatabaseExportJobs {
  private readonly jobs = new Map<string, HarmonyDatabaseExportJob>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly activeDownloads = new Map<string, number>();
  private tail: Promise<void> | null = null;
  private readonly artifactDirectory: string;

  constructor(private readonly journalPath: string, private readonly runner: ExportRunner = async (input, signal) =>
    exportHarmonySqliteSnapshot(input.snapshotId, input.table, input.sql, input.format, input.options, signal)) {
    this.artifactDirectory = join(dirname(journalPath), "harmony-database-export-artifacts");
    mkdirSync(this.artifactDirectory, { recursive: true, mode: 0o700 });
    if (existsSync(journalPath)) {
      const info = lstatSync(journalPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new HarmonyError("INVALID_RESPONSE", "Invalid database export journal");
      const parsed = JSON.parse(readFileSync(journalPath, "utf8")) as HarmonyDatabaseExportJob[];
      if (!Array.isArray(parsed) || parsed.length > MAX_JOBS || parsed.some(job => !UUID.test(job?.id ?? "")
        || typeof job.serial !== "string" || !["queued", "running", "completed", "failed", "cancelled", "interrupted"].includes(job.status))) {
        throw new HarmonyError("INVALID_RESPONSE", "Invalid database export journal");
      }
      let changed = false;
      for (const job of parsed) {
        if (job.status === "queued" || job.status === "running") {
          job.status = "interrupted"; job.error = "Piora restarted before this export completed; start a new export from a fresh snapshot";
          job.updatedAt = new Date().toISOString(); changed = true;
        } else if (job.status === "completed" && !existsSync(this.artifactPath(job))) {
          job.status = "failed"; job.error = "The saved export is missing; export the snapshot again";
          job.updatedAt = new Date().toISOString(); changed = true;
        }
        this.jobs.set(job.id, job);
      }
      if (changed) this.persist();
    }
    for (const name of readdirSync(this.artifactDirectory)) {
      const owner = this.jobs.get(name.slice(0, 36));
      if (/^[0-9a-f-]{36}\.(?:part|csv|json)$/i.test(name)
        && (name.endsWith(".part") || !owner || owner.status !== "completed" || name !== `${owner.id}.${owner.format}`)) {
        try { unlinkSync(join(this.artifactDirectory, name)); } catch { /* A later cleanup can retry. */ }
      }
    }
  }

  private artifactPath(job: HarmonyDatabaseExportJob): string { return join(this.artifactDirectory, `${job.id}.${job.format}`); }

  private persist(): void {
    mkdirSync(dirname(this.journalPath), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(this.journalPath), `.harmony-database-exports-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify([...this.jobs.values()]), { flag: "wx", mode: 0o600 });
      renameSync(temporary, this.journalPath);
    } catch (error) {
      try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* Preserve the original error. */ }
      throw error;
    }
  }

  list(serial?: string): HarmonyDatabaseExportJob[] {
    return [...this.jobs.values()].filter(job => !serial || job.serial === serial)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(job => structuredClone(job));
  }

  async create(input: HarmonyDatabaseExportInput): Promise<HarmonyDatabaseExportJob> {
    if (!/^[A-Za-z0-9._:\[\]-]{1,256}$/.test(input.serial) || !UUID.test(input.snapshotId)
      || typeof input.source !== "string" || !input.source.trim() || input.source.length > 200
      || (input.format !== "csv" && input.format !== "json") || this.jobs.size >= MAX_JOBS
      || [...this.jobs.values()].filter(job => job.status === "queued" || job.status === "running").length >= 20
      || [...this.jobs.values()].reduce((sum, job) => sum + (job.status === "completed" ? job.bytes ?? 0 : 0), 0) > MAX_STORED_BYTES - 64 * 1024 * 1024) {
      throw new HarmonyError("INVALID_ARGUMENT", "Choose a valid database export; clear old jobs if storage is full");
    }
    validateHarmonySqliteExportOptions(input.format, input.options);
    assertHarmonySqliteSnapshotOwner(input.snapshotId, input.serial);
    if ((!!input.table) === (!!input.sql)) throw new HarmonyError("INVALID_ARGUMENT", "Choose a table or a read-only query to export");
    if (input.destinationPath !== undefined) {
      if (typeof input.destinationPath !== "string" || input.destinationPath.length > 4096) throw new HarmonyError("INVALID_ARGUMENT", "Choose a valid local target path");
      await assertNewHarmonyLocalFileAllowed(input.destinationPath);
    }
    const timestamp = new Date().toISOString();
    const job: HarmonyDatabaseExportJob = { id: randomUUID(), serial: input.serial, source: input.source.trim(), format: input.format,
      range: input.options.range, offset: input.options.offset, encoding: input.options.encoding,
      ...(input.destinationPath ? { destinationPath: input.destinationPath } : {}), status: "queued", createdAt: timestamp, updatedAt: timestamp };
    this.jobs.set(job.id, job);
    try { this.persist(); } catch (error) { this.jobs.delete(job.id); throw error; }
    const controller = new AbortController(); this.controllers.set(job.id, controller);
    const task = this.tail ? this.tail.catch(() => undefined).then(() => this.run(job, input, controller.signal)) : this.run(job, input, controller.signal);
    this.tail = task;
    void task.finally(() => { this.controllers.delete(job.id); if (this.tail === task) this.tail = null; }).catch(() => undefined);
    return structuredClone(job);
  }

  private async saveToWorkspace(job: HarmonyDatabaseExportJob, source: string, signal: AbortSignal): Promise<void> {
    const destination = job.destinationPath;
    if (!destination) return;
    await assertNewHarmonyLocalFileAllowed(destination);
    const staging = join(dirname(destination), `.piora-db-export-${job.id}.tmp`);
    try {
      await copyFile(source, staging, constants.COPYFILE_EXCL);
      if ((await stat(staging)).size !== job.bytes) throw new HarmonyError("INVALID_RESPONSE", "Export target size changed during copy");
      await assertNewHarmonyLocalFileAllowed(destination);
      if (signal.aborted) throw new HarmonyError("COMMAND_ABORTED", "Database export cancelled before publishing the target");
      await link(staging, destination);
    } finally { await rm(staging, { force: true }); }
  }

  private async run(job: HarmonyDatabaseExportJob, input: HarmonyDatabaseExportInput, signal: AbortSignal): Promise<void> {
    const artifact = this.artifactPath(job), partial = join(this.artifactDirectory, `${job.id}.part`);
    try {
      if (signal.aborted) return;
      job.status = "running"; job.updatedAt = new Date().toISOString(); this.persist();
      const exported = await this.runner(input, signal);
      await pipeline(exported.stream, createWriteStream(partial, { flags: "wx", mode: 0o600 }), { signal });
      if (signal.aborted) throw new HarmonyError("COMMAND_ABORTED", "Database export cancelled");
      if (!Number.isSafeInteger(exported.size) || exported.size < 1 || exported.size > 64 * 1024 * 1024
        || !Number.isSafeInteger(exported.rows) || exported.rows < 0 || (await stat(partial)).size !== exported.size) {
        throw new HarmonyError("INVALID_RESPONSE", "Database export size or row count could not be verified");
      }
      job.bytes = exported.size; job.rows = exported.rows;
      await rename(partial, artifact);
      await this.saveToWorkspace(job, artifact, signal);
      job.status = "completed";
    } catch (error) {
      job.status = signal.aborted ? "cancelled" : "failed";
      job.error = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      delete job.bytes; delete job.rows;
      await rm(artifact, { force: true }).catch(() => undefined);
    } finally {
      await rm(partial, { force: true }).catch(() => undefined);
      job.updatedAt = new Date().toISOString();
      try { this.persist(); } catch { /* Keep live state; the next mutation reports persistence failure. */ }
    }
  }

  cancel(id: string, serial: string): HarmonyDatabaseExportJob {
    const job = this.jobs.get(id);
    if (!job || job.serial !== serial) throw new HarmonyError("INVALID_ARGUMENT", "Database export job was not found for this device");
    if (job.status === "queued" || job.status === "running") {
      this.controllers.get(id)?.abort();
      if (job.status === "queued") job.status = "cancelled";
      job.updatedAt = new Date().toISOString(); this.persist();
    }
    return structuredClone(job);
  }

  async remove(id: string, serial: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job || job.serial !== serial) throw new HarmonyError("INVALID_ARGUMENT", "Database export job was not found for this device");
    if (job.status === "queued" || job.status === "running") throw new HarmonyError("DEVICE_BUSY", "Cancel and settle the export before removing its record");
    if (this.activeDownloads.get(id)) throw new HarmonyError("DEVICE_BUSY", "Wait for the export download to finish before removing its record");
    this.jobs.delete(id);
    try { this.persist(); } catch (error) { this.jobs.set(id, job); throw error; }
    await rm(this.artifactPath(job), { force: true });
  }

  async openDownload(id: string, serial: string): Promise<{ stream: Readable; size: number; filename: string; encoding: HarmonyDatabaseExportJob["encoding"]; format: HarmonyDatabaseExportJob["format"] }> {
    const job = this.jobs.get(id);
    if (!job || job.serial !== serial || job.status !== "completed" || !job.bytes) throw new HarmonyError("INVALID_ARGUMENT", "Completed export was not found for this device");
    const file = this.artifactPath(job), info = await lstat(file).catch(() => {
      throw new HarmonyError("STALE_SNAPSHOT", "Saved export is missing or changed");
    });
    if (!info.isFile() || info.isSymbolicLink() || info.size !== job.bytes) throw new HarmonyError("STALE_SNAPSHOT", "Saved export is missing or changed");
    const stream = createReadStream(file);
    this.activeDownloads.set(id, (this.activeDownloads.get(id) ?? 0) + 1);
    stream.once("close", () => { const remaining = (this.activeDownloads.get(id) ?? 1) - 1; if (remaining) this.activeDownloads.set(id, remaining); else this.activeDownloads.delete(id); });
    return { stream, size: info.size, filename: `harmony-database-${job.id.slice(0, 8)}.${job.format}`,
      encoding: job.encoding, format: job.format };
  }
}
