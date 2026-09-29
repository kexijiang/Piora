import { Worker } from "node:worker_threads";
import { copyFile, lstat, mkdtemp, open, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "../file-access";
import { HarmonyError } from "./errors";

export interface HarmonySqliteResult {
  tables: string[];
  views?: string[];
  table?: string;
  columns?: string[];
  fields?: Array<{ name: string; type: string; notNull: boolean; primaryKey: number }>;
  indexes?: Array<{ name: string; unique: boolean }>;
  sql?: string;
  rows?: Array<Array<string | number | null | { blobHex: string; size: number; truncated: boolean }>>;
  offset?: number;
  hasMore?: boolean;
}

interface SqliteSnapshot { directory: string; path: string; expiresAt: number; inFlight: number; closed: boolean; timer?: ReturnType<typeof setTimeout> }
const SNAPSHOT_TTL_MS = 10 * 60_000;
const MAX_SNAPSHOTS = 8;
const snapshotStore = globalThis as typeof globalThis & { __pioraHarmonySqliteSnapshots?: Map<string, SqliteSnapshot> };
const snapshots = snapshotStore.__pioraHarmonySqliteSnapshots ??= new Map<string, SqliteSnapshot>();

function workerPath(): string {
  const root = process.env.PIORA_WEB_RUNTIME_ROOT?.trim() || process.cwd();
  const unpacked = root.endsWith(".asar") ? `${root}.unpacked` : root;
  const candidates = [join(unpacked, "lib", "harmony", "runtime", "sqlite-inspector.cjs"), join(unpacked, "harmony-runtime", "sqlite-inspector.cjs")];
  const found = candidates.find(existsSync);
  if (!found) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Packaged SQLite inspector is missing");
  return found;
}

async function inspectCopy(path: string, table: string | undefined, offset: number, sql?: string): Promise<HarmonySqliteResult> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const worker = new Worker(workerPath(), { workerData: { path, table, offset, sql }, resourceLimits: { maxOldGenerationSizeMb: 96 } });
    let settled = false;
    const finish = (error?: Error, result?: HarmonySqliteResult) => {
      if (settled) return;
      settled = true; clearTimeout(timer); void worker.terminate();
      if (error) rejectPromise(error); else resolvePromise(result!);
    };
    const timer = setTimeout(() => finish(new HarmonyError("COMMAND_TIMEOUT", "SQLite inspection exceeded 5 seconds")), 5_000);
    worker.once("message", (message: HarmonySqliteResult & { error?: string }) => message.error
      ? finish(new HarmonyError("INVALID_RESPONSE", `SQLite inspection failed: ${message.error}`)) : finish(undefined, message));
    worker.once("error", error => finish(new HarmonyError("INVALID_RESPONSE", "SQLite inspection worker failed", { cause: error })));
    worker.once("exit", code => { if (code !== 0) finish(new HarmonyError("INVALID_RESPONSE", "SQLite inspection worker exited")); });
  });
}

