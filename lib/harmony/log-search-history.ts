// Adapted from Alentaoker/dsh-harmoneydev-tools @ 8b178a755d33cee9899160a7be283af2b23eb85d.
// SPDX-License-Identifier: MIT; see third_party/harmony-log-workbench/SOURCE.md.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { getRuntimeAgentDataDirectory, type RuntimeHomeEnvironment } from "../runtime-home";

/**
 * Search history for the log workbench.
 *
 * One shared candidate list serves the live and the session-log views; each view
 * keeps its own applied filter state in the browser. Entries store the pattern
 * plus its regular-expression and case-sensitivity flags so a click restores the
 * exact search instead of only its text.
 */
export type LogSearchKind = "find" | "filter";

export interface LogSearchEntry {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  /** ISO timestamp of the most recent use. */
  usedAt: string;
}

export const LOG_SEARCH_HISTORY_LIMIT = 30;
const FILE_NAME = "harmony-log-search-history.json";
const MAX_QUERY_LENGTH = 400;

export function logSearchHistoryPath(environment: RuntimeHomeEnvironment = process.env): string {
  return join(getRuntimeAgentDataDirectory(environment), FILE_NAME);
}

function emptyStore(): Record<LogSearchKind, LogSearchEntry[]> {
  return { find: [], filter: [] };
}

function searchKey(value: { query: string; regex: boolean; caseSensitive: boolean }): string {
  return `${value.regex ? "re" : "lit"}:${value.caseSensitive ? "cs" : "ci"}:${value.query.trim()}`;
}

function sanitizeEntry(value: unknown): LogSearchEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.query !== "string") return undefined;
  const query = record.query.trim().slice(0, MAX_QUERY_LENGTH);
  if (!query) return undefined;
  const usedAt = typeof record.usedAt === "string" && record.usedAt ? record.usedAt : new Date(0).toISOString();
  return { query, regex: record.regex === true, caseSensitive: record.caseSensitive === true, usedAt };
}

export function normalizeLogSearchHistory(value: unknown): Record<LogSearchKind, LogSearchEntry[]> {
  const store = emptyStore();
  if (!value || typeof value !== "object") return store;
  const record = value as Record<string, unknown>;
  for (const kind of ["find", "filter"] as const) {
    const list = Array.isArray(record[kind]) ? record[kind] : [];
    const seen = new Set<string>();
    for (const item of list) {
      const entry = sanitizeEntry(item);
      if (!entry) continue;
      const key = searchKey(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      store[kind].push(entry);
      if (store[kind].length >= LOG_SEARCH_HISTORY_LIMIT) break;
    }
  }
  return store;
}

export function readLogSearchHistory(environment: RuntimeHomeEnvironment = process.env): Record<LogSearchKind, LogSearchEntry[]> {
  try {
    return normalizeLogSearchHistory(JSON.parse(readFileSync(logSearchHistoryPath(environment), "utf8")));
  } catch {
    // A missing or unreadable file is an empty history, never an error page.
    return emptyStore();
  }
}

export function writeLogSearchHistory(store: Record<LogSearchKind, LogSearchEntry[]>, environment: RuntimeHomeEnvironment = process.env): void {
  const path = logSearchHistoryPath(environment);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(path, JSON.stringify({ version: 1, ...normalizeLogSearchHistory(store) }));
}

/**
 * An invalid regular expression is never remembered: replaying it would only
 * reproduce a failed search.
 */
export function isValidLogSearchPattern(entry: { query: string; regex: boolean }, flags = ""): boolean {
  if (!entry.regex) return true;
  try { new RegExp(entry.query, flags); return true; } catch { return false; }
}

/** Recent-first, de-duplicated by pattern + flags, bounded to the limit. */
export function recordLogSearch(
  existing: LogSearchEntry[],
  candidate: { query: string; regex: boolean; caseSensitive: boolean; now?: number },
): LogSearchEntry[] {
  const current = normalizeLogSearchHistory({ find: existing }).find;
  const query = candidate.query.trim().slice(0, MAX_QUERY_LENGTH);
  if (!query) return current;
  if (!isValidLogSearchPattern({ query, regex: candidate.regex }, candidate.caseSensitive ? "" : "i")) return current;
  const entry: LogSearchEntry = { query, regex: candidate.regex, caseSensitive: candidate.caseSensitive, usedAt: new Date(candidate.now ?? Date.now()).toISOString() };
  return [entry, ...current.filter(value => searchKey(value) !== searchKey(entry))].slice(0, LOG_SEARCH_HISTORY_LIMIT);
}

export function removeLogSearch(existing: LogSearchEntry[], target: { query: string; regex: boolean; caseSensitive: boolean }): LogSearchEntry[] {
  const current = normalizeLogSearchHistory({ find: existing }).find;
  return current.filter(value => searchKey(value) !== searchKey({ ...target, query: target.query.trim() }));
}

export function updateLogSearchHistory(
  patch: { kind: LogSearchKind; action: "record"; query: string; regex: boolean; caseSensitive: boolean }
    | { kind: LogSearchKind; action: "remove"; query: string; regex: boolean; caseSensitive: boolean }
    | { kind: LogSearchKind; action: "clear" },
  environment: RuntimeHomeEnvironment = process.env,
): Record<LogSearchKind, LogSearchEntry[]> {
  const store = readLogSearchHistory(environment);
  if (patch.action === "clear") store[patch.kind] = [];
  else if (patch.action === "remove") store[patch.kind] = removeLogSearch(store[patch.kind], patch);
  else store[patch.kind] = recordLogSearch(store[patch.kind], patch);
  writeLogSearchHistory(store, environment);
  return store;
}
