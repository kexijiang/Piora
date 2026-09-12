import type { ReplyResult } from "./reply-suggestions";
let opening: Promise<IDBDatabase> | undefined;
function database() {
  return opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("piora-composer", 1);
    request.onupgradeneeded = () => { request.result.createObjectStore("drafts"); request.result.createObjectStore("replies", { keyPath: "key" }); };
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); opening = undefined; }; resolve(request.result); };
    request.onerror = () => { opening = undefined; reject(request.error); };
  });
}
export async function readComposerRecord<T>(store: "drafts" | "replies", key: string): Promise<T | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => { const req = db.transaction(store).objectStore(store).get(key); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}
export async function writeComposerRecord(store: "drafts" | "replies", key: string, value: unknown): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite"), table = tx.objectStore(store);
    if (value === undefined) table.delete(key);
    else if (store === "replies") table.put(value);
    else table.put(value, key);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
export async function cacheReply(key: string, result: ReplyResult) {
  await writeComposerRecord("replies", key, { key, result, used: Date.now() });
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("replies", "readwrite"), table = tx.objectStore("replies"), req = table.getAll();
    req.onsuccess = () => { const rows = req.result as { key: string; used: number }[]; rows.sort((a, b) => b.used - a.used).slice(200).forEach((row) => table.delete(row.key)); };
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  });
}
export async function replyCacheKey(value: unknown) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
export async function readComposerDraftEntries<T>(): Promise<Array<[string, T]>> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("drafts"), table = tx.objectStore("drafts"), keys = table.getAllKeys(), values = table.getAll();
    tx.oncomplete = () => resolve(keys.result.map((key, index) => [String(key), values.result[index] as T]));
    tx.onerror = () => reject(tx.error);
  });
}
export async function replaceComposerDraftEntries(entries: Array<[string, unknown]>): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("drafts", "readwrite", { durability: "strict" }), table = tx.objectStore("drafts");
    table.clear(); entries.forEach(([key, value]) => table.put(value, key));
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