async function privateCopy(path: string): Promise<{ directory: string; snapshot: string }> {
  if (typeof path !== "string" || path.length > 4096 || !isAbsolute(path) || !isExistingFilePathAllowed(path, await getAllowedFileRoots())) {
    throw new HarmonyError("INVALID_ARGUMENT", "Choose an existing database in an allowed workspace");
  }
  const source = await lstat(path);
  if (!source.isFile() || source.isSymbolicLink() || source.size < 100 || source.size > 64 * 1024 * 1024) {
    throw new HarmonyError("INVALID_ARGUMENT", "Choose a regular SQLite database no larger than 64 MiB");
  }
  const wal = await lstat(`${path}-wal`).catch(() => undefined);
  if (wal) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "A WAL sidecar exists; export a consistent database snapshot before inspection");
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(16);
    if ((await file.read(header, 0, 16, 0)).bytesRead !== 16 || !header.equals(Buffer.from("SQLite format 3\0"))) {
      throw new HarmonyError("INVALID_ARGUMENT", "File is not a SQLite 3 database");
    }
  } finally { await file.close(); }
  const directory = await mkdtemp(join(tmpdir(), "piora-harmony-sqlite-"));
  try {
    const snapshot = join(directory, "snapshot.db");
    await copyFile(path, snapshot);
    const after = await stat(path);
    if (after.size !== source.size || after.mtimeMs !== source.mtimeMs || (await stat(snapshot)).size !== source.size) {
      throw new HarmonyError("STALE_SNAPSHOT", "Database changed while the private copy was created");
    }
    return { directory, snapshot };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

function validateRead(table: string | undefined, offset: number, sql?: string): void {
  if (table !== undefined && (typeof table !== "string" || !table || table.length > 256)) throw new HarmonyError("INVALID_ARGUMENT", "Choose a valid table");
  if (!Number.isInteger(offset) || offset < 0 || offset > (sql ? 800 : 10_000)) throw new HarmonyError("INVALID_ARGUMENT", "Database offset is outside the allowed range");
  if (sql !== undefined && (typeof sql !== "string" || sql.length > 4096 || !/^\s*(?:SELECT|WITH)\b/i.test(sql) || /[;\0]/.test(sql))) {
    throw new HarmonyError("INVALID_ARGUMENT", "Enter one read-only SELECT or WITH query without a semicolon");
  }
  if (sql && table) throw new HarmonyError("INVALID_ARGUMENT", "Choose a table or a query, not both");
}

async function cleanupSnapshot(id: string, item: SqliteSnapshot): Promise<void> {
  item.closed = true;
  if (item.timer) clearTimeout(item.timer);
  snapshots.delete(id);
  if (!item.inFlight) await rm(item.directory, { recursive: true, force: true });
}

/** Freeze an allowed workspace database into a private, read-only inspection session. */
export async function openHarmonySqliteSnapshot(path: string): Promise<{ id: string; result: HarmonySqliteResult }> {
  for (const [id, item] of snapshots) if (item.closed || item.expiresAt <= Date.now()) await cleanupSnapshot(id, item);
  if (snapshots.size >= MAX_SNAPSHOTS) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Close an open database before opening another");
  const { directory, snapshot } = await privateCopy(path);
  const id = randomUUID();
  const item: SqliteSnapshot = { directory, path: snapshot, expiresAt: Date.now() + SNAPSHOT_TTL_MS, inFlight: 0, closed: false };
  snapshots.set(id, item);
  try {
    const result = await readHarmonySqliteSnapshot(id);
    item.timer = setTimeout(() => { void cleanupSnapshot(id, item); }, SNAPSHOT_TTL_MS);
    item.timer.unref();
    return { id, result };
  } catch (error) { await cleanupSnapshot(id, item); throw error; }
}

export async function readHarmonySqliteSnapshot(id: string, table?: string, offset = 0, sql?: string): Promise<HarmonySqliteResult> {
  validateRead(table, offset, sql);
  const item = snapshots.get(id);
  if (!item || item.closed || item.expiresAt <= Date.now()) {
    if (item) await cleanupSnapshot(id, item);
    throw new HarmonyError("STALE_SNAPSHOT", "Database snapshot expired; open it again");
  }
  item.inFlight++;
  try { return await inspectCopy(item.path, table, offset, sql); }
  finally {
    item.inFlight--;
    if (item.closed && !item.inFlight) await rm(item.directory, { recursive: true, force: true });
  }
}

export async function closeHarmonySqliteSnapshot(id: string): Promise<void> {
  const item = snapshots.get(id);
  if (item) await cleanupSnapshot(id, item);
}

/** Compatibility helper for existing callers: a private copy is still removed after each read. */
export async function inspectHarmonySqlite(path: string, table?: string, offset = 0, sql?: string): Promise<HarmonySqliteResult> {
  validateRead(table, offset, sql);
  const { directory, snapshot } = await privateCopy(path);
  try { return await inspectCopy(snapshot, table, offset, sql); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
