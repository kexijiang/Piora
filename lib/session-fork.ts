import { SessionManager } from "@earendil-works/pi-coding-agent";

/** Shared by ordinary forks and the staged, state-aware publication path. */
export function resolveConversationForkAnchor(source: Pick<SessionManager, "getEntry">, entryId: string, includeEntry = false): string | null {
  const entry = source.getEntry(entryId);
  if (!entry) throw new Error("Invalid entry ID for forking");
  if (includeEntry && (entry.type !== "message"
    || !["user", "assistant"].includes(entry.message.role)
    || entry.message.role === "assistant" && entry.message.content.some(block => block.type === "toolCall"))) {
    throw new Error("Choose a user message or a completed assistant reply to create a branch.");
  }
  return includeEntry ? entry.id : entry.parentId;
}

export function createConversationFork(sourceFile: string, sessionDir: string, entryId: string, includeEntry = false): string {
  const source = SessionManager.open(sourceFile, sessionDir);
  const anchor = resolveConversationForkAnchor(source, entryId, includeEntry);
  if (!anchor) {
    const fork = SessionManager.create(source.getCwd(), sessionDir);
    fork.newSession({ parentSession: sourceFile });
    return fork.getSessionFile()!;
  }
  const file = source.createBranchedSession(anchor);
  if (!file) throw new Error("Failed to create forked session");
  return file;
}
