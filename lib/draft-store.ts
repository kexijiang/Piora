import { readComposerRecord, writeComposerRecord, readComposerDraftEntries, replaceComposerDraftEntries } from "./reply-storage";
import type { ReplySpan } from "./reply-draft";
import type { AttachedFile } from "./file-attachments";
import { MAX_ATTACHED_IMAGES, MAX_ATTACHED_IMAGE_TOTAL_BYTES, getBase64DecodedByteLength, isBase64ImageWithinLimits } from "./image-attachments";

export interface ChatDraftImage {
  data: string;
  mimeType: string;
  captureId?: string;
}

export type ChatDraftFile = AttachedFile;

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
  files: ChatDraftFile[];
  /** Failed submissions represented by this restored draft, not same-text sends. */
  retryOfPromptIds?: string[];
  replySpans?: ReplySpan[];
}

const drafts = new Map<string, ChatDraft>();
const revisions = new Map<string, number>();
const writes = new Map<string, Promise<void>>();
const deferredPersistence = new Map<string, { count: number; changed: boolean }>();
export const DRAFT_STORAGE_ERROR_EVENT = "piora:draft-storage-error";
export const SCREENSHOT_DRAFT_UPDATED_EVENT = "piora:screenshot-draft-updated";
function persist(key: string) {
  const deferred = deferredPersistence.get(key);
  if (deferred) {
    deferred.changed = true;
    return;
  }
  if (typeof indexedDB === "undefined") return;
  // Read the latest in-memory value when this queued write runs. An older
  // composer render must never overwrite a screenshot committed ahead of it.
  const writing = (writes.get(key) ?? Promise.resolve()).then(() => writeComposerRecord("drafts", key, drafts.get(key))).catch(() => {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(DRAFT_STORAGE_ERROR_EVENT, { detail: key }));
  });
  writes.set(key, writing);
  void writing.finally(() => { if (writes.get(key) === writing) writes.delete(key); });
}

/** Keep the stored draft until the optimistic send has a durable recovery copy. */
export function deferDraftPersistence(key: string): () => void {
  const deferred = deferredPersistence.get(key) ?? { count: 0, changed: false };
  deferred.count += 1;
  deferredPersistence.set(key, deferred);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--deferred.count > 0) return;
    deferredPersistence.delete(key);
    if (deferred.changed) persist(key);
  };
}

export async function hydrateDraft(key: string): Promise<ChatDraft | null> {
  const revision = revisions.get(key) ?? 0;
  const memory = getDraft(key);
  if (memory || deferredPersistence.has(key) || typeof indexedDB === "undefined") return memory;
  const stored = await readComposerRecord<ChatDraft>("drafts", key);
  if ((revisions.get(key) ?? 0) !== revision) return getDraft(key);
  if (stored && typeof stored.value === "string" && Array.isArray(stored.images) && Array.isArray(stored.files)) drafts.set(key, cloneDraft(stored));
  return getDraft(key);
}
const importedKey = "piora-imported-chat-drafts";
function importedDrafts(): Array<[string, ChatDraft]> { try { return typeof window !== "undefined" ? JSON.parse(localStorage.getItem(importedKey) ?? "[]") : []; } catch { return []; } }
export function snapshotChatDrafts(): Array<[string, ChatDraft]> { return [...new Map([...importedDrafts(), ...drafts])].map(([id, draft]) => [id, cloneDraft(draft)]); }
export async function snapshotPersistedChatDrafts(): Promise<Array<[string, ChatDraft]>> {
  await Promise.all(writes.values());
  const stored = typeof indexedDB === "undefined" ? [] : await readComposerDraftEntries<ChatDraft>();
  return [...new Map([...stored, ...snapshotChatDrafts()])].map(([id, draft]) => [id, cloneDraft(draft)]);
}
export async function restorePersistedChatDrafts(snapshot: Array<[string, ChatDraft]>): Promise<void> {
  await Promise.all(writes.values());
  if (typeof indexedDB !== "undefined") await replaceComposerDraftEntries(snapshot.map(([id, draft]) => [id, cloneDraft(draft)]));
  restoreChatDrafts(snapshot);
}
export function restoreChatDrafts(snapshot: Array<[string, ChatDraft]>): void { localStorage.setItem(importedKey, JSON.stringify(snapshot)); drafts.clear(); for (const [id, draft] of snapshot) drafts.set(id, cloneDraft(draft)); }
function removeImportedDraft(key: string) { try { const saved = importedDrafts(); if (saved.some(([id]) => id === key)) localStorage.setItem(importedKey, JSON.stringify(saved.filter(([id]) => id !== key))); } catch { /* Keep the recovery copy if storage is unavailable. */ } }

function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
    files: draft.files.map((file) => ({ ...file })),
    ...(draft.retryOfPromptIds?.length ? { retryOfPromptIds: [...draft.retryOfPromptIds] } : {}),
    ...(draft.replySpans?.length ? { replySpans: draft.replySpans.map((s) => ({ ...s })) } : {}),
  };
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return !draft.value && draft.images.length === 0 && draft.files.length === 0;
}

export function getDraft(key: string): ChatDraft | null {
  const draft = drafts.get(key) ?? importedDrafts().find(([id]) => id === key)?.[1];
  return draft ? cloneDraft(draft) : null;
}

export function setDraft(key: string, draft: ChatDraft): void {
  revisions.set(key, (revisions.get(key) ?? 0) + 1);
  removeImportedDraft(key);
  if (isEmptyDraft(draft)) {
    drafts.delete(key);
    persist(key);
    return;
  }
  drafts.set(key, cloneDraft(draft));
  persist(key);
}

export function clearDraft(key: string): void {
  revisions.set(key, (revisions.get(key) ?? 0) + 1);
  removeImportedDraft(key);
  drafts.delete(key);
  persist(key);
}

/** A capture is acknowledged only after its complete draft reaches IndexedDB. */
export async function appendCapturedImageToDraft(key: string, captureId: string, data: string): Promise<void> {
  const image: ChatDraftImage = { data, mimeType: "image/png", captureId };
  if (!isBase64ImageWithinLimits(image)) throw new Error("截图数据无效或超过附件大小限制");
  if (typeof indexedDB === "undefined") throw new Error("草稿存储不可用");
  const writing = (writes.get(key) ?? Promise.resolve()).then(async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await hydrateDraft(key) ?? { value: "", images: [], files: [] };
      if (current.images.some((item) => item.captureId === captureId)) return;
      const bytes = current.images.reduce((sum, item) => sum + (getBase64DecodedByteLength(item.data) ?? 0), 0)
        + (getBase64DecodedByteLength(data) ?? 0);
      if (current.images.length >= MAX_ATTACHED_IMAGES || bytes > MAX_ATTACHED_IMAGE_TOTAL_BYTES) {
        throw new Error("聊天附件已达到图片数量或总大小限制");
      }
      const revision = revisions.get(key) ?? 0;
      const next = { ...current, images: [...current.images, image] };
      await writeComposerRecord("drafts", key, next, true);
      if ((revisions.get(key) ?? 0) !== revision) continue;
      revisions.set(key, revision + 1);
      drafts.set(key, cloneDraft(next));
      removeImportedDraft(key);
      window.dispatchEvent(new CustomEvent(SCREENSHOT_DRAFT_UPDATED_EVENT, { detail: { key, captureId } }));
      return;
    }
    throw new Error("草稿在截图保存期间持续变化，请重试添加");
  });
  const settled = writing.catch(() => {});
  writes.set(key, settled);
  try { await writing; }
  finally { if (writes.get(key) === settled) writes.delete(key); }
}
