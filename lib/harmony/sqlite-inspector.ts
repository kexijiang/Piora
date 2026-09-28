import { Worker } from "node:worker_threads";
import { copyFile, lstat, mkdtemp, open, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "../file-access";
import { HarmonyError } from "./errors";

export interface HarmonySqliteResult {
  tables: string[];
  table?: string;
  columns?: string[];
  rows?: Array<Array<string | number | null | { blobHex: string; size: number; truncated: boolean }>>;
  offset?: number;
  hasMore?: boolean;
}

function workerPath(): string {
  const root = process.env.PIORA_WEB_RUNTIME_ROOT?.trim() || process.cwd();
  const unpacked = root.endsWith(".asar") ? `${root}.unpacked` : root;
  const candidates = [join(unpacked, "lib", "harmony", "runtime", "sqlite-inspector.cjs"), join(unpacked, "harmony-runtime", "sqlite-inspector.cjs")];
  const found = candidates.find(existsSync);
  if (!found) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Packaged SQLite inspector is missing");
  return found;
}

async function inspectCopy(path: string, table: string | undefined, offset: number): Promise<HarmonySqliteResult> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const worker = new Worker(workerPath(), { workerData: { path, table, offset }, resourceLimits: { maxOldGenerationSizeMb: 96 } });
    let settled = false;
    const finish = (error?: Error, result?: HarmonySqliteResult) => {
      if (settled) return;
      settled = true; clearTimeout(timer); void worker.terminate();
      if (error) rejectPromise(error); else resolvePromise(result!);
    };
    const timer = setTimeout(() => finish(new HarmonyError("COMMAND_TIMEOUT", "SQLite inspection exceeded 3 seconds")), 3_000);
    worker.once("message", (message: HarmonySqliteResult & { error?: string }) => message.error
      ? finish(new HarmonyError("INVALID_RESPONSE", `SQLite inspection failed: ${message.error}`)) : finish(undefined, message));
    worker.once("error", error => finish(new HarmonyError("INVALID_RESPONSE", "SQLite inspection worker failed", { cause: error })));
    worker.once("exit", code => { if (code !== 0) finish(new HarmonyError("INVALID_RESPONSE", "SQLite inspection worker exited")); });
  });
}

/** Read an existing workspace database through a bounded private copy. This never writes to the source. */
export async function inspectHarmonySqlite(path: string, table?: string, offset = 0): Promise<HarmonySqliteResult> {
  if (typeof path !== "string" || path.length > 4096 || !isAbsolute(path) || !isExistingFilePathAllowed(path, await getAllowedFileRoots())) {
    throw new HarmonyError("INVALID_ARGUMENT", "Choose an existing database in an allowed workspace");
  }
  if (table !== undefined && (typeof table !== "string" || !table || table.length > 256)) throw new HarmonyError("INVALID_ARGUMENT", "Choose a valid table");
  if (!Number.isInteger(offset) || offset < 0 || offset > 10_000) throw new HarmonyError("INVALID_ARGUMENT", "Database offset must be between 0 and 10000");
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
    return await inspectCopy(snapshot, table, offset);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
