import { snapshotPersistedChatDrafts, restorePersistedChatDrafts, type ChatDraft } from "./draft-store";

export interface ClientBackup { version: 1; local: Record<string, string>; databases: Array<{ name: string; store: string; records: unknown[] }>; drafts: Array<[string, ChatDraft]> }
const databases = [{ name: "piora-appearance", store: "backgrounds" }, { name: "piora-prompt-recovery", store: "prompts" }];
export const isPortableClientKey = (key: string) => (/^(?:pi-|piora[-:])/.test(key) || key === "theme") && !/^piora-transfer-/.test(key);
export function validateClientBackup(value: unknown): asserts value is ClientBackup {
  if (!value || typeof value !== "object") throw new Error("backup_format");
  const snapshot = value as ClientBackup;
  if (snapshot.version !== 1 || !snapshot.local || Array.isArray(snapshot.local) || typeof snapshot.local !== "object" || Object.values(snapshot.local).some((value) => typeof value !== "string") || !Array.isArray(snapshot.databases) || !Array.isArray(snapshot.drafts)) throw new Error("backup_format");
  const seen = new Set<string>();
  for (const entry of snapshot.databases) { if (!entry || !databases.some((database) => entry.name === database.name && entry.store === database.store) || seen.has(entry.name) || !Array.isArray(entry.records) || entry.records.some((record) => !record || typeof record !== "object" || typeof (record as { id?: unknown }).id !== "string")) throw new Error("backup_format"); seen.add(entry.name); }
  for (const entry of snapshot.drafts) { if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || !entry[1] || typeof entry[1].value !== "string" || !Array.isArray(entry[1].files) || !Array.isArray(entry[1].images)) throw new Error("backup_format"); }
}
async function serialize(value: unknown): Promise<unknown> {
  if (value instanceof Blob) { const buffer = new Uint8Array(await value.arrayBuffer()); let text = ""; for (let offset = 0; offset < buffer.length; offset += 32768) text += String.fromCharCode(...buffer.subarray(offset, offset + 32768)); return { $pioraBlob: btoa(text), type: value.type }; }
  if (Array.isArray(value)) return Promise.all(value.map(serialize));
  if (value && typeof value === "object") return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, child]) => [key, await serialize(child)])));
  return value;
}
function deserialize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deserialize);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.$pioraBlob === "string" && typeof record.type === "string") return new Blob([Uint8Array.from(atob(record.$pioraBlob), (ch) => ch.charCodeAt(0))], { type: record.type });
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, deserialize(child)]));
  }
  return value;
}
function openDatabase(name: string, store: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => { const request = indexedDB.open(name, 1); request.onupgradeneeded = () => { const table = request.result.createObjectStore(store, { keyPath: "id" }); if (name === "piora-prompt-recovery") table.createIndex("scope", "scope"); }; request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error("backup_browser_busy")); request.onsuccess = () => resolve(request.result); });
}
async function readRecords(name: string, store: string): Promise<unknown[]> { const db = await openDatabase(name, store); try { return await new Promise((resolve, reject) => { const request = db.transaction(store).objectStore(store).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); } finally { db.close(); } }
export async function snapshotClientBackup(): Promise<ClientBackup> {
  const local: Record<string, string> = {};
  for (let index = 0; index < localStorage.length; index++) { const key = localStorage.key(index); if (key && isPortableClientKey(key)) local[key] = localStorage.getItem(key)!; }
  const stored = await Promise.all(databases.map(async ({ name, store }) => ({ name, store, records: await Promise.all((await readRecords(name, store)).map(serialize)) })));
  return { version: 1, local, databases: stored, drafts: await snapshotPersistedChatDrafts() };
}
async function applyClient(snapshot: ClientBackup) {
  validateClientBackup(snapshot);
  for (const entry of snapshot.databases) {
    if (!databases.some((db) => db.name === entry.name && db.store === entry.store) || !Array.isArray(entry.records)) throw new Error("backup_format");
    const records = entry.records.map(deserialize); const db = await openDatabase(entry.name, entry.store);
    try { await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(entry.store, "readwrite", { durability: "strict" });
      transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error);
      try { const store = transaction.objectStore(entry.store); store.clear(); for (const record of records) store.put(record); } catch (error) { transaction.abort(); reject(error); }
    }); } finally { db.close(); }
  }
  for (const key of Object.keys(localStorage)) if (isPortableClientKey(key)) localStorage.removeItem(key);
  for (const [key, value] of Object.entries(snapshot.local)) if (isPortableClientKey(key) && typeof value === "string") localStorage.setItem(key, value);
  await restorePersistedChatDrafts(snapshot.drafts);
}
export async function restoreClientBackup(snapshot: ClientBackup) {
  const previous = await snapshotClientBackup();
  try { await applyClient(snapshot); } catch (error) { await applyClient(previous); throw error; }
}
