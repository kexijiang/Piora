"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import styles from "./ArchivedChatsSettings.module.css";

interface TrashItem { id: string; title: string; cwd: string; count: number; trashedAt: number; expiresAt: number }

export function TrashSettings({ onChanged }: { onChanged?: () => void }) {
  const { t, locale } = useI18n();
  const [items, setItems] = useState<TrashItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [restored, setRestored] = useState<TrashItem | null>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const response = await fetch("/api/sessions/trash", { cache: "no-store", signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      if (!signal?.aborted) { setItems(body.sessions); setError(null); }
    } catch (reason) {
      if (!signal?.aborted) setError(String(reason));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const restore = async (id: string) => {
    setBusy(id);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/restore`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setRestored(items.find((item) => item.id === id) ?? null);
      setItems((current) => current.filter((item) => item.id !== id));
      setError(null);
      onChanged?.();
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(null); }
  };
  const filtered = items.filter((item) => `${item.title} ${item.cwd}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <div className={styles.page} aria-busy={loading}>
    <header className={styles.header}><div><h2>{t("trash.title")}</h2><p>{t("trash.description")}</p></div></header>
    <label className={styles.search}><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t("trash.search")} placeholder={t("trash.search")} /></label>
    {restored && <p role="status" className={styles.restoredNotice}>{t("trash.restored", { title: restored.title })} <a href={`?session=${encodeURIComponent(restored.id)}`}>{t("trash.openConversation")}</a></p>}
    {error && <div className={styles.error} role="alert"><span>{t("trash.failed", { error })}</span><button onClick={() => void load()}>{t("archive.retry")}</button></div>}
    {loading ? <p role="status">{t("archive.loading")}</p> : filtered.length === 0 ? <p className={styles.state}>{t("trash.empty")}</p> : null}
    <div className={styles.list}>{filtered.map((item) => <article className={styles.row} key={item.id}>
      <div className={styles.rowCopy}><div className={styles.rowTitle}>{item.title}</div>
        <div>{t("trash.item", { count: item.count, date: new Date(item.expiresAt).toLocaleDateString(locale) })}</div>
        <small title={item.cwd}>{item.cwd}</small>
      </div>
      <button className={styles.unarchiveButton} disabled={busy !== null} onClick={() => void restore(item.id)}>{busy === item.id ? t("archive.working") : t("trash.restore")}</button>
    </article>)}</div>
  </div>;
}
