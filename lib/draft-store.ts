export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

export interface ChatDraftFile {
  name: string;
  size: number;
  text: string | null;
  kind?: "file" | "paste";
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
  files: ChatDraftFile[];
}

const drafts = new Map<string, ChatDraft>();
const importedKey = "piora-imported-chat-drafts";
function importedDrafts(): Array<[string, ChatDraft]> { try { return typeof window !== "undefined" ? JSON.parse(localStorage.getItem(importedKey) ?? "[]") : []; } catch { return []; } }
export function snapshotChatDrafts(): Array<[string, ChatDraft]> { return [...new Map([...importedDrafts(), ...drafts])].map(([id, draft]) => [id, cloneDraft(draft)]); }
export function restoreChatDrafts(snapshot: Array<[string, ChatDraft]>): void { localStorage.setItem(importedKey, JSON.stringify(snapshot)); drafts.clear(); for (const [id, draft] of snapshot) drafts.set(id, cloneDraft(draft)); }
function removeImportedDraft(key: string) { try { const saved = importedDrafts(); if (saved.some(([id]) => id === key)) localStorage.setItem(importedKey, JSON.stringify(saved.filter(([id]) => id !== key))); } catch { /* Keep the recovery copy if storage is unavailable. */ } }

function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
    files: draft.files.map((file) => ({ ...file })),
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
  removeImportedDraft(key);
  if (isEmptyDraft(draft)) {
    drafts.delete(key);
    return;
  }
  drafts.set(key, cloneDraft(draft));
}

export function clearDraft(key: string): void {
  removeImportedDraft(key);
  drafts.delete(key);
}
