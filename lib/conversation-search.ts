import { createReadStream } from "node:fs";
import { stat as statFile } from "node:fs/promises";
import { setImmediate as yieldToIO } from "node:timers/promises";
import { createInterface } from "node:readline";
import { createUserAncestorResolver } from "./session-ancestors.ts";
import { matchesConversationFilter } from "./conversation-search-filter.ts";
import type { SessionFlags } from "./session-flags";
import type { SessionInfo } from "./types";

export const CONVERSATION_SEARCH_QUERY_LIMIT = 200;
export const CONVERSATION_SEARCH_RESULT_LIMIT = 100;
const CONVERSATION_SEARCH_CACHE_LIMIT = 512;
export const CONVERSATION_SEARCH_CACHE_BYTES = 64 * 1024 * 1024;

export type ConversationArchiveFilter = "active" | "archived" | "all";
export type ConversationSearchRole = "user" | "assistant";

export interface ConversationSearchResult {
  sessionId: string;
  entryId: string;
  role: ConversationSearchRole;
  title: string;
  snippet: string;
  matchStart: number;
  matchLength: number;
  timestamp: string;
  projectLabel: string;
  archived: boolean;
}

export interface ConversationSearchResponse {
  results: ConversationSearchResult[];
  durationMs: number;
  truncated: boolean;
}

export interface ConversationSearchOptions {
  archive: ConversationArchiveFilter;
  limit?: number;
  project?: string | null;
  query: string;
}

interface SearchableMessage {
  entryId: string;
  targetEntryId: string;
  role: ConversationSearchRole;
  text: string;
  timestamp: string;
}

interface SearchFileCacheEntry {
  mtimeMs: number;
  size: number;
  messages: SearchableMessage[];
  retainedBytes: number;
}

interface PendingIndex {
  controller: AbortController;
  promise: Promise<SearchableMessage[]>;
  subscribers: number;
}

declare global {
  var __pioraConversationSearchCache: Map<string, SearchFileCacheEntry> | undefined;
  var __pioraConversationSearchPending: Map<string, PendingIndex> | undefined;
}

function getCache(): Map<string, SearchFileCacheEntry> {
  globalThis.__pioraConversationSearchCache ??= new Map();
  return globalThis.__pioraConversationSearchCache;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => (
      Boolean(block)
      && typeof block === "object"
      && (block as { type?: unknown }).type === "text"
      && typeof (block as { text?: unknown }).text === "string"
    ))
    .map((block) => block.text)
    .join("\n");
}

function normalizedTimestamp(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return fallback;
}

export async function readSearchableMessages(filePath: string, fallbackTimestamp = "", signal?: AbortSignal): Promise<SearchableMessage[]> {
  signal?.throwIfAborted();
  const stat = await statFile(filePath);
  signal?.throwIfAborted();
  const cache = getCache();
  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    cache.delete(filePath);
    cache.set(filePath, cached);
    return cached.messages;
  }

  const pending: Map<string, PendingIndex> = globalThis.__pioraConversationSearchPending ??= new Map();
  const key = `${filePath}:${stat.mtimeMs}:${stat.size}`;
  let task = pending.get(key);
  if (!task || task.controller.signal.aborted) {
    const controller = new AbortController();
    task = { controller, subscribers: 0, promise: indexSearchableMessages(filePath, fallbackTimestamp, stat, controller.signal) };
    pending.set(key, task);
    const current = task;
    const remove = () => { if (pending.get(key) === current) pending.delete(key); };
    void task.promise.then(remove, remove);
  }
  const current = task;
  current.subscribers += 1;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return false;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      current.subscribers -= 1;
      if (!current.subscribers) current.controller.abort();
      return true;
    };
    const onAbort = () => { if (finish()) reject(signal!.reason); };
    signal?.addEventListener("abort", onAbort, { once: true });
    current.promise.then((value) => { if (finish()) resolve(value); }, (error) => { if (finish()) reject(error); });
    if (signal?.aborted) onAbort();
  });
}

