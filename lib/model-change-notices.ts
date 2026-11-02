import type { SessionEntry } from "./types";
import type { ChatHistoryRow } from "./chat-history";

export interface ModelIdentity { provider: string; modelId: string }
export interface ModelChangeNotice {
  id: string;
  afterEntryId: string;
  from: ModelIdentity;
  to: ModelIdentity;
}

/** Project persisted model metadata onto the visible branch without adding model-context messages. */
export function collectModelChangeNotices(entries: SessionEntry[], leafId: string | null | undefined, visibleIds: string[]): ModelChangeNotice[] {
  if (leafId === null) return [];
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const path: SessionEntry[] = [];
  const seen = new Set<string>();
  let entry = leafId ? byId.get(leafId) : entries.at(-1);
  while (entry && !seen.has(entry.id)) {
    seen.add(entry.id);
    path.push(entry);
    entry = entry.parentId ? byId.get(entry.parentId) : undefined;
  }
  const visible = new Map(visibleIds.map((id, index) => [id, index]));
  const notices: ModelChangeNotice[] = [];
  let model: ModelIdentity | undefined;
  let afterEntryId: string | undefined;
  let afterIndex = -1;
  let hasReply = false;
  for (const current of path.reverse()) {
    // The SDK places a compaction summary before retained messages, although
    // the summary entry was appended later. Anchor to the last displayed row.
    const index = visible.get(current.id);
    if (index !== undefined && index > afterIndex) {
      afterEntryId = current.id;
      afterIndex = index;
    }
    if (current.type === "message" && current.message.role === "assistant") {
      hasReply = true;
      if (current.message.provider && current.message.model) model = { provider: current.message.provider, modelId: current.message.model };
    }
    if (current.type !== "model_change") continue;
    const next = { provider: current.provider, modelId: current.modelId };
    if (hasReply && afterEntryId && model && (model.provider !== next.provider || model.modelId !== next.modelId)) {
      notices.push({ id: current.id, afterEntryId, from: model, to: next });
    }
    model = next;
  }
  return notices;
}

/** Insert after all fragments of the anchored message, outside collapsed process groups. */
export function insertModelChangeRows(rows: ChatHistoryRow[], entryIds: string[], notices: ModelChangeNotice[]): ChatHistoryRow[] {
  if (!notices.length) return rows;
  const indices = new Map(entryIds.map((id, index) => [id, index]));
  const added = notices.flatMap(notice => {
    const index = indices.get(notice.afterEntryId);
    return index === undefined ? [] : [{ key: `model-change:${notice.id}`, index: index + .5, modelChange: notice }];
  });
  return [...rows, ...added].sort((a, b) => a.index - b.index);
}
