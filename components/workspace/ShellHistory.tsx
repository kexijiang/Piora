"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { shellRequest } from "@/lib/shell/client";
import type { HistoryRecord } from "@/lib/shell/types";
import styles from "./SmartShell.module.css";

export function ShellHistory({ terminalId, cwd, onChoose }: { terminalId: string; cwd: string; onChoose: (command: string) => void }) {
  const { t } = useI18n();
  const [query, setQuery] = useState(""); const [source, setSource] = useState(""); const [scope, setScope] = useState(false); const [favorites, setFavorites] = useState(false);
  const [records, setRecords] = useState<HistoryRecord[]>([]); const [hasMore, setHasMore] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [searchKind, setSearchKind] = useState<"literal" | "semantic">("literal");
  const request = useRef<AbortController | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = useCallback(() => { request.current?.abort(); request.current = null; if (debounce.current) clearTimeout(debounce.current); debounce.current = null; }, []);
  const load = useCallback(async (offset = 0, semantic = false) => {
    cancel();
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(""); setSearchKind(semantic ? "semantic" : "literal");
    const filters = { ...(source ? { source } : {}), ...(scope ? { cwd } : {}), ...(favorites ? { favorite: true } : {}) };
    const params = new URLSearchParams({ q: query, offset: String(offset), ...Object.fromEntries(Object.entries(filters).map(([key, value]) => [key, String(value)])) });
    try {
      const result = semantic
        ? await shellRequest<{ records: HistoryRecord[]; hasMore?: boolean }>("history/search", { query, terminalId, filters }, { signal: controller.signal })
        : await shellRequest<{ records: HistoryRecord[]; hasMore: boolean }>(`history?${params}`, undefined, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setRecords(items => offset ? [...new Map([...items, ...result.records].map(record => [record.id, record])).values()] : result.records); setHasMore(Boolean(result.hasMore));
    } catch (cause) { if (!controller.signal.aborted) setError(String(cause)); }
    finally { if (!controller.signal.aborted) { setBusy(false); request.current = null; } }
  }, [query, source, scope, cwd, favorites, terminalId, cancel]);
  useEffect(() => { debounce.current = setTimeout(() => { void load(); }, 120); return cancel; }, [load, cancel]);
  const semantic = async () => {
    if (!query.trim() || busy && searchKind === "semantic") return;
    await load(0, true);
  };
  const favorite = async (record: HistoryRecord) => { cancel(); setBusy(false); try { await shellRequest(`history/${record.id}`, { favorite: !record.favorite }, { method: "PATCH" }); setRecords(items => items.map(item => item.id === record.id ? { ...item, favorite: !record.favorite } : item).filter(item => !favorites || item.favorite)); } catch (cause) { setError(String(cause)); } };
  const remove = async (id: string) => { cancel(); setBusy(false); try { await shellRequest(`history/${id}`, undefined, { method: "DELETE" }); setRecords(items => items.filter(item => item.id !== id)); } catch (cause) { setError(String(cause)); } };
  return <div className={styles.history}>
    <div className={styles.historySearch}>
      <input autoFocus value={query} onChange={event => { cancel(); setQuery(event.target.value); }} placeholder={t("shell.searchHistory")} aria-label={t("shell.searchHistory")} onKeyDown={event => { event.stopPropagation(); if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) void semantic(); }} />
      <div className={styles.historyFilters}>
        <select aria-label={t("shell.sources")} value={source} onChange={event => { cancel(); setSource(event.target.value); }}><option value="">{t("shell.allSources")}</option>{["human", "shell-agent", "pi-agent", "powershell", "bash", "zsh", "legacy"].map(value => <option key={value}>{value}</option>)}</select>
        <button aria-pressed={scope} onClick={() => { cancel(); setScope(value => !value); }}>{t(scope ? "shell.thisProject" : "shell.allProjects")}</button>
        <button aria-pressed={favorites} onClick={() => { cancel(); setFavorites(value => !value); }}>☆ {t("shell.favorites")}</button>
        <button disabled={busy && searchKind === "semantic" || !query.trim()} className={styles.primary} onClick={() => void semantic()}>{t(busy && searchKind === "semantic" ? "shell.searching" : "shell.searchMeaning")}</button>
      </div>
    </div>
    {error ? <div className={styles.error} role="alert">{error}</div> : null}
    <div className={styles.historyRecords} aria-busy={busy}>{records.length ? records.map(record => <article className={styles.historyRecord} key={record.id}>
      <button title={t("shell.edit")} onClick={() => onChoose(record.command)}><code>{record.command}</code></button>
      <div className={styles.blockMeta}><span title={record.cwd || ""}>{record.cwd || t("shell.unknown")}</span><span>{record.source}</span><span>{record.executedAt ? new Date(record.executedAt).toLocaleDateString() : "—"}</span></div>
      <div className={styles.blockActions}><button aria-pressed={record.favorite} onClick={() => void favorite(record)}>{record.favorite ? "★" : "☆"} {t("shell.favorite")}</button><button onClick={() => void remove(record.id)}>{t("shell.delete")}</button></div>
    </article>) : <div className={styles.empty}>{t(busy ? "shell.searching" : "shell.noHistory")}</div>}{hasMore ? <button disabled={busy} onClick={() => void load(records.length)}>{t("shell.loadMore")}</button> : null}</div>
  </div>;
}
