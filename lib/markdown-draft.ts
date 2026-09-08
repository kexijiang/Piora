import type { CompanionLibraryItem } from "./companion-store";

export interface MarkdownDraftValue { title: string; content: string }
export interface MarkdownDraftSnapshot extends MarkdownDraftValue {
  dirty: boolean; saving: boolean; error: string; recovered: boolean;
}
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type PersistMarkdown = (value: MarkdownDraftValue & { expectedUpdatedAt: number }) => Promise<CompanionLibraryItem>;

/** Keeps edits made during an in-flight save and retains failed drafts across reloads. */
export function createMarkdownDraft(item: CompanionLibraryItem, persist: PersistMarkdown, storage?: DraftStorage) {
  const key = `piora:markdown-draft:v1:${item.id}`;
  let revision = item.updatedAt;
  let saved: MarkdownDraftValue = { title: item.title, content: item.content };
  let snapshot: MarkdownDraftSnapshot = { ...saved, dirty: false, saving: false, error: "", recovered: false };
  const listeners = new Set<() => void>();
  let inFlight: Promise<boolean> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const equal = (a: MarkdownDraftValue, b: MarkdownDraftValue) => a.title === b.title && a.content === b.content;
  const publish = (patch: Partial<MarkdownDraftSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  };
  const cache = () => {
    try {
      if (snapshot.dirty || snapshot.saving) storage?.setItem(key, JSON.stringify({ title: snapshot.title, content: snapshot.content, revision }));
      else storage?.removeItem(key);
    } catch { /* A failed disk save is still reported and the in-memory draft remains editable. */ }
  };
  try {
    const draft = JSON.parse(storage?.getItem(key) ?? "null");
    if (draft && typeof draft.title === "string" && typeof draft.content === "string" && draft.content.length <= 200_000 && Number.isSafeInteger(draft.revision) && !equal(draft, saved)) {
      revision = draft.revision;
      snapshot = { title: draft.title.slice(0, 120), content: draft.content, dirty: true, saving: false, error: "", recovered: true };
    }
  } catch { /* Ignore an invalid optional recovery cache. */ }

  const save = (): Promise<boolean> => {
    clearTimeout(timer);
    if (inFlight) return inFlight;
    if (!snapshot.dirty) return Promise.resolve(true);
    publish({ saving: true, error: "" });
    inFlight = (async () => {
      try {
        while (snapshot.dirty) {
          const value = { title: snapshot.title.trim() || "未命名文档", content: snapshot.content };
          const sent = { title: snapshot.title, content: snapshot.content };
          const result = await persist({ ...value, expectedUpdatedAt: revision });
          revision = result.updatedAt;
          saved = { title: result.title, content: result.content };
          const unchanged = equal(snapshot, sent);
          publish({ ...(unchanged ? saved : {}), dirty: unchanged ? false : !equal(snapshot, saved), recovered: false });
          cache();
        }
        return true;
      } catch (cause) {
        publish({ error: cause instanceof Error ? cause.message : "保存失败，草稿已保留。" });
        cache();
        return false;
      } finally {
        inFlight = null;
        publish({ saving: false });
        cache();
      }
    })();
    return inFlight;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    update(patch: Partial<MarkdownDraftValue>) {
      const next = { ...snapshot, ...patch };
      if (next.content.length > 200_000) { publish({ error: "文档最多支持 200,000 字符。" }); return; }
      publish({ ...patch, dirty: !equal(next, saved), error: "" });
      cache();
      clearTimeout(timer);
      timer = setTimeout(() => { void save(); }, 800);
    },
    save,
    dispose() { clearTimeout(timer); if (!snapshot.error) void save(); },
  };
}
