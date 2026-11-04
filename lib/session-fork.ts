import { SessionManager } from "@earendil-works/pi-coding-agent";

export function createConversationFork(sourceFile: string, sessionDir: string, entryId: string, includeEntry = false): string {
  const source = SessionManager.open(sourceFile, sessionDir);
  const entry = source.getEntry(entryId);
  if (!entry) throw new Error("Invalid entry ID for forking");
  if (includeEntry && (entry.type !== "message"
    || !["user", "assistant"].includes(entry.message.role)
    || entry.message.role === "assistant" && entry.message.content.some(block => block.type === "toolCall"))) {
    throw new Error("Choose a user message or a completed assistant reply to create a branch.");
  }
  const anchor = includeEntry ? entry.id : entry.parentId;
  if (!anchor) {
    const fork = SessionManager.create(source.getCwd(), sessionDir);
    fork.newSession({ parentSession: sourceFile });
    return fork.getSessionFile()!;
  }
  const file = source.createBranchedSession(anchor);
  if (!file) throw new Error("Failed to create forked session");
  return file;
}
