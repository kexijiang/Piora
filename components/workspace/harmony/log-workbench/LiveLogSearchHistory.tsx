// Adapted from Alentaoker/dsh-harmoneydev-tools @ 8b178a755d33cee9899160a7be283af2b23eb85d.
// SPDX-License-Identifier: MIT; see third_party/harmony-log-workbench/SOURCE.md.
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { validateLogRegex } from "@/lib/harmony/log-workbench-filter";
import styles from "./RealtimeLogs.module.css";

/**
 * Client mirror of the server-side history entry. It is declared locally so the
 * browser bundle never imports the Node store module.
 */
export type LogSearchKind = "find" | "filter";
export interface LogSearchEntry { query: string; regex: boolean; caseSensitive: boolean; usedAt: string }

const HISTORY_URL = "/api/harmony/logs/search-history";

function keyOf(entry: { query: string; regex: boolean; caseSensitive: boolean }) {
  return `${entry.regex ? "re" : "lit"}:${entry.caseSensitive ? "cs" : "ci"}:${entry.query.trim()}`;
}

export function useLogSearchHistory(kind: LogSearchKind, enabled: boolean) {
  const [entries, setEntries] = useState<LogSearchEntry[]>([]);
  const [error, setError] = useState<string>();
  const loaded = useRef(false);

  const apply = useCallback((history: Record<LogSearchKind, LogSearchEntry[]>) => {
    setEntries(Array.isArray(history?.[kind]) ? history[kind].slice(0, 30) : []);
  }, [kind]);

  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(HISTORY_URL, { cache: "no-store", signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`);
      apply(payload.history);
      setError(undefined);
    } catch (cause) {
      if (signal?.aborted) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [apply]);

  useEffect(() => {
    if (!enabled || loaded.current) return;
    loaded.current = true;
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [enabled, reload]);

  const mutate = useCallback(async (body: Record<string, unknown>) => {
    try {
      const response = await fetch(HISTORY_URL, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, ...body }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`);
      apply(payload.history);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [apply, kind]);

  /** Only an explicitly valid and bounded pattern is remembered. */
  const record = useCallback((query: string, regex: boolean, caseSensitive: boolean) => {
    const text = query.trim();
    if (!text) return;
    // Reuse the same bounded dialect as the viewer so a pathological pattern
    // can never be stored and replayed against a whole log buffer.
    if (regex && validateLogRegex(text)) return;
    void mutate({ action: "record", query: text, regex, caseSensitive });
  }, [mutate]);

  const remove = useCallback((entry: LogSearchEntry) => void mutate({ action: "remove", query: entry.query, regex: entry.regex, caseSensitive: entry.caseSensitive }), [mutate]);
  const clear = useCallback(() => void mutate({ action: "clear" }), [mutate]);

  return { entries, error, record, remove, clear, reload };
}

/**
 * Visible history list for one search box. Arrow keys move the cursor, Enter
 * applies and Escape closes only this list.
 */
export function SearchHistoryMenu({ entries, cursor, onCursor, onPick, onRemove, onClear, onClose, copy }: {
  entries: LogSearchEntry[];
  cursor: number;
  onCursor: (next: number) => void;
  onPick: (entry: LogSearchEntry) => void;
  onRemove: (entry: LogSearchEntry) => void;
  onClear: () => void;
  onClose: () => void;
  copy: (zh: string, en: string) => string;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    node?.scrollIntoView({ block: "nearest" });
  }, [cursor]);
  return <div className={styles.logHistory} role="group" aria-label={copy("搜索历史", "Search history")} onMouseDown={event => event.preventDefault()}>
    <div className={styles.logHistoryHead}>
      <strong>{copy("最近使用", "Recent")}</strong>
      <span>{entries.length}/30</span>
      <button type="button" disabled={!entries.length} onClick={onClear}>{copy("清空", "Clear")}</button>
      <button type="button" onClick={onClose} aria-label={copy("关闭历史", "Close history")}>×</button>
    </div>
    {entries.length ? <ul ref={listRef} role="listbox" aria-label={copy("搜索历史条目", "Search history entries")}>
      {entries.map((entry, index) => <li key={keyOf(entry)} role="option" aria-selected={index === cursor} data-cursor={index === cursor ? "true" : undefined}
        onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => onCursor(index)} onClick={() => onPick(entry)}>
        <span className={styles.logHistoryQuery}>{entry.query}</span>
        <small>{entry.regex ? copy("正则", "regex") : copy("文本", "text")}{entry.caseSensitive ? ` · ${copy("区分大小写", "case")}` : ""}</small>
        <button type="button" aria-label={copy(`删除 ${entry.query}`, `Remove ${entry.query}`)} onClick={(event) => { event.stopPropagation(); onRemove(entry); }}>×</button>
      </li>)}
    </ul> : <p className={styles.logHistoryEmpty}>{copy("还没有历史记录。执行一次查找或筛选后会出现在这里。", "No history yet. An applied find or filter is remembered here.")}</p>}
  </div>;
}

/**
 * Search-box keyboard and filtering rules.
 *
 * Re-exported from the shared implementation in `plugin/dsh-e2e/src/log-search-menu.mjs`
 * so dshE2E's session-log viewer and this live pane cannot disagree about when
 * Enter applies history or when an IME composition owns the key.
 */
export { historyKeyAction, isComposingKey, nextCursor, filterHistoryEntries } from "@/lib/harmony/log-library/vendor/log-search-menu.mjs";
