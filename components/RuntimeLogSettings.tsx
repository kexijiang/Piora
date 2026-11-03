"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { copyText } from "@/lib/clipboard";
import type { LogSettings, RuntimeLogInfo } from "@/desktop/src/logger";
import styles from "./SettingsDialog.module.css";

export function RuntimeLogSettings() {
  const { t } = useI18n();
  const [info, setInfo] = useState<RuntimeLogInfo | null>(null);
  const [draft, setDraft] = useState<LogSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [action, setAction] = useState<"idle" | "copying" | "copied" | "opening" | "copyFailed" | "openFailed">("idle");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setInfo(null);
      setAction("idle");
      try {
        const result = await window.piDesktop?.getRuntimeLog?.();
        if (!cancelled) { setInfo(result ?? null); setDraft(result?.settings ?? null); }
      } catch {
        if (!cancelled) setInfo(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [revision]);

  const copyPath = async () => {
    if (!info) return;
    setAction("copying");
    try {
      await copyText(info.filePath);
      setAction("copied");
    } catch {
      setAction("copyFailed");
    }
  };

  const revealLog = async () => {
    if (!info) return;
    setAction("opening");
    try {
      const opened = await window.piDesktop?.revealPath?.(info.filePath);
      setAction(opened ? "idle" : "openFailed");
    } catch {
      setAction("openFailed");
    }
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true); setFeedback(""); setFailed(false);
    try {
      const result = await window.piDesktop?.setRuntimeLog?.(draft);
      if (!result?.ok || !result.info) throw new Error(result?.error || t("settings.runtimeLog.unavailable"));
      setInfo(result.info); setDraft(result.info.settings); setFeedback(t("settings.runtimeLog.saved"));
    } catch (error) { setFailed(true); setFeedback(String(error)); }
    finally { setSaving(false); }
  };
  const busy = saving || loading || action === "copying" || action === "opening";
  return <section className={styles.conversationSection} data-settings-id="general.runtimeLog">
    <div className={styles.agentDataHeader}>
      <div className={styles.conversationCopy}>
        <div className={styles.rowTitle}>{t("settings.runtimeLog.title")}</div>
        <div className={styles.rowDescription}>{t("settings.runtimeLog.description")}</div>
      </div>
    </div>
    <div className={styles.agentDataBody}>
      {info ? <>
        <div className={styles.agentDataField}>
          <span>{t("settings.runtimeLog.path")}</span>
          <code className={styles.runtimeLogPath}>{info.filePath}</code>
        </div>
        <div className={styles.rowDescription} role="status">
          {info.fileLoggingAvailable ? t("settings.runtimeLog.effective", { level: info.settings.level, size: info.settings.maxSizeMiB, count: info.settings.backups }) : t("settings.runtimeLog.unwritable")}
        </div>
      </> : <div className={styles.rowDescription} role="status">
        {t(loading ? "settings.runtimeLog.loading" : "settings.runtimeLog.unavailable")}
      </div>}
      {draft && info && <fieldset disabled={busy} className={styles.logConfig}>
        <legend>{t("settings.runtimeLog.configure")}</legend>
        <label>{t("settings.runtimeLog.directory")}<input value={draft.directory} onChange={event => setDraft({ ...draft, directory: event.target.value })} /></label>
        <div className={styles.agentDataActions}>
          <button type="button" className={styles.secondaryButton} onClick={() => { void (async () => {
            try { const directory = await window.piDesktop?.selectDirectory(); if (directory) setDraft(current => current ? { ...current, directory } : current); }
            catch (error) { setFailed(true); setFeedback(String(error)); }
          })(); }}>{t("settings.runtimeLog.choose")}</button>
          <button type="button" className={styles.secondaryButton} onClick={() => setDraft({ directory: info.defaultDirectory, level: "info", maxSizeMiB: 5, backups: 1 })}>{t("settings.runtimeLog.defaults")}</button>
        </div>
        <label>{t("settings.runtimeLog.level")}<select value={draft.level} onChange={event => setDraft({ ...draft, level: event.target.value as LogSettings["level"] })}>{["error", "warn", "info", "debug"].map(level => <option key={level}>{level}</option>)}</select></label>
        <label>{t("settings.runtimeLog.size")}<input type="number" min={1} max={100} value={draft.maxSizeMiB} onChange={event => setDraft({ ...draft, maxSizeMiB: Number(event.target.value) })} /></label>
        <label>{t("settings.runtimeLog.backups")}<input type="number" min={1} max={20} value={draft.backups} onChange={event => setDraft({ ...draft, backups: Number(event.target.value) })} /></label>
        <p className={styles.rowDescription}>{t("settings.runtimeLog.scope")}</p>
        <button type="button" className={styles.secondaryButton} onClick={() => { void save(); }}>{t("settings.runtimeLog.save")}</button>
      </fieldset>}
      {feedback && <div role={failed ? "alert" : "status"} className={failed ? styles.agentDataError : styles.rowDescription}>{feedback}</div>}
      <div className={styles.agentDataActions}>
        <button type="button" className={styles.secondaryButton} disabled={!info || busy} onClick={() => { void copyPath(); }}>
          {t(action === "copied" ? "settings.runtimeLog.copied" : "settings.runtimeLog.copy")}
        </button>
        <button type="button" className={styles.secondaryButton} disabled={!info?.fileLoggingAvailable || busy} onClick={() => { void revealLog(); }}>
          {t("settings.runtimeLog.openFolder")}
        </button>
        <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => setRevision(value => value + 1)}>
          {t("settings.runtimeLog.refresh")}
        </button>
      </div>
      {action === "copyFailed" || action === "openFailed" ? <div className={styles.agentDataError} role="alert">
        {t(`settings.runtimeLog.${action}`)}
      </div> : null}
    </div>
  </section>;
}
