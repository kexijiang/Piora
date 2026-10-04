import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, posix } from "node:path";
import { getHarmonyDeviceManager } from "./index";
import type { HarmonyDeviceFile, HarmonyFileScope } from "./device-files";
import { HarmonyError, isHarmonyError } from "./errors";
import { openHarmonySqliteTrustedSnapshot } from "./sqlite-inspector";

export type DatabaseScanStatus = "pending" | "scanning" | "ready" | "empty" | "inaccessible";
export interface DiscoveredDatabase { id: string; identity: string; name: string; size?: number; modifiedAt?: number; status?: "unavailable"; reason?: string }
export interface ApplicationDatabases { bundleName: string; label?: string; status: DatabaseScanStatus; databases: DiscoveredDatabase[]; reason?: string }
interface PrivateDatabase extends DiscoveredDatabase { path: string; bundleName: string }
interface Catalog {
  serial: string; startedAt: string; completedAt?: string; scanning: boolean;
  apps: ApplicationDatabases[]; paths: Map<string, PrivateDatabase>; abort: AbortController; cancelled?: boolean;
}
const shared = globalThis as typeof globalThis & { __pioraDeviceDatabaseCatalogs?: Map<string, Catalog> };
const catalogs = shared.__pioraDeviceDatabaseCatalogs ??= new Map<string, Catalog>();
const MAX_DIRECTORY_VISITS = 18;
const MAX_DATABASES_PER_APP = 80;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const ROOTS = ["el2", "el1", "el3", "el4"].flatMap(level => [
  `data/storage/${level}/database`, `data/storage/${level}/base/database`,
]);
const FILE_ROOTS = ["data/storage/el2/base/files", "data/storage/el2/files", "data/storage/el1/base/files"];
const MODULE_FILE_ROOTS = ["data/storage/el2/base/haps", "data/storage/el1/base/haps"];

function reason(error: unknown): string {
  if (isHarmonyError(error)) {
    if (error.code === "COMMAND_FAILED") return "应用沙箱不可访问：请确认应用使用调试签名且已启动";
    return error.message;
  }
  return "应用数据库目录扫描失败";
}

function missing(error: unknown): boolean {
  return isHarmonyError(error) && error.details?.reason === "missing";
}

