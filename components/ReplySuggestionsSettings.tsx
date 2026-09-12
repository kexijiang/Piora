"use client";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useReplyDraft } from "@/hooks/useReplyDraft";
import { defaultReplySettings, REPLY_DEFAULT_PROMPT, REPLY_MAX_PROMPT, unicodeLength, type ReplyResult } from "@/lib/reply-suggestions";
import { readReplySettings, saveReplySettings } from "@/lib/reply-suggestions-settings";
import { ReplySuggestionBar, replyErrorKey } from "./ReplySuggestionBar";
import styles from "./ReplySuggestionBar.module.css";
import settingsStyles from "./SettingsDialog.module.css";

type Model = { id: string; provider: string; name: string };
export function ReplySuggestionsSettings({ cwd }: { cwd?: string }) {
  const { t, locale } = useI18n();
  const [config, setConfig] = useState(defaultReplySettings);
  const [models, setModels] = useState<Model[]>([]), [filter, setFilter] = useState("");
  const [modelsError, setModelsError] = useState(false), [catalogAttempt, setCatalogAttempt] = useState(0);
  const [status, setStatus] = useState("");
  const [sample, setSample] = useState(() => t("reply.sampleText"));
  const [preview, setPreview] = useState<{ key: string; result?: ReplyResult; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const draft = useReplyDraft(() => ({ value: "", spans: [] }));
  const modelValue = config.model ? JSON.stringify(config.model) : "";
  const available = models.some((m) => m.id === config.model?.modelId && m.provider === config.model.provider);
  const validPrompt = !!config.systemPrompt.trim() && unicodeLength(config.systemPrompt) <= REPLY_MAX_PROMPT;
  const testKey = JSON.stringify([config.model, config.systemPrompt, sample, cwd, locale]);
  const currentTestKey = useRef(testKey); currentTestKey.current = testKey;
  useEffect(() => { setConfig(readReplySettings()); }, []);
  useEffect(() => {
    const controller = new AbortController(); setModelsError(false); setModels([]);
    void fetch(`/api/models${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`, { signal: controller.signal }).then(async (res) => {
      const data = await res.json(); if (!res.ok || !Array.isArray(data.modelList)) throw new Error();
      if (!controller.signal.aborted) { setModels(data.modelList); setModelsError(!!data.modelError); }
    }).catch(() => { if (!controller.signal.aborted) setModelsError(true); });
    return () => controller.abort();
  }, [cwd, catalogAttempt]);
  useEffect(() => { abort.current?.abort(); setTesting(false); return () => abort.current?.abort(); }, [testKey]);
  const test = async () => {
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
    setTesting(true); setPreview(null); draft.reset({ value: "", spans: [] });
    try {
      const res = await fetch("/api/reply-suggestions/preview", { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal, body: JSON.stringify({ source: sample, model: config.model, systemPrompt: config.systemPrompt, cwd, locale }) });
      const data = await res.json();
      if (!controller.signal.aborted && testKey === currentTestKey.current) setPreview(res.ok ? { key: testKey, result: data } : { key: testKey, error: data.code ?? "provider_error" });
    } catch { if (!controller.signal.aborted) setPreview({ key: testKey, error: "network_error" }); }
    finally { if (abort.current === controller) setTesting(false); }
  };
  const candidates = models.filter((m) => `${m.provider} ${m.name} ${m.id}`.toLowerCase().includes(filter.toLowerCase()));
  const providers = [...new Set(candidates.map((m) => m.provider))];
  return <section className={settingsStyles.promptCard} aria-labelledby="reply-settings-heading">
    <header className={settingsStyles.promptCardHeader}><h3 data-settings-id="conversation.replySuggestions" id="reply-settings-heading">{t("reply.title")}</h3><p>{t("reply.description")}</p></header>
    <div className={`${settingsStyles.promptCardBody} ${styles.settingsBody}`}>
      <label className={styles.toggle}><input type="checkbox" checked={config.enabled} onChange={(e) => { setConfig({ ...config, enabled: e.target.checked }); setStatus(""); }} />{t("reply.enable")}</label>
      <p className={styles.note}>{t("reply.local")}</p>
      <div className={styles.field}>
        <label htmlFor="reply-model-filter">{t("reply.model")}</label>
        <input id="reply-model-filter" type="search" value={filter} placeholder={t("reply.searchModels")} aria-label={t("reply.searchModels")} onChange={(e) => setFilter(e.target.value)} />
        <select aria-label={t("reply.model")} value={modelValue} onChange={(e) => { setConfig({ ...config, model: e.target.value ? JSON.parse(e.target.value) : null }); setStatus(""); }}>
          <option value="">{t("reply.chooseModel")}</option>
          {config.model && !candidates.some((m) => m.id === config.model?.modelId && m.provider === config.model.provider) && <option value={modelValue}>{config.model.provider}/{config.model.modelId}{!available ? ` — ${t("reply.unavailable")}` : ""}</option>}
          {providers.map((provider) => <optgroup key={provider} label={provider}>{candidates.filter((m) => m.provider === provider).map((m) => <option key={m.id} value={JSON.stringify({ provider, modelId: m.id })}>{m.name} · {m.id}</option>)}</optgroup>)}
        </select>
        {(modelsError || (config.model && !available)) && <small>{t("reply.unavailable")} <button type="button" className={styles.action} onClick={() => setCatalogAttempt((n) => n + 1)}>{t("reply.retry")}</button></small>}
      </div>
      <label className={styles.field}><span>{t("reply.prompt")}</span><small>{t("reply.promptHelp")}</small><textarea aria-label={t("reply.prompt")} value={config.systemPrompt} onChange={(e) => { setConfig({ ...config, systemPrompt: e.target.value }); setStatus(""); }} /></label>
      <div className={styles.footer}><span role="status">{status ? t(status) : `${unicodeLength(config.systemPrompt).toLocaleString()} / 8,000`}</span><div className={styles.actions}>
        <button type="button" className={settingsStyles.secondaryButton} onClick={() => { setConfig({ ...config, systemPrompt: REPLY_DEFAULT_PROMPT }); setStatus(""); }}>{t("reply.restore")}</button>
        <button type="button" className={settingsStyles.primaryButton} disabled={!validPrompt || (config.enabled && !available)} onClick={() => { try { saveReplySettings(config); setStatus("reply.saved"); } catch { setStatus("reply.saveFailed"); } }}>{t("reply.save")}</button>
      </div></div>
      {!validPrompt && <p role="status" className={styles.note}>{t("reply.invalid")}</p>}
      <details className={styles.test}><summary>{t("reply.preview")}</summary><div className={styles.settingsBody}>
        <p className={styles.note}>{t("reply.previewHelp")}</p>
        <label className={styles.field}><span>{t("reply.sample")}</span><textarea value={sample} onChange={(e) => setSample(e.target.value)} /></label>
        <div><button type="button" className={settingsStyles.secondaryButton} disabled={testing || !available || !validPrompt || !sample.trim() || unicodeLength(sample) > 24_000} onClick={() => void test()}>{t(testing ? "reply.testing" : "reply.test")}</button></div>
        {preview && preview.key !== testKey && <p role="status" className={styles.note}>{t("reply.stalePreview")}</p>}
        {preview?.key === testKey && <div>
          {preview.error && <p role="alert" className={styles.note}>{t(replyErrorKey(preview.error))}</p>}
          {preview.result?.groups.length === 0 && <p role="status" className={styles.note}>{t("reply.empty")}</p>}
          <ReplySuggestionBar preview sourceKey={testKey} result={preview.result} draft={draft.draft} onChange={(next) => draft.commit(next)} />
        </div>}
        <textarea className={styles.previewDraft} aria-label={t("reply.previewDraft")} placeholder={t("reply.previewDraft")} value={draft.draft.value} onChange={(e) => draft.setValue(e.target.value)} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.nativeEvent.isComposing) { e.preventDefault(); draft.undo(e.shiftKey); } }} />
      </div></details>
    </div>
  </section>;
}
