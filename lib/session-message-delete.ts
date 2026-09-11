import type { FileEntry, SessionEntry } from "@earendil-works/pi-coding-agent";

export const DELETED_MESSAGE_TYPE = "piora-deleted-message";

export function persistedMessagePromptIds(entries: readonly SessionEntry[]): string[] {
  return entries.flatMap(entry => {
    if (entry.type === "message") {
      const message = entry.message as { role: string; clientPromptId?: string };
      return message.role === "user" && message.clientPromptId ? [message.clientPromptId] : [];
    }
    if (entry.type === "custom" && entry.customType === DELETED_MESSAGE_TYPE) {
      const data = entry.data as { clientPromptId?: unknown } | undefined;
      if (typeof data?.clientPromptId === "string") return [data.clientPromptId];
    }
    return [];
  });
}

/** Erase payloads while retaining tree IDs, parents and compaction boundaries. */
export function deleteSessionMessageEntries(entries: FileEntry[], entryId: string) {
  const target = entries.find(entry => entry.type !== "session" && entry.id === entryId) as SessionEntry | undefined;
  if (!target) throw new Error("消息不存在，请刷新后重试。");
  if (target.type === "custom" && target.customType === DELETED_MESSAGE_TYPE) return { entries, deletedIds: [entryId] };
  if (!["message", "custom_message", "compaction", "branch_summary"].includes(target.type)) throw new Error("此记录不是可删除的消息。");
  if (target.type === "message" && target.message.role === "toolResult") throw new Error("请通过对应的模型消息删除工具结果。");
  const deletedIds = new Set([entryId]);
  const toolIds = new Set<string>();
  if (target.type === "message" && target.message.role === "assistant") {
    for (const block of target.message.content) if (block.type === "toolCall") toolIds.add(block.id);
  }
  // Results must disappear with their tool calls, including results on branches.
  for (const entry of entries) if (entry.type === "message" && entry.message.role === "toolResult" && toolIds.has(entry.message.toolCallId)) deletedIds.add(entry.id);
  return {
    entries: entries.map(entry => {
      if (entry.type === "session" || !deletedIds.has(entry.id)) return entry;
      const id = entry.type === "message" && entry.message.role === "user" ? (entry.message as { clientPromptId?: string }).clientPromptId : undefined;
      return { type: "custom", customType: DELETED_MESSAGE_TYPE, id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp, ...(id ? { data: { clientPromptId: id } } : {}) } satisfies SessionEntry;
    }),
    deletedIds: [...deletedIds],
  };
}
