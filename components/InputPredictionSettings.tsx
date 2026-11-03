"use client";
import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { defaultPredictionSettings, readPredictionSettings, savePredictionSettings } from "@/lib/input-prediction";
import { fetchModelCatalog, type ModelCatalogEntry } from "@/lib/model-catalog-client";
import styles from "./SettingsDialog.module.css";
export function InputPredictionSettings({ cwd }: { cwd?: string }) {
  const { locale } = useI18n(); const zh = locale === "zh-CN";
  const [project, setProject] = useState(false);
  const [config, setConfig] = useState(defaultPredictionSettings);
  const [models, setModels] = useState<ModelCatalogEntry[]>([]);
  const [status, setStatus] = useState("");
  useEffect(() => { setConfig(readPredictionSettings(project ? cwd : undefined)); setStatus(""); }, [cwd, project]);
  useEffect(() => { const controller = new AbortController(); void fetchModelCatalog({ cwd, signal: controller.signal }).then(data => setModels(data.modelList ?? [])).catch(() => { if (!controller.signal.aborted) setStatus(zh ? "模型列表暂不可用" : "Model list unavailable"); }); return () => controller.abort(); }, [cwd, zh]);
  return <section className={styles.promptCard}>
    <header className={styles.promptCardHeader}><h3>{zh ? "下一轮输入预测" : "Next message prediction"}</h3><p>{zh ? "回复结束后使用会话上下文调用所选模型，产生额外调用费用。预测仅作占位提示，Tab 采纳后仍需手动发送。" : "Uses conversation context with the selected model after a reply, with additional model costs. Tab accepts the placeholder; sending remains manual."}</p></header>
    <div className={styles.promptCardBody} style={{ display: "grid", gap: 12 }}>
      {cwd ? <label><input type="checkbox" checked={project} onChange={event => setProject(event.target.checked)} />{zh ? "编辑当前项目设置" : "Edit project override"}</label> : null}
      <label><input type="checkbox" checked={config.enabled} onChange={event => setConfig({ ...config, enabled: event.target.checked })} />{zh ? "启用输入预测" : "Enable prediction"}</label>
      <label>{zh ? "预测模型" : "Prediction model"}<select aria-label={zh ? "预测模型" : "Prediction model"} value={config.model ? JSON.stringify(config.model) : ""} onChange={event => setConfig({ ...config, model: event.target.value ? JSON.parse(event.target.value) : null })}>
        <option value="">{zh ? "选择模型" : "Choose model"}</option>{models.map(model => <option key={`${model.provider}/${model.id}`} value={JSON.stringify({ provider: model.provider, modelId: model.id })}>{model.provider} / {model.name}</option>)}
      </select></label>
      <label>{zh ? "超时（秒）" : "Timeout (seconds)"}<input type="number" min={5} max={120} value={config.timeoutMs / 1000} onChange={event => setConfig({ ...config, timeoutMs: Number(event.target.value) * 1000 })} /></label>
      <button type="button" disabled={config.enabled && !config.model} onClick={() => { try { savePredictionSettings(config, project ? cwd : undefined); setStatus(zh ? "已保存" : "Saved"); } catch { setStatus(zh ? "保存失败，请检查超时设置与存储权限" : "Save failed; check timeout and storage access"); } }}>{zh ? "保存输入预测设置" : "Save prediction settings"}</button>
      {project ? <button type="button" onClick={() => { try { savePredictionSettings(null, cwd); setConfig(readPredictionSettings()); setStatus(zh ? "已恢复全局设置" : "Global settings restored"); } catch { setStatus(zh ? "保存失败" : "Save failed"); } }}>{zh ? "恢复全局设置" : "Use global settings"}</button> : null}
      <span role="status">{status}</span>
    </div>
  </section>;
}
