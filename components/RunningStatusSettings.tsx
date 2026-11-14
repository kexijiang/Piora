"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useRunningStatusLabel } from "@/hooks/useRunningStatusLabel";
import { defaultRunningStatusLabels, normalizeRunningStatusLabels, parseGeneratedRunningStatusLabels } from "@/lib/running-status-labels";
import { AliIcon } from "./AliIcon";
import shared from "./ModelRetrySettings.module.css";
import styles from "./RunningStatusSettings.module.css";

export function RunningStatusSettings({ cwd }: { cwd?: string }) {
  const { t, locale } = useI18n();
  const { labels, setLabels } = useRunningStatusLabel();
  const [draft, setDraft] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; key: string; model?: string } | null>(null);
  const [previewIndex, setPreviewIndex] = useState(0);
  const request = useRef<AbortController | null>(null);
  const id = useId();
  const saved = labels.length ? labels : defaultRunningStatusLabels(locale);
  const text = draft ?? saved.join("\n");
  let parsed: string[] | null = null;
  try { parsed = normalizeRunningStatusLabels(text.split(/\r?\n/)); } catch { /* Keep the saved library when validation fails. */ }
  const preview = parsed?.length ? parsed : saved;
  useEffect(() => () => { request.current?.abort(); }, []);

  const generate = async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setGenerating(true); setFeedback(null);
    try {
      const response = await fetch("/api/running-status/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale, ...(cwd ? { cwd } : {}) }), signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error === "model_unavailable" ? "settings.runningStatusNoModel" : "settings.runningStatusGenerateFailed");
      const generated = parseGeneratedRunningStatusLabels(JSON.stringify(result.labels));
      if (controller.signal.aborted) return;
      setLabels(generated); setDraft(null); setPreviewIndex(0);
      setFeedback({ error: false, key: "settings.runningStatusGenerated", model: typeof result.model === "string" ? result.model : "" });
    } catch (error) {
      if (!controller.signal.aborted) setFeedback({ error: true, key: error instanceof Error && error.message === "settings.runningStatusNoModel" ? error.message : "settings.runningStatusGenerateFailed" });
    } finally {
      if (request.current === controller) { request.current = null; setGenerating(false); }
    }
  };
  return <section className={shared.card} aria-labelledby={`${id}-title`}>
    <div className={shared.heading}>
      <span className={shared.icon}><AliIcon name="timer" size={17} /></span>
      <div>
        <h3 id={`${id}-title`}>{t("settings.runningStatusLabel")}</h3>
        <p id={`${id}-hint`}>{t("settings.runningStatusLabelHint")}</p>
      </div>
    </div>
    <div className={shared.fields}>
      <label className={styles.field}>
        <span>{t("settings.runningStatusText")}</span>
        <textarea className={styles.input} value={text} rows={8} disabled={generating}
          aria-describedby={`${id}-hint ${id}-count`} onChange={event => { setDraft(event.target.value); setFeedback(null); }} />
      </label>
    </div>
    <div className={styles.actions}>
      <span id={`${id}-count`} className={styles.caption}>{t("settings.runningStatusCount", { count: parsed?.length ?? 0 })}</span>
      <div>
        <button type="button" disabled={generating} onClick={() => { setLabels([]); setDraft(null); setFeedback(null); }}>{t("settings.runningStatusRestore")}</button>
        <button type="button" disabled={generating || parsed === null || draft === null} onClick={() => {
          if (!parsed) return;
          setLabels(parsed); setDraft(null); setFeedback({ error: false, key: "settings.runningStatusSaved" });
        }}>{t("settings.runningStatusSave")}</button>
        <button type="button" className={styles.generate} disabled={generating} onClick={() => void generate()}>
          <AliIcon name={generating ? "reload" : "solution"} size={14} />{t(generating ? "settings.runningStatusGenerating" : "settings.runningStatusGenerate")}
        </button>
      </div>
    </div>
    <p className={styles.caption}>{t("settings.runningStatusModelHint")}</p>
    {parsed === null ? <p className={styles.error} role="alert">{t("settings.runningStatusInvalid")}</p> : null}
    {feedback ? <p role={feedback.error ? "alert" : "status"} className={feedback.error ? styles.error : styles.caption}>{t(feedback.key, { model: feedback.model ?? "" })}</p> : null}
    <div className={styles.preview}>
      <div className={styles.previewHeading}><span className={styles.caption}>{t("settings.runningStatusPreview")}</span><button type="button" onClick={() => setPreviewIndex(index => (index + 1) % preview.length)}>{t("settings.runningStatusNextPreview")}</button></div>
      <div className={styles.status}>
        <span className={styles.dot} aria-hidden="true" />
        <span className={styles.label}>{preview[previewIndex % preview.length]}</span>
        <span className={styles.elapsed}>· {t("chat.taskDuration.elapsed")} 25s</span>
      </div>
    </div>
  </section>;
}