function likelySqlite(file: HarmonyDeviceFile, standardDirectory: boolean): boolean {
  if (file.kind !== "file" || /-(?:wal|shm|journal)$/i.test(file.name)) return false;
  const namedDatabase = /\.(?:db|sqlite|sqlite3|rdb)$/i.test(file.name);
  const unnamedDatabase = standardDirectory && !file.name.includes(".");
  return namedDatabase || unnamedDatabase || (standardDirectory && (file.size ?? 0) >= 100 && (file.size ?? 0) <= MAX_SNAPSHOT_BYTES);
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function scanApplication(catalog: Catalog, app: ApplicationDatabases): Promise<void> {
  const manager = getHarmonyDeviceManager();
  const scope: HarmonyFileScope = { kind: "sandbox", bundleName: app.bundleName };
  const found: PrivateDatabase[] = [];
  const visited = new Set<string>();
  let failure: string | undefined;
  let truncation = false;
  const identity = (path: string) => createHash("sha256").update(catalog.serial).update("\0").update(app.bundleName).update("\0").update(path).digest("hex").slice(0, 24);
  const visit = async (path: string, depth: number, standard: boolean, modules = false): Promise<void> => {
    if (catalog.abort.signal.aborted || visited.has(path)) return;
    if (visited.size >= MAX_DIRECTORY_VISITS || found.length >= MAX_DATABASES_PER_APP) { truncation = true; return; }
    visited.add(path);
    try {
      const listing = await manager.listFiles(catalog.serial, scope, path, catalog.abort.signal);
      if (listing.truncated) truncation = true;
      for (const file of listing.files) {
        if (modules) break;
        if (found.length >= MAX_DATABASES_PER_APP) { truncation = true; break; }
        if (!likelySqlite(file, standard)) continue;
        const size = file.size;
        if (size === undefined || !Number.isSafeInteger(size) || size < 100 || size > MAX_SNAPSHOT_BYTES) {
          if (standard || /\.(?:db|sqlite|sqlite3|rdb)$/i.test(file.name)) found.push({ id: randomUUID(), identity: identity(file.path), path: file.path,
            name: file.name, size, modifiedAt: file.modifiedAt, bundleName: app.bundleName,
            status: "unavailable", reason: size === undefined ? "无法确认数据库文件大小" : size > MAX_SNAPSHOT_BYTES
              ? "数据库超过 64 MiB 只读快照上限" : "文件不足 SQLite 文件头所需的 100 字节",
          });
          continue;
        }
        try {
          const validHeader = await manager.isSqliteFile(catalog.serial, scope, file.path, catalog.abort.signal);
          if (validHeader || /\.(?:db|sqlite|sqlite3|rdb)$/i.test(file.name) || (standard && !file.name.includes("."))) found.push({ id: randomUUID(), identity: identity(file.path), path: file.path,
            name: file.name, size: file.size, modifiedAt: file.modifiedAt, bundleName: app.bundleName,
            ...(!validHeader ? { status: "unavailable" as const, reason: "未识别 SQLite 文件头：文件可能已加密、损坏或不是 SQLite 数据库" } : {}),
          });
        } catch (error) { if (!catalog.abort.signal.aborted) failure ??= reason(error); }
      }
      if (depth > 0 && found.length < MAX_DATABASES_PER_APP) for (const file of listing.files) {
        if (file.kind === "directory" && !catalog.abort.signal.aborted) {
          // Context.filesDir belongs to the HAP module on newer devices. Inspect only
          // each module's files directory, never recursively scan its caches/resources.
          await visit(modules ? posix.join(file.path, "files") : file.path, depth - 1, standard);
        }
      }
    } catch (error) { if (!missing(error) && !catalog.abort.signal.aborted) failure ??= reason(error); }
  };
  for (const root of ROOTS) await visit(root, 2, true);
  for (const root of FILE_ROOTS) await visit(root, 1, false);
  for (const root of MODULE_FILE_ROOTS) await visit(root, 2, false, true);
  if (catalog.abort.signal.aborted) return;
  const unique = [...new Map(found.map(item => [item.path, item])).values()].slice(0, MAX_DATABASES_PER_APP);
  for (const item of unique) catalog.paths.set(item.id, item);
  app.databases = unique.map(({ id, identity, name, size, modifiedAt, status, reason }) => ({ id, identity, name, size, modifiedAt, status, reason }));
  app.status = failure || truncation || found.length >= MAX_DATABASES_PER_APP
    ? "inaccessible" : unique.length ? "ready" : "empty";
  if (app.status === "inaccessible") app.reason = failure ?? "扫描达到目录或文件数量上限，结果可能不完整";
}

async function runScan(catalog: Catalog): Promise<void> {
  try {
    const manager = getHarmonyDeviceManager();
    const applications = await manager.applications(catalog.serial, "", undefined, catalog.abort.signal);
    catalog.apps = applications.map(app => ({ bundleName: app.bundleName, label: app.label, status: "pending", databases: [] }));
    // HDC sandbox access requires a running debug-signed app. A process snapshot
    // prevents hundreds of futile sandbox commands while preserving every app row.
    let running: Set<string> | undefined;
    try {
      running = new Set((await manager.listProcesses(catalog.serial, catalog.abort.signal)).map(process => process.name));
    } catch { /* Older devices may not expose a process list; attempt bounded sandbox reads. */ }
    if (running) for (const app of catalog.apps) {
      if (![...running].some(name => name === app.bundleName || name.startsWith(`${app.bundleName}:`))) {
        app.status = "inaccessible";
        app.reason = "应用未运行；HDC 无法访问其沙箱，扫描不会自动启动应用";
      }
    }
    const candidates = catalog.apps.filter(app => app.status === "pending");
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(2, candidates.length) }, async () => {
      while (!catalog.abort.signal.aborted && cursor < candidates.length) {
        const app = candidates[cursor++];
        app.status = "scanning";
        await scanApplication(catalog, app);
      }
    }));
  } catch (error) {
    if (!catalog.abort.signal.aborted) catalog.apps = [{ bundleName: "", status: "inaccessible", databases: [], reason: reason(error) }];
  } finally {
    if (!catalog.abort.signal.aborted) { catalog.scanning = false; catalog.completedAt = new Date().toISOString(); }
  }
}

export function deviceDatabaseCatalog(serial: string, refresh = false) {
  if (!/^[A-Za-z0-9._:\[\]-]{1,256}$/.test(serial)) throw new HarmonyError("INVALID_ARGUMENT", "Choose a valid device");
  let catalog = catalogs.get(serial);
  if (refresh || !catalog || catalog.cancelled || (!catalog.scanning && Date.now() - Date.parse(catalog.completedAt ?? catalog.startedAt) > 5 * 60_000)) {
    catalog?.abort.abort("refresh");
    catalog = { serial, startedAt: new Date().toISOString(), scanning: true, apps: [], paths: new Map(), abort: new AbortController() };
    catalogs.set(serial, catalog);
    void runScan(catalog);
  }
  return { serial, startedAt: catalog.startedAt, completedAt: catalog.completedAt, scanning: catalog.scanning,
    applications: catalog.apps.map(app => ({ ...app, databases: [...app.databases] })) };
}

