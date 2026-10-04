import type { HarmonyFileScope } from "./device-files";
import type { DeviceNewline, DeviceTextEncoding, WritableDeviceNewline } from "./device-text";

export interface DeviceTextPreview { text: string; hash: string; size: number; encoding?: DeviceTextEncoding; newline?: DeviceNewline }
export interface DeviceFileDraft {
  serial: string;
  scope: HarmonyFileScope;
  path: string;
  original: DeviceTextPreview;
  text: string;
  newlineMode?: WritableDeviceNewline;
  updatedAt?: number;
}
export interface DeviceFileDraftEntry { key: string; serial: string; scope: HarmonyFileScope; path: string; updatedAt?: number }

export const DEVICE_FILE_DRAFT_EVENT = "piora:harmony-file-draft";
export const DEVICE_FILE_DRAFT_DISCARDED_EVENT = "piora:harmony-file-draft-discarded";
const memory = new Map<string, DeviceFileDraft | null>();
const revisions = new Map<string, number>();
const writing = new Map<string, Promise<void>>();
const durableRevisions = new Map<string, number>();
const unsettled = new Set<string>();
const failures = new Set<string>();
let database: Promise<IDBDatabase> | undefined;
let unloadRegistered = false;

export function deviceFileDraftKey(serial: string, scope: HarmonyFileScope, path: string): string {
  return JSON.stringify([serial, scope.kind, scope.kind === "sandbox" ? scope.bundleName : "", path]);
}
function copyDraft(value: DeviceFileDraft): DeviceFileDraft { return { ...value, scope: { ...value.scope }, original: { ...value.original } }; }
function validIdentity(value: Partial<DeviceFileDraftEntry>): boolean {
  return typeof value.serial === "string" && value.serial.length > 0 && value.serial.length <= 256
    && typeof value.path === "string" && value.path.length > 0 && value.path.length <= 4096
    && !/[\x00-\x1f\x7f]/.test(value.path) && Boolean(value.scope)
    && (value.scope?.kind === "shared" || value.scope?.kind === "sandbox" && typeof value.scope.bundleName === "string" && /^[A-Za-z][A-Za-z0-9_.]{0,255}$/.test(value.scope.bundleName));
}
function entryFor(value: Pick<DeviceFileDraft, "serial" | "scope" | "path" | "updatedAt">): DeviceFileDraftEntry {
  return { key: deviceFileDraftKey(value.serial, value.scope, value.path), serial: value.serial, scope: { ...value.scope }, path: value.path,
    ...(Number.isSafeInteger(value.updatedAt) && value.updatedAt! > 0 && value.updatedAt! <= Date.now() + 60_000 ? { updatedAt: value.updatedAt } : {}) };
}
function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("Local draft storage unavailable"));
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("piora-harmony-file-drafts", 2);
    let failed = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("drafts")) db.createObjectStore("drafts");
      const catalog = db.createObjectStore("catalog");
      // Version 1 records remain intact. Migrate metadata one record at a time;
      // ordinary lists never materialize every original and edited text.
      const cursor = request.transaction!.objectStore("drafts").openCursor();
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (!item) return;
        const value = item.value;
        if (value && typeof value === "object" && validIdentity(value)
          && deviceFileDraftKey(value.serial, value.scope, value.path) === item.primaryKey) catalog.put(entryFor(value), item.primaryKey);
        item.continue();
      };
    };
    request.onerror = () => { failed = true; reject(request.error ?? new Error("Local draft storage unavailable")); };
    request.onblocked = () => { failed = true; reject(new Error("Local draft storage is blocked")); };
    request.onsuccess = () => {
      if (failed) { request.result.close(); return; }
      request.result.onversionchange = () => { request.result.close(); database = undefined; }; resolve(request.result);
    };
  }).catch(error => { database = undefined; throw error; });
  return database;
}
function announce(key: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(DEVICE_FILE_DRAFT_EVENT, { detail: key }));
  if (!unloadRegistered) {
    unloadRegistered = true;
    window.addEventListener("beforeunload", event => {
      if (!unsettled.size && !failures.size) return;
      event.preventDefault(); event.returnValue = "";
    });
  }
}
export function deviceFileDraftStatus(key: string): "saving" | "saved" | "failed" {
  return unsettled.has(key) ? "saving" : failures.has(key) ? "failed" : "saved";
}
function writeRecord(db: IDBDatabase, key: string, value: DeviceFileDraft | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(["drafts", "catalog"], "readwrite");
    const store = transaction.objectStore("drafts");
    const catalog = transaction.objectStore("catalog");
    if (value) { store.put(value, key); catalog.put(entryFor(value), key); }
    else { store.delete(key); catalog.delete(key); }
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error("Local draft write failed"));
  });
}
/** A synchronous memory copy survives navigation; each returned promise confirms a durable transaction. */
export function rememberDeviceFileDraft(value: DeviceFileDraft): Promise<void> {
  const key = deviceFileDraftKey(value.serial, value.scope, value.path);
  memory.set(key, value.text === value.original.text && !value.newlineMode ? null : { ...copyDraft(value), updatedAt: Date.now() });
  revisions.set(key, (revisions.get(key) ?? 0) + 1);
  unsettled.add(key); failures.delete(key); announce(key);
  const queued = (writing.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const version = revisions.get(key);
    if (durableRevisions.get(key) === version) return;
    await writeRecord(await openDatabase(), key, memory.get(key) ?? null);
    durableRevisions.set(key, version!);
    if (revisions.get(key) === version) { unsettled.delete(key); failures.delete(key); announce(key); }
  }).catch(error => {
    unsettled.delete(key); failures.add(key); announce(key); throw error;
  });
  writing.set(key, queued);
  void queued.finally(() => { if (writing.get(key) === queued) writing.delete(key); }).catch(() => undefined);
  return queued;
}
export async function readDeviceFileDraft(serial: string, scope: HarmonyFileScope, path: string): Promise<DeviceFileDraft | null> {
  const key = deviceFileDraftKey(serial, scope, path);
  if (memory.has(key)) { const value = memory.get(key); return value ? copyDraft(value) : null; }
  const version = revisions.get(key) ?? 0;
  const db = await openDatabase();
  const value = await new Promise<DeviceFileDraft | undefined>((resolve, reject) => {
    const transaction = db.transaction("drafts", "readonly");
    const request = transaction.objectStore("drafts").get(key);
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error("Local draft read failed"));
  });
  if ((revisions.get(key) ?? 0) !== version) { const current = memory.get(key); return current ? copyDraft(current) : null; }
  const valid = value && validIdentity(value) && value.serial === serial && value.path === path && value.scope
    && deviceFileDraftKey(value.serial, value.scope, value.path) === key
    && typeof value.text === "string" && value.text.length <= 2 * 1024 * 1024
    && typeof value.original?.text === "string" && value.original.text.length <= 2 * 1024 * 1024
    && typeof value.original.hash === "string" && value.original.hash.length > 0 && value.original.hash.length <= 256
    && Number.isSafeInteger(value.original.size) && value.original.size >= 0 && value.original.size <= 2 * 1024 * 1024
    && (!value.original.encoding || ["utf-8", "utf-8-bom", "utf-16le", "utf-16le-bom", "utf-16be", "utf-16be-bom", "gb18030"].includes(value.original.encoding))
    && (!value.original.newline || ["lf", "crlf", "cr", "mixed", "none"].includes(value.original.newline))
    && (!value.newlineMode || ["lf", "crlf", "cr"].includes(value.newlineMode));
  memory.set(key, valid ? copyDraft(value) : null);
  return valid ? copyDraft(value) : null;
}
/** Read one bounded metadata page, including uncommitted memory drafts without exposing other devices. */
export async function listDeviceFileDrafts(serial: string, after?: string, limit = 50): Promise<{ entries: DeviceFileDraftEntry[]; next?: string; storageUnavailable?: boolean }> {
  const prefix = `${JSON.stringify([serial]).slice(0, -1)},`;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || after && !after.startsWith(prefix)) throw new Error("Invalid draft page");
  const overlay = () => [...memory].filter(([key, value]) => key.startsWith(prefix) && value && (!after || key > after))
    .map(([, value]) => entryFor(value!));
  let entries: DeviceFileDraftEntry[] = [], moreDisk = false, lastScanned = after;
  try {
    const db = await openDatabase();
    entries = await new Promise<DeviceFileDraftEntry[]>((resolve, reject) => {
      const transaction = db.transaction("catalog", "readonly");
      const cursor = transaction.objectStore("catalog").openCursor(IDBKeyRange.bound(after ?? prefix, `${prefix}\uffff`, Boolean(after), false));
      const collected: DeviceFileDraftEntry[] = [];
      let scanned = 0;
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (!item) return;
        lastScanned = String(item.primaryKey); scanned++;
        const value = item.value as DeviceFileDraftEntry;
        if (value && validIdentity(value) && value.serial === serial && value.key === item.primaryKey
          && deviceFileDraftKey(value.serial, value.scope, value.path) === value.key && memory.get(value.key) !== null) collected.push(entryFor(value));
        if (collected.length > limit || scanned >= 500) { moreDisk = true; return; }
        item.continue();
      };
      transaction.oncomplete = () => resolve(collected);
      transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error("Local draft catalog read failed"));
    });
  } catch (error) {
    // A failing durable store must be visible, even if the memory copy exists.
    // The caller can still recover individual in-memory drafts via this result.
    const local = overlay().sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    if (!local.length) throw error;
    return { entries: local.slice(0, limit), ...(local.length > limit ? { next: local[limit - 1].key } : {}), storageUnavailable: true };
  }
  const merged = new Map(entries.map(entry => [entry.key, entry]));
  for (const entry of overlay()) if (!moreDisk || !lastScanned || entry.key <= lastScanned) merged.set(entry.key, entry);
  const ordered = [...merged.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return { entries: ordered.slice(0, limit), ...(ordered.length > limit || moreDisk ? { next: ordered[Math.min(limit, ordered.length) - 1]?.key ?? lastScanned } : {}) };
}
/** Clear only after explicit discard or a verified save, never just because a view changes. */
export async function forgetDeviceFileDraft(serial: string, scope: HarmonyFileScope, path: string, expected?: DeviceFileDraft): Promise<void> {
  const key = deviceFileDraftKey(serial, scope, path);
  const previous = memory.get(key);
  if (expected && (!previous || deviceFileDraftKey(expected.serial, expected.scope, expected.path) !== key
    || previous.text !== expected.text || previous.original.hash !== expected.original.hash || previous.newlineMode !== expected.newlineMode
    || previous.original.encoding !== expected.original.encoding || expected.updatedAt !== undefined && previous.updatedAt !== expected.updatedAt)) {
    throw new Error("Draft changed during discard");
  }
  const operation = rememberDeviceFileDraft({ serial, scope, path, original: { text: "", hash: "discarded", size: 0 }, text: "" });
  const version = revisions.get(key);
  try {
    await operation;
    if (revisions.get(key) !== version) throw new Error("Draft changed during discard");
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(DEVICE_FILE_DRAFT_DISCARDED_EVENT, { detail: key }));
  }
  catch (error) { if (revisions.get(key) === version) { memory.set(key, previous ?? null); announce(key); } throw error; }
}
