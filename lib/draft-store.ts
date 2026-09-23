import { readComposerRecord, writeComposerRecord, readComposerDraftEntries, replaceComposerDraftEntries } from "./reply-storage";
import type { ReplySpan } from "./reply-draft";
import type { AttachedFile } from "./file-attachments";

export interface ChatDraftImage {
  data: string;
  mimeType: string;
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
const deferredPersistence = new Map<string, { count: number; changed: boolean; draft?: ChatDraft }>();
export const DRAFT_STORAGE_ERROR_EVENT = "piora:draft-storage-error";
function persist(key: string, draft?: ChatDraft) {
  const deferred = deferredPersistence.get(key);
  if (deferred) {
    deferred.changed = true;
    deferred.draft = draft;
    return;
  }
  if (typeof indexedDB === "undefined") return;
  const writing = (writes.get(key) ?? Promise.resolve()).then(() => writeComposerRecord("drafts", key, draft)).catch(() => {
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
    if (deferred.changed) persist(key, deferred.draft);
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
  persist(key, cloneDraft(draft));
}

export function clearDraft(key: string): void {
  revisions.set(key, (revisions.get(key) ?? 0) + 1);
  removeImportedDraft(key);
  drafts.delete(key);
  persist(key);
}