export function cancelDeviceDatabaseScan(serial: string, startedAt: string): void {
  const catalog = catalogs.get(serial);
  if (!catalog?.scanning || catalog.startedAt !== startedAt) return;
  catalog.abort.abort("device_changed");
  catalog.scanning = false;
  catalog.cancelled = true;
  catalog.completedAt = new Date().toISOString();
  for (const app of catalog.apps) if (app.status === "pending" || app.status === "scanning") {
    app.status = "inaccessible";
    app.reason = "扫描已取消；重新进入数据库页可重试";
  }
}

export async function openDeviceDatabase(serial: string, databaseId: string, signal?: AbortSignal) {
  const catalog = catalogs.get(serial);
  const item = catalog?.paths.get(databaseId);
  if (!item || !/^[0-9a-f-]{36}$/i.test(databaseId)) throw new HarmonyError("STALE_SNAPSHOT", "Refresh the application database list and choose a database again", { details: { reason: "database-id-expired" } });
  const manager = getHarmonyDeviceManager();
  return await manager.operationTasks.track({ serial, kind: "snapshot", title: `${item.bundleName} / ${item.name}`,
    target: `${item.bundleName} / ${item.name}` }, async started => {
      if (item.status === "unavailable") throw new HarmonyError("CAPABILITY_UNAVAILABLE", item.reason ?? "The database cannot be read as SQLite");
      started();
      return await captureDeviceDatabase(serial, item, signal);
    }, result => ({ capturedAt: result.capturedAt, bytes: result.database.size, verification: result.database.verification }));
}

async function captureDeviceDatabase(serial: string, item: PrivateDatabase, signal?: AbortSignal) {
  const manager = getHarmonyDeviceManager();
  const scope: HarmonyFileScope = { kind: "sandbox", bundleName: item.bundleName };
  const parent = posix.dirname(item.path);
  const inspectRemote = async () => {
    const listing = await manager.listFiles(serial, scope, parent, signal);
    if (listing.truncated) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "This directory is too large to verify a consistent database snapshot", { details: { reason: "database-directory-truncated" } });
    const file = listing.files.find(file => file.path === item.path && file.kind === "file");
    if (!file || !file.size || file.size > MAX_SNAPSHOT_BYTES) throw new HarmonyError("STALE_SNAPSHOT", "Database file changed or is too large; refresh discovery", { details: { reason: "database-file-unavailable" } });
    // A checkpoint can leave an empty WAL on the device. It contains no frames;
    // recheck its exact size before and after both database copies. Unknown sizes
    // and every nonempty WAL or rollback journal still prevent a snapshot.
    if (listing.files.some(file => file.name === `${item.name}-journal`
      || (file.name === `${item.name}-wal` && (file.kind !== "file" || file.size !== 0)))) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "WAL or journal files prevent a verified read-only snapshot; use a consistent backup exported by the app", { details: { reason: "database-active-journal" } });
    }
    return { size: file.size, modifiedAt: file.modifiedAt };
  };
  const before = await inspectRemote();
  const directory = await mkdtemp(join(tmpdir(), "piora-device-db-"));
  try {
    const local = join(directory, basename(item.path));
    await manager.pullFile(serial, scope, item.path, local, signal);
    const middle = await inspectRemote();
    if (before.size !== middle.size || before.modifiedAt !== middle.modifiedAt) {
      throw new HarmonyError("STALE_SNAPSHOT", "Database changed during capture; refresh after writes settle", { details: { reason: "database-changed-during-capture" } });
    }
    const verification = join(directory, "verification.db");
    await manager.pullFile(serial, scope, item.path, verification, signal);
    const after = await inspectRemote();
    if (before.size !== after.size || before.modifiedAt !== after.modifiedAt || await sha256(local) !== await sha256(verification)) {
      throw new HarmonyError("STALE_SNAPSHOT", "Database changed between two captures; refresh after writes settle", { details: { reason: "database-changed-during-capture" } });
    }
    const snapshot = await openHarmonySqliteTrustedSnapshot(local, serial);
    return { ...snapshot, capturedAt: new Date().toISOString(), database: {
      id: item.id, bundleName: item.bundleName, name: item.name, size: before.size,
      verification: "double-copy-sha256" as const,
    } };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export function databaseIdForDevicePath(serial: string, bundleName: string, path: string): string | undefined {
  const catalog = catalogs.get(serial);
  for (const item of catalog?.paths.values() ?? []) if (item.bundleName === bundleName && item.path === path) return item.id;
  return undefined;
}
