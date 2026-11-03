"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import type { UpstreamMeme } from "@/lib/dsh-meme-bridge";
import styles from "./MemePicker.module.css";
interface State { available: boolean; status: { installed?: boolean; phase: string; version: string; error?: string; autoStart?: boolean; progress?: { received: number; total: number | null } }; memes: UpstreamMeme[] }
export function MemePicker({ onSelect, disabled }: { onSelect?: (markdown: string) => void; disabled?: boolean }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/memes"); const data = await response.json();
      if (!response.ok) throw new Error(data.error || response.statusText);
      setState(data);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }, []);
  useEffect(() => { if (!open) return; void load(); const timer = setInterval(() => void load(), 2000); return () => clearInterval(timer); }, [open, load]);
  async function action(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/memes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...extra }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || response.statusText);
      if (data.markdown) { onSelect?.(data.markdown); dialog.current?.close(); }
      else await load();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  const working = busy || ["installing", "starting", "stopping"].includes(state?.status.phase || "");
  return <>
    <button type="button" className={`${styles.trigger}${onSelect ? ` ${styles.iconTrigger}` : ""}`} disabled={disabled} onClick={() => setOpen(true)} title={t("memes.title")} aria-label={t("memes.title")}>{onSelect ? "☺" : t("memes.manage")}</button>
    {open && createPortal(<dialog ref={node => { dialog.current = node; if (node && !node.open) node.showModal(); }} className={styles.dialog} onClose={() => setOpen(false)}>
      <header><strong>DSH Meme · {state?.status.version || "0.1.76"}</strong><button type="button" onClick={() => dialog.current?.close()}>{t("memes.close")}</button></header>
      <p>{t("memes.notice")}</p>
      {state && !state.available && <p>{t("desktopExtensions.desktopOnly")}</p>}
      {state?.available && <>
        <p role="status">{t(`desktopExtensions.state.${state.status.phase as "absent" | "stopped" | "installing" | "starting" | "running" | "stopping" | "error"}`)}
          {state.status.progress?.total ? ` ${Math.floor(state.status.progress.received / state.status.progress.total * 100)}%` : ""}</p>
        <div className={styles.actions}>
          {!state.status.installed && <button type="button" disabled={working} onClick={() => void action("install")}>{t("memes.install")}</button>}
          {state.status.installed && <>
            <button type="button" disabled={working} onClick={() => void action(state.status.phase === "running" ? "stop" : "start")}>{t(state.status.phase === "running" ? "desktopExtensions.stop" : "desktopExtensions.start")}</button>
            <button type="button" disabled={working} onClick={() => void action("settings")}>{t("memes.manage")}</button>
            <button type="button" disabled={working} onClick={() => void action("uninstall")}>{t("desktopExtensions.uninstall")}</button>
          </>}
          {["installing", "starting"].includes(state.status.phase) && <button type="button" onClick={() => void action("cancel")}>{t("common.cancel")}</button>}
        </div>
        <label><input type="checkbox" checked={state.status.autoStart || false} disabled={working || !state.status.installed} onChange={e => void action("preferences", { autoStart: e.target.checked })} /> {t("desktopExtensions.autoStart")}</label>
      </>}
      {(error || state?.status.error) && <p role="alert">{error || state?.status.error}</p>}
      {state?.status.phase === "running" && <>
        <input className={styles.search} value={query} onChange={e => setQuery(e.target.value)} placeholder={t("memes.search")} aria-label={t("memes.search")} />
        {!state.memes.length && <p>{t("memes.empty")}</p>}
        <div className={styles.grid}>{state.memes.filter(item => `${item.caption} ${item.tag} ${item.keywords}`.toLowerCase().includes(query.toLowerCase())).map(item => <article key={item.url}>
          <button type="button" className={styles.image} disabled={working || !onSelect} title={item.caption} onClick={() => void action("capture", { url: item.url, caption: item.caption })}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/memes?image=${encodeURIComponent(item.url)}`} alt={item.caption} loading="lazy" />
            <span>{item.caption}</span>
          </button>
        </article>)}</div>
      </>}
    </dialog>, document.body)}
  </>;
}
