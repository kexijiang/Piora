"use client";
import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { ShellModelPreference } from "@/lib/shell/types";
import styles from "./SmartShell.module.css";

interface ModelData { modelList: Array<{ provider: string; id: string; name: string }>; thinkingLevels?: Record<string, string[]> }
export function ShellModelSelect({ cwd, value, onChange, inherited = false }: { cwd?: string; value: ShellModelPreference | null; onChange: (value: ShellModelPreference | null) => void; inherited?: boolean }) {
  const { t } = useI18n();
  const [data, setData] = useState<ModelData>({ modelList: [] });
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/models${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`, { signal: controller.signal, cache: "no-store" }).then(async response => {
      const result = await response.json(); if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`); if (!controller.signal.aborted) { setData(result); setError(""); }
    }).catch(cause => { if (!controller.signal.aborted) setError(String(cause)); });
    return () => controller.abort();
  }, [cwd]);
  const key = value ? `${value.provider}/${value.modelId}` : "";
  const unavailable = value && !data.modelList.some(model => `${model.provider}/${model.id}` === key);
  const levels = value ? data.thinkingLevels?.[`${value.provider}:${value.modelId}`] || ["off"] : [];
  return <div className={styles.model} title={error || undefined}>
    <select aria-label={t("shell.model")} value={key} onChange={event => {
      const model = data.modelList.find(item => `${item.provider}/${item.id}` === event.target.value);
      onChange(model ? { provider: model.provider, modelId: model.id } : null);
    }}>
      <option value="">{t(inherited ? "shell.modelInherited" : "shell.modelDefault")}</option>
      {unavailable && <option value={key}>{key}</option>}
      {data.modelList.map(model => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name} · {model.provider}</option>)}
    </select>
    {value && (levels.length > 1 || value.thinkingLevel) ? <select aria-label={t("shell.thinking")} value={value.thinkingLevel || ""} onChange={event => onChange({ ...value, thinkingLevel: event.target.value || undefined })}><option value="">{t("shell.thinkingDefault")}</option>{value.thinkingLevel && !levels.includes(value.thinkingLevel) ? <option value={value.thinkingLevel}>{value.thinkingLevel}</option> : null}{levels.map(level => <option key={level} value={level}>{level}</option>)}</select> : null}
    {error ? <span role="alert" className={styles.error}>{error}</span> : null}
  </div>;
}