async function indexSearchableMessages(filePath: string, fallbackTimestamp: string, stat: { mtimeMs: number; size: number }, signal: AbortSignal): Promise<SearchableMessage[]> {

  const messages: SearchableMessage[] = [];
  const userIds = new Set<string>();
  const parentById = new Map<string, string | null>();
  let lastEntryId: string | null = null;
  const input = createReadStream(filePath, { encoding: "utf8", signal });
  const lines = createInterface({
    input,
    crlfDelay: Infinity,
  });

  let lineCount = 0;
  try {
  for await (const line of lines) {
    if (++lineCount % 256 === 0) await yieldToIO();
    signal.throwIfAborted();
    try {
      const entry = JSON.parse(line) as {
        type?: unknown;
        id?: unknown;
        parentId?: unknown;
        timestamp?: unknown;
        message?: { role?: unknown; content?: unknown; timestamp?: unknown };
      };
      if (typeof entry.id === "string" && entry.type !== "session") {
        parentById.set(entry.id, typeof entry.parentId === "string" ? entry.parentId : null);
        lastEntryId = entry.id;
      }
      if (entry.type !== "message" || typeof entry.id !== "string" || !entry.message) continue;
      const role = entry.message.role;
      if (role === "user") userIds.add(entry.id);
      if (role !== "user" && role !== "assistant") continue;
      const text = textFromContent(entry.message.content).trim();
      if (!text) continue;
      const message: SearchableMessage = {
        entryId: entry.id,
        targetEntryId: entry.id,
        role,
        text,
        timestamp: normalizedTimestamp(entry.timestamp ?? entry.message.timestamp, fallbackTimestamp),
      };
      messages.push(message);
    } catch {
      // Ignore a partially-written or malformed JSONL line. Session browsing
      // follows the same resilience principle and the next file change will
      // invalidate this cache entry.
    }
  }
  } finally { lines.close(); input.destroy(); }
  signal.throwIfAborted();

  const activeEntryIds = new Set<string>();
  let cursor = lastEntryId;
  while (cursor && !activeEntryIds.has(cursor)) {
    activeEntryIds.add(cursor);
    cursor = parentById.get(cursor) ?? null;
  }
  const activeMessages = messages.filter((message) => activeEntryIds.has(message.entryId));
  const selectedMessages = activeMessages.length > 0 ? activeMessages : messages;
  const nearestUser = createUserAncestorResolver(parentById, userIds);
  const searchableMessages = selectedMessages.map((message) => {
    if (message.role === "user") return message;
    return { ...message, targetEntryId: nearestUser(message.entryId) ?? message.entryId };
  });
  const retainedBytes = searchableMessages.reduce((bytes, message) => bytes + 192
    + 2 * (message.text.length + message.entryId.length + message.targetEntryId.length + message.timestamp.length), 0);
  const cache = getCache();
  cache.delete(filePath);
  // A single oversized conversation is searchable without occupying the entire cache.
  if (retainedBytes <= CONVERSATION_SEARCH_CACHE_BYTES) cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, messages: searchableMessages, retainedBytes });
  let totalBytes = [...cache.values()].reduce((sum, entry) => sum + (entry.retainedBytes ?? entry.size * 2), 0);
  while (cache.size > CONVERSATION_SEARCH_CACHE_LIMIT || totalBytes > CONVERSATION_SEARCH_CACHE_BYTES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    const entry = cache.get(oldest)!;
    totalBytes -= entry.retainedBytes ?? entry.size * 2;
    cache.delete(oldest);
  }
  return searchableMessages;
}

function projectLabelFor(session: SessionInfo): string {
  if (session.projectless) return "Chats";
  const value = session.projectRoot ?? session.cwd;
  return (value.split(/[\\/]/).filter(Boolean).at(-1) ?? value).slice(0, 160);
}

