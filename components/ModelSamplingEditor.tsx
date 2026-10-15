"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ModelErrorText } from "./ModelErrorText";
import { COMMON_SAMPLING_PARAMS, isSamplingObject, modelSamplingError, samplingParamsError, SAMPLING_APIS, SAMPLING_THINKING_LEVELS, type ModelSamplingConfig } from "@/lib/model-sampling";
import styles from "./ModelSamplingEditor.module.css";

function format(value: unknown): string {
  return value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function ParamsEditor({ value, onChange, label }: { value: unknown; onChange: (value: unknown) => void; label: string }) {
  const { t } = useI18n();
  const [json, setJson] = useState(() => format(value));
  const [numberDrafts, setNumberDrafts] = useState<Record<string, string>>({});
  const emitted = useRef(value);
  useEffect(() => {
    if (value !== emitted.current) { setJson(format(value)); setNumberDrafts({}); }
    emitted.current = value;
  }, [value]);
  const object = isSamplingObject(value) ? value : {};
  const error = samplingParamsError(value);
  const emit = (next: unknown) => { emitted.current = next; onChange(next); };
  return <div className={styles.params}>
    <div className={styles.fields}>
      {COMMON_SAMPLING_PARAMS.map(key => <label key={key}>
        <span>{key}</span>
        <input aria-label={`${label} ${key}`} type="text" inputMode="decimal"
          disabled={value !== undefined && !isSamplingObject(value)}
          placeholder={t("models.sampling.inherit")}
          value={numberDrafts[key] ?? (object[key] === undefined ? "" : String(object[key]))}
          onChange={event => {
            setNumberDrafts(previous => ({ ...previous, [key]: event.target.value }));
            const next = { ...object };
            const raw = event.target.value.trim();
            if (!raw) delete next[key];
            else next[key] = Number.isFinite(Number(raw)) ? Number(raw) : raw;
            const result = Object.keys(next).length ? next : undefined;
            setJson(format(result)); emit(result);
          }} />
      </label>)}
    </div>
    <label>
      <span>{t("models.sampling.json")}</span>
      <textarea aria-label={`${label} JSON`} rows={5} spellCheck={false} value={json} placeholder="{}"
        aria-invalid={Boolean(error)} onChange={event => {
          const raw = event.target.value;
          setNumberDrafts({});
          setJson(raw);
          if (!raw.trim()) { emit(undefined); return; }
          try {
            const parsed: unknown = JSON.parse(raw);
            // Retain invalid drafts in the model, so navigating away cannot
            // silently save the last valid value instead of the visible draft.
            emit(isSamplingObject(parsed) ? parsed : raw);
          } catch { emit(raw); }
        }} />
    </label>
    {error && <p role="alert" className={styles.error}>{t("models.sampling.invalid", { error })}</p>}
    <button type="button" onClick={() => { setJson(""); setNumberDrafts({}); emit(undefined); }}>{t("models.sampling.clear")}</button>
  </div>;
}

interface Preview {
  api: string;
  applicable: boolean;
  effectiveThinkingLevel: string;
  params: Record<string, unknown> | null;
}

export function ModelSamplingEditor<T extends ModelSamplingConfig & { id: string; api?: string }>({ providerName, provider, model, onChange }: {
  providerName: string;
  provider: { api?: string };
  model: T;
  onChange: (model: T) => void;
}) {
  const { t } = useI18n();
  const [scope, setScope] = useState("default");
  const [thinkingLevel, setThinkingLevel] = useState("off");
  const [requestParams, setRequestParams] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ fingerprint: string; preview?: Preview; error?: string; tested?: boolean; ok?: boolean }>();
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const api = model.api ?? provider.api ?? "openai-completions";
  const applicable = SAMPLING_APIS.includes(api);
  const levels = isSamplingObject(model.samplingParamsByThinkingLevel) ? model.samplingParamsByThinkingLevel : {};
  const error = modelSamplingError(model) ?? samplingParamsError(requestParams, "requestSamplingParams");
  const fingerprint = JSON.stringify([providerName, provider, model, thinkingLevel, requestParams]);
  const current = result?.fingerprint === fingerprint ? result : undefined;
  const edit = (value: unknown) => {
    if (scope === "default") { onChange({ ...model, samplingParams: value }); return; }
    const next = { ...levels };
    if (value === undefined) delete next[scope]; else next[scope] = value;
    onChange({ ...model, samplingParamsByThinkingLevel: Object.keys(next).length ? next : undefined });
  };
  const preview = async (test: boolean) => {
    if (error || busy || !model.id.trim()) return;
    controller.current?.abort();
    const pending = new AbortController(); controller.current = pending;
    setBusy(true); setResult(undefined);
    try {
      const response = await fetch("/api/models-config/test", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: pending.signal,
        body: JSON.stringify({ providerName, provider, model, thinkingLevel, requestSamplingParams: requestParams, previewOnly: !test }),
      });
      const data = await response.json();
      setResult({ fingerprint, preview: data.samplingPreview, tested: test, ok: response.ok && data.ok,
        error: !response.ok || !data.ok ? data.error ?? `HTTP ${response.status}` : undefined });
    } catch (error) {
      if (!pending.signal.aborted) setResult({ fingerprint, error: String(error) });
    } finally { if (!pending.signal.aborted) setBusy(false); }
  };
  return <section className={styles.editor} aria-label={t("models.sampling.title")}>
    <h4>{t("models.sampling.title")}</h4>
    <p>{t("models.sampling.hint")}</p>
    {!applicable && <p role="status">{t("models.sampling.unsupported", { api })}</p>}
    <label><span>{t("models.sampling.scope")}</span>
      <select aria-label={t("models.sampling.scope")} value={scope} onChange={event => setScope(event.target.value)}>
        <option value="default">{t("models.sampling.defaults")}</option>
        {SAMPLING_THINKING_LEVELS.map(level => <option key={level} value={level}>{level}</option>)}
      </select>
    </label>
    <ParamsEditor key={scope} label={scope} value={scope === "default" ? model.samplingParams : levels[scope]} onChange={edit} />
    {error && <p role="alert" className={styles.error}>{t("models.sampling.invalid", { error })}</p>}
    {model.samplingParamsByThinkingLevel !== undefined && <button type="button"
      onClick={() => onChange({ ...model, samplingParamsByThinkingLevel: undefined })}>{t("models.sampling.clearLevels")}</button>}
    <details>
      <summary>{t("models.sampling.preview")}</summary>
      <p>{t("models.sampling.previewHint")}</p>
      <label><span>{t("models.sampling.requestLevel")}</span>
        <select aria-label={t("models.sampling.requestLevel")} value={thinkingLevel} onChange={event => setThinkingLevel(event.target.value)}>
          {SAMPLING_THINKING_LEVELS.map(level => <option key={level} value={level}>{level}</option>)}
        </select>
      </label>
      <details><summary>{t("models.sampling.requestParams")}</summary>
        <ParamsEditor label="request" value={requestParams} onChange={setRequestParams} />
      </details>
      <div className={styles.actions}>
        <button type="button" disabled={!!error || busy || !model.id.trim()} onClick={() => void preview(false)}>{t("models.sampling.preview")}</button>
        <button type="button" disabled={!applicable || current?.preview?.applicable === false || !!error || busy || !model.id.trim()} onClick={() => void preview(true)}>{t("models.sampling.test")}</button>
      </div>
      <div aria-live="polite">
        {busy && <p>{t("i18n.checking")}</p>}
        {current?.error && <p role="alert" className={styles.error}><ModelErrorText value={current.error} /></p>}
        {current?.tested && current.ok && <p>{t("i18n.connected")}</p>}
        {current?.preview && (current.preview.applicable ? <>
          <p>{t("models.sampling.effective", { requested: thinkingLevel, effective: current.preview.effectiveThinkingLevel })}</p>
          <pre data-sampling-effective>{JSON.stringify(current.preview.params, null, 2)}</pre>
        </> : <p>{t("models.sampling.unsupported", { api: current.preview.api })}</p>)}
      </div>
    </details>
  </section>;
}
