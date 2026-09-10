/** Local recovery copies are separate from history and never sent to a model. */
export interface ClipboardRecoveryDraft {
  id: string; revision: string; entryId: string; title: string; updatedAt: number;
  text: string; remark: string; baseText: string; baseRemark: string;
}
export type ClipboardDraftSummary = Pick<ClipboardRecoveryDraft, "id" | "revision" | "entryId" | "title" | "updatedAt">;
let database: Promise<IDBDatabase> | undefined;
const local = new Map<string, ClipboardRecoveryDraft>();
const listeners = new Set<() => void>();
let channel: BroadcastChannel | undefined;
let pending = 0;
const failed = new Set<string>();
let watchingUnload = false;
const writes = new Set<Promise<void>>();
const writingDrafts = new Map<string, { next: ClipboardRecoveryDraft | null; promise: Promise<void> }>();
export async function flushClipboardDrafts() {
  while (writes.size) await Promise.allSettled([...writes]);
  // A failed write keeps its latest complete value in memory, including after UI unmount.
  const buffered = [...local.values()];
  await Promise.all(buffered.map(writeClipboardDraft));
  if (failed.size) throw new Error("草稿尚未写入本机，请重试后再关闭窗口。");
}
function notify() { listeners.forEach(listener => listener()); channel?.postMessage("changed"); }
function watch() {
  if (!watchingUnload) {
    watchingUnload = true;
    window.piDesktop?.clipboard?.historyV2?.onBeforeClose?.(flushClipboardDrafts);
    window.addEventListener("beforeunload", event => {
      if (pending || failed.size) { event.preventDefault(); event.returnValue = ""; }
    });
  }
  if (!channel && typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel("piora-clipboard-drafts");
    channel.onmessage = () => listeners.forEach(listener => listener());
  }
}
function openDatabase() {
  watch();
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("piora-clipboard-drafts", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("drafts", { keyPath: "id" });
      request.result.createObjectStore("summaries", { keyPath: "id" }).createIndex("updatedAt", "updatedAt");
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); database = undefined; };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("草稿存储正被占用，请关闭旧窗口后重试。"));
  }).catch(error => { database = undefined; throw error; });
  return database;
}
function complete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("草稿写入中断。"));
    transaction.onerror = () => reject(transaction.error);
  });
}
export function subscribeClipboardDrafts(listener: () => void) {
  watch(); listeners.add(listener); return () => { listeners.delete(listener); };
}
export function writeClipboardDraft(draft: ClipboardRecoveryDraft): Promise<void> {
  local.set(draft.id, draft);
  const existing = writingDrafts.get(draft.id);
  if (existing) { existing.next = draft; return existing.promise; }
  // One active transaction plus only the newest queued value per editor. Large
  // text edits cannot accumulate a copy of the full body for every keystroke.
  const job = { next: draft as ClipboardRecoveryDraft | null, promise: Promise.resolve() };
  writingDrafts.set(draft.id, job);
  const promise = (async () => {
    while (job.next) {
      const value = job.next; job.next = null;
      try { await persistClipboardDraft(value); }
      catch (error) { if (!job.next) throw error; }
    }
  })().finally(() => { writingDrafts.delete(draft.id); });
  job.promise = promise;
  writes.add(promise);
  void promise.then(() => writes.delete(promise), () => writes.delete(promise));
  return promise;
}
async function persistClipboardDraft(draft: ClipboardRecoveryDraft) {
  pending++;
  try {
    const db = await openDatabase(), tx = db.transaction(["drafts", "summaries"], "readwrite", { durability: "strict" });
    const { id, revision, entryId, title, updatedAt } = draft;
    tx.objectStore("drafts").put(draft);
    tx.objectStore("summaries").put({ id, revision, entryId, title, updatedAt });
    await complete(tx);
    if (local.get(id)?.revision === revision) { local.delete(id); failed.delete(id); }
  } catch (error) { failed.add(draft.id); throw error; }
  finally { pending--; notify(); }
}
export async function readClipboardDraft(id: string): Promise<ClipboardRecoveryDraft | null> {
  if (local.has(id)) return local.get(id)!;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction("drafts").objectStore("drafts").get(id);
    request.onsuccess = () => resolve(local.get(id) ?? request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}
/** Delete only the revision reviewed/saved by this editor, never a later edit in another window. */
export function removeClipboardDraft(id: string, revision: string): Promise<void> {
  const promise = deleteClipboardDraft(id, revision);
  writes.add(promise);
  void promise.then(() => writes.delete(promise), () => writes.delete(promise));
  return promise;
}
async function deleteClipboardDraft(id: string, revision: string) {
  pending++;
  try {
    const db = await openDatabase(), tx = db.transaction(["drafts", "summaries"], "readwrite", { durability: "strict" });
    const request = tx.objectStore("drafts").get(id);
    request.onsuccess = () => {
      if (request.result?.revision === revision) {
        tx.objectStore("drafts").delete(id); tx.objectStore("summaries").delete(id);
      }
    };
    await complete(tx);
    if (local.get(id)?.revision === revision) local.delete(id);
    if (!local.has(id)) failed.delete(id);
  } finally { pending--; notify(); }
}
export async function listClipboardDrafts(limit = 50): Promise<{ items: ClipboardDraftSummary[]; total: number }> {
  const db = await openDatabase();
  const result = await new Promise<{ items: ClipboardDraftSummary[]; total: number }>((resolve, reject) => {
    const tx = db.transaction("summaries"), store = tx.objectStore("summaries"), count = store.count();
    const request = store.index("updatedAt").openCursor(null, "prev"), items: ClipboardDraftSummary[] = [];
    request.onsuccess = () => { const cursor = request.result; if (cursor && items.length < limit) { items.push(cursor.value); cursor.continue(); } };
    tx.oncomplete = () => resolve({ items, total: count.result }); tx.onerror = () => reject(tx.error);
  });
  for (const value of local.values()) {
    const index = result.items.findIndex(item => item.id === value.id);
    const { id, revision, entryId, title, updatedAt } = value;
    if (index >= 0) result.items[index] = { id, revision, entryId, title, updatedAt };
    else result.items.push({ id, revision, entryId, title, updatedAt });
  }
  result.items.sort((a, b) => b.updatedAt - a.updatedAt);
  return { items: result.items.slice(0, limit), total: Math.max(result.total, result.items.length) };
}