function titleFor(session: SessionInfo): string {
  return (session.name?.trim() || session.firstMessage?.trim() || "Untitled chat").slice(0, 160);
}

function buildSnippet(text: string, matchIndex: number, matchLength: number): Pick<ConversationSearchResult, "snippet" | "matchStart" | "matchLength"> {
  const compact = text.replace(/\s+/g, " ").trim();
  const normalizedPrefix = text.slice(0, matchIndex).replace(/\s+/g, " ").trimStart();
  const compactMatchIndex = Math.min(compact.length, normalizedPrefix.length);
  const context = 88;
  const start = Math.max(0, compactMatchIndex - context);
  const end = Math.min(compact.length, compactMatchIndex + matchLength + context);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < compact.length ? "…" : "";
  return {
    snippet: `${prefix}${compact.slice(start, end)}${suffix}`,
    matchStart: prefix.length + compactMatchIndex - start,
    matchLength: Math.min(matchLength, Math.max(0, compact.length - compactMatchIndex)),
  };
}

export function normalizeConversationSearchOptions(input: Partial<ConversationSearchOptions>): ConversationSearchOptions {
  const query = typeof input.query === "string"
    ? input.query.trim().slice(0, CONVERSATION_SEARCH_QUERY_LIMIT)
    : "";
  const archive = input.archive === "active" || input.archive === "archived" || input.archive === "all"
    ? input.archive
    : "all";
  const requestedLimit = Number.isFinite(input.limit) ? Math.floor(input.limit as number) : 50;
  return {
    query,
    archive,
    project: typeof input.project === "string" && input.project.trim() ? input.project.trim() : null,
    limit: Math.max(1, Math.min(CONVERSATION_SEARCH_RESULT_LIMIT, requestedLimit)),
  };
}

export async function searchConversationSessions(
  sessions: SessionInfo[],
  flags: SessionFlags,
  rawOptions: Partial<ConversationSearchOptions>,
  signal?: AbortSignal,
): Promise<ConversationSearchResponse> {
  const startedAt = performance.now();
  const options = normalizeConversationSearchOptions(rawOptions);
  signal?.throwIfAborted();
  if (!options.query) return { results: [], durationMs: 0, truncated: false };

  const queryLower = options.query.toLocaleLowerCase();
  const candidates = sessions.filter((session) => matchesConversationFilter(session, flags, options.archive, options.project))
    .sort((left, right) => (Date.parse(right.modified) || 0) - (Date.parse(left.modified) || 0));

  const matches: ConversationSearchResult[] = [];
  // Results are grouped by recently active conversation, newest entries first.
  // Read one extra match to prove truncation without scanning every remaining file.
  let truncated = false;
  search:
  for (const session of candidates) {
    signal?.throwIfAborted();
    let searchable: SearchableMessage[];
    try {
      searchable = await readSearchableMessages(session.path, session.modified, signal);
    } catch {
      signal?.throwIfAborted();
      continue;
    }
    for (let index = searchable.length - 1; index >= 0; index -= 1) {
      if (index % 256 === 0) { await yieldToIO(); signal?.throwIfAborted(); }
      const message = searchable[index];
      const matchIndex = message.text.toLocaleLowerCase().indexOf(queryLower);
      if (matchIndex < 0) continue;
      if (matches.length >= (options.limit ?? 50)) { truncated = true; break search; }
      matches.push({
        sessionId: session.id,
        entryId: message.targetEntryId,
        role: message.role,
        title: titleFor(session),
        ...buildSnippet(message.text, matchIndex, options.query.length),
        timestamp: message.timestamp || session.modified,
        projectLabel: projectLabelFor(session),
        archived: flags[session.id]?.archived === true,
      });
    }
  }

  return {
    results: matches.slice(0, options.limit),
    durationMs: Math.round(performance.now() - startedAt),
    truncated,
  };
}
