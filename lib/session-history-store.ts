import { statSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { entryToUiMessage, listAllSessions, resolveSessionIdByPath, resolveSessionPath } from "./session-reader";
import { restorePromptMaterialDisplay } from "./prompt-materials";
import { getMessageImageSource } from "./message-images";
import { buildHistoryIndex, historyMessage, historyPath, pairHistoryTools, type HistoryDetail, type HistoryIndex } from "./session-history";
import type { AgentMessage, SessionEntry, SessionHeader, ToolResultMessage } from "./types";

export class HistoryReadError extends Error {
  constructor(message: string, public status = 400, public code = "HISTORY_INVALID_REQUEST") { super(message); }
}
interface Snapshot { entries: SessionEntry[]; header: SessionHeader; index: HistoryIndex }
const cache = new Map<string, Snapshot>();
function revision(file: string) { const stat = statSync(file); return `${stat.mtimeMs}-${stat.size}`; }

export async function readHistoryVersion(id: string): Promise<string> {
  const file = await resolveSessionPath(id);
  if (!file) throw new HistoryReadError("Session not found", 404, "HISTORY_NOT_FOUND");
  return revision(file);
}

export async function readHistorySnapshot(id: string, expectedVersion?: string | null): Promise<Snapshot> {
  const file = await resolveSessionPath(id);
  if (!file) throw new HistoryReadError("Session not found", 404, "HISTORY_NOT_FOUND");
  const version = revision(file);
  if (expectedVersion && expectedVersion !== version) throw new HistoryReadError("History changed. Refresh to read the new snapshot.", 409, "HISTORY_CHANGED");
  const key = `${id}:${version}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const manager = SessionManager.open(file);
  const header = manager.getHeader() as SessionHeader | null;
  if (!header) throw new HistoryReadError("Session header is missing", 422);
  const entries = manager.getEntries() as unknown as SessionEntry[];
  if (revision(file) !== version) throw new HistoryReadError("History changed while reading. Retry the request.", 409, "HISTORY_CHANGED");
  const indexEntries = entries.map(entry => entry.type === "message" && entry.message.role === "user"
    ? { ...entry, message: entryToUiMessage(entry, {})! } : entry);
  const index = buildHistoryIndex(indexEntries, header, manager.getLeafId(), version);
  if (header.parentSession) {
    const parentId = await resolveSessionIdByPath(header.parentSession);
    if (parentId) index.related.push({ id: parentId, name: parentId, relation: "parent" });
  }
  for (const session of await listAllSessions()) {
    if (session.parentSessionId === id) index.related.push({ id: session.id, name: session.name || session.firstMessage.slice(0, 80) || session.id, relation: "child" });
    if (index.related.some(item => item.id === session.id && item.relation === "parent")) {
      index.related.find(item => item.id === session.id)!.name = session.name || session.firstMessage.slice(0, 80) || session.id;
    }
  }
  const snapshot = { entries, header, index };
  // Read-only, bounded optimization; changes are always checked against the file first.
  for (const existing of cache.keys()) if (existing.startsWith(`${id}:`)) cache.delete(existing);
  cache.set(key, snapshot);
  while (cache.size > 4) cache.delete(cache.keys().next().value!);
  return snapshot;
}

export function requireHistoryLeaf(snapshot: Snapshot, leafId: string | null): string | null {
  const leaf = leafId ?? snapshot.index.currentLeafId;
  if (leaf && !snapshot.index.nodes.some(node => node.id === leaf)) throw new HistoryReadError("History branch no longer exists", 404);
  return leaf;
}

export function restoreHistoryEntry(entry: SessionEntry): SessionEntry {
  if (entry.type !== "message" || entry.message.role !== "user") return entry;
  const content = entry.message.content;
  return { ...entry, message: { ...entry.message, content: typeof content === "string" ? restorePromptMaterialDisplay(content)
    : content.map(block => block.type === "text" ? { ...block, text: restorePromptMaterialDisplay(block.text) } : block) } };
}

function lazyHistoryMessage(snapshot: Snapshot, entry: SessionEntry): AgentMessage | null {
  const message = entryToUiMessage(entry, { deferThinking: true });
  if (!message || !("content" in message) || !Array.isArray(message.content)) return message;
  return { ...message, content: message.content.map((block, blockIndex) => {
    if (block.type !== "image") return block;
    const source = getMessageImageSource(block);
    if (source?.type !== "base64") return block;
    const query = new URLSearchParams({ entryId: entry.id, block: String(blockIndex), version: snapshot.index.version });
    return { type: "image", source: { type: "url", url: `/api/sessions/${encodeURIComponent(snapshot.header.id)}/history/media?${query}` } };
  }) } as AgentMessage;
}

export function readHistoryDetails(snapshot: Snapshot, leafId: string | null, ids: string[], original = false): HistoryDetail[] {
  if (!ids.length || ids.length > 80 || original && ids.length !== 1) throw new HistoryReadError("Request between 1 and 80 entries (one original message at a time)");
  const path = historyPath(snapshot.entries, requireHistoryLeaf(snapshot, leafId));
  const byId = new Map(path.map(entry => [entry.id, entry]));
  const pairs = pairHistoryTools(path);
  return ids.map(id => {
    const entry = byId.get(id);
    if (!entry) throw new HistoryReadError("Entry does not belong to the selected branch", 404);
    const message = original ? historyMessage(restoreHistoryEntry(entry)) : lazyHistoryMessage(snapshot, entry);
    const raw = entry.type === "custom_message" && message?.role === "custom" ? { ...entry, content: message.content } : entry;
    return { id, message,
      ...(entry.type !== "message" ? { raw } : {}),
      tools: (pairs.get(id) ?? []).map(result => lazyHistoryMessage(snapshot, result)).filter((result): result is ToolResultMessage => result?.role === "toolResult") };
  });
}

export function historyErrorResponse(error: unknown): Response {
  const known = error instanceof HistoryReadError;
  return Response.json({ error: error instanceof Error ? error.message : String(error), code: known ? error.code : "HISTORY_READ_FAILED" },
    { status: known ? error.status : 500, headers: { "Cache-Control": "no-store" } });
}
export function historyJson(value: unknown): Response { return Response.json(value, { headers: { "Cache-Control": "no-store" } }); }
