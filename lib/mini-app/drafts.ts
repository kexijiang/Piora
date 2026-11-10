import { compileMiniAppPlan, validateMiniAppCheckpoint, type MiniAppPlan1 } from "./plan";
import { boundedJson } from "./json";
import { MiniAppError } from "./limits";
import type { MiniAppSaveRequest } from "./state-service";

export interface MiniAppDraft {
  id: string; scope: string; sessionId: string; toolCallId: string; createdAt: number;
  plan: MiniAppPlan1; request: MiniAppSaveRequest; summary: string; sent: boolean;
  afterRequestId?: string;
  source?: { id: string; requestId: string };
}
export interface MiniAppDraftInfo { id: string; createdAt: number; summary: string; sent: boolean }
export interface MiniAppDraftCursor { scope: string; after: IDBValidKey }
export interface MiniAppDraftPage { items: MiniAppDraftInfo[]; next?: MiniAppDraftCursor }
let database: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new MiniAppError("STORAGE", "Local checkpoint storage is unavailable")); return; }
    const request = indexedDB.open("piora-mini-app-recovery", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("drafts", { keyPath: "id" }).createIndex("scope", "scope");
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); database = undefined; }; resolve(request.result); };
    request.onerror = () => reject(request.error ?? new MiniAppError("STORAGE", "Cannot open checkpoint storage"));
    request.onblocked = () => reject(new MiniAppError("STORAGE", "Checkpoint storage is busy in another window"));
  }).catch(() => { database = undefined; throw new MiniAppError("STORAGE", "Local recovery storage is unavailable; keep this page open or export the checkpoint"); });
}
export function validateMiniAppDraft(value: unknown): MiniAppDraft {
  // Plan and checkpoint retain their independent budgets within the record.
  boundedJson(value, 1024 * 1024);
  const draft = value as MiniAppDraft;
  if (!draft || typeof draft.id !== "string" || !draft.id || draft.id.length > 128 || typeof draft.sessionId !== "string" || !draft.sessionId || draft.sessionId.length > 256
    || typeof draft.toolCallId !== "string" || !draft.toolCallId || draft.toolCallId.length > 256 || draft.scope !== `${draft.sessionId}:${draft.toolCallId}`
    || !Number.isSafeInteger(draft.createdAt) || draft.createdAt < 0 || typeof draft.sent !== "boolean" || typeof draft.summary !== "string" || draft.summary.length > 4000
    || typeof draft.request?.requestId !== "string" || !draft.request.requestId || draft.request.requestId.length > 256
    || draft.request.toolCallId !== draft.toolCallId || !Number.isSafeInteger(draft.request.expectedRevision) || draft.request.expectedRevision < 0
    || ![draft.request.publicationId, draft.request.planDigest, draft.request.runtimeVersion, draft.request.leafId].every(v => typeof v === "string" && v.length > 0 && v.length <= 256)
    || !/^[a-f0-9]{64}$/.test(draft.request.planDigest)
    || draft.afterRequestId !== undefined && (typeof draft.afterRequestId !== "string" || !draft.afterRequestId || draft.afterRequestId.length > 256)
    || draft.source !== undefined && (!draft.source || typeof draft.source.id !== "string" || !draft.source.id || draft.source.id.length > 128 || typeof draft.source.requestId !== "string" || !draft.source.requestId || draft.source.requestId.length > 256)) {
    throw new MiniAppError("STORAGE", "This checkpoint needs recovery and has not been deleted");
  }
  const compiled = compileMiniAppPlan(draft.plan), checkpoint = validateMiniAppCheckpoint(compiled, draft.request.checkpoint);
  const request = JSON.parse(boundedJson(draft.request, 512 * 1024)) as MiniAppSaveRequest;
  return { id: draft.id, scope: draft.scope, sessionId: draft.sessionId, toolCallId: draft.toolCallId, createdAt: draft.createdAt,
    plan: compiled.plan, request: { ...request, checkpoint }, summary: draft.summary, sent: draft.sent,
    ...(draft.afterRequestId ? { afterRequestId: draft.afterRequestId } : {}), ...(draft.source ? { source: { ...draft.source } } : {}) };
}
export async function putMiniAppDraft(value: MiniAppDraft): Promise<void> {
  const draft = validateMiniAppDraft(value), db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("drafts", "readwrite", { durability: "strict" });
    tx.objectStore("drafts").put(draft);
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new MiniAppError("STORAGE", "Cannot retain the local checkpoint"));
    tx.onerror = () => reject(tx.error);
  }).catch(() => { throw new MiniAppError("STORAGE", "The recovery copy could not be written; keep this page open or export the checkpoint"); });
}
export async function getMiniAppDraft(id: string): Promise<MiniAppDraft | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction("drafts").objectStore("drafts").get(id);
    request.onsuccess = () => { try { resolve(request.result ? validateMiniAppDraft(request.result) : undefined); } catch (error) { reject(error); } };
    request.onerror = () => reject(request.error);
  });
}
/** Stable index/primary-key order survives deletion of the previous page's last row. */
export async function listMiniAppDraftPage(scope: string, after?: MiniAppDraftCursor, limit = 20): Promise<MiniAppDraftPage> {
  if (!scope || !Number.isInteger(limit) || limit < 1 || limit > 100 || after && after.scope !== scope) {
    throw new MiniAppError("STORAGE", "Invalid checkpoint list request");
  }
  const db = await open();
  if (after) {
    try { indexedDB.cmp(after.after, after.after); }
    catch { throw new MiniAppError("STORAGE", "Invalid checkpoint list cursor"); }
  }
  return new Promise((resolve, reject) => {
    const items: MiniAppDraftInfo[] = [], request = db.transaction("drafts").objectStore("drafts").index("scope").openCursor(scope);
    let last: IDBValidKey | undefined;
    request.onsuccess = () => {
      try {
        const cursor = request.result;
        if (!cursor) { resolve({ items }); return; }
        if (after) {
          const compared = indexedDB.cmp(cursor.primaryKey, after.after);
          if (compared < 0) { cursor.continuePrimaryKey(scope, after.after); return; }
          if (compared === 0) { cursor.continue(); return; }
        }
        // Read one extra row to distinguish a full final page from a next page.
        if (items.length === limit) { resolve({ items, next: { scope, after: last! } }); return; }
        const value = cursor.value;
        items.push({ id: String(cursor.primaryKey), createdAt: Number.isSafeInteger(value.createdAt) && value.createdAt >= 0 ? value.createdAt : 0,
          summary: typeof value.summary === "string" ? value.summary.slice(0, 4000) : "Checkpoint needs recovery", sent: value.sent === true });
        last = cursor.primaryKey;
        cursor.continue();
      } catch (error) { reject(error); }
    };
    request.onerror = () => reject(request.error);
  });
}
/** First-page compatibility helper; navigable recovery UIs use listMiniAppDraftPage. */
export async function listMiniAppDrafts(scope: string): Promise<MiniAppDraftInfo[]> {
  return (await listMiniAppDraftPage(scope)).items;
}
/** Delete only the exact confirmed draft; never clear another writer's new input. */
export async function confirmMiniAppDraft(id: string, requestId: string): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("drafts", "readwrite", { durability: "strict" }), store = tx.objectStore("drafts"), request = store.get(id);
    request.onsuccess = () => { if (request.result?.request?.requestId === requestId) store.delete(id); };
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new MiniAppError("STORAGE", "Cannot confirm the local checkpoint"));
    tx.onerror = () => reject(tx.error);
  });
}
