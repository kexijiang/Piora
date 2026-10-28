"use client";

import { useEffect, useId, useMemo, useState, useSyncExternalStore } from "react";
import { useI18n } from "../../hooks/useI18n";
import { evaluateExpression, initialState, validateSurface, type UiExpression, type UiNode, type UiState, type UiSurface } from "../../lib/intelligent-ui/protocol";
import { surfaceState, type SurfaceState } from "./client-state";
import styles from "./IntelligentUiSurface.module.css";

export interface IntelligentUiSurfaceProps {
  payload: unknown;
  snapshot: string;
  sessionId?: string;
  toolCallId: string;
  entryId?: string;
  branchKey?: string;
  readOnly?: boolean;
}

const messages = {
  en: { loading: "Loading saved values…", saved: "Saved · available to your next message", saving: "Saving…", error: "Could not save or load values. Your local changes are retained.", retry: "Retry", conflict: "This answer changed in another branch or window. Your edits are kept; choose which values to use.", keep: "Save my values", reload: "Load saved values", invalid: "Enter a value within the allowed range.", preview: "Preview · controls become available after this part is saved", unavailable: "Interactive view unavailable", calculation: "Cannot calculate with these values", chart: "Bar chart", discard: "Discard unsaved changes" },
  "zh-CN": { loading: "正在加载已保存的参数…", saved: "已保存 · 后续追问可读取当前参数", saving: "正在保存…", error: "参数加载或保存失败，本地调整已保留。", retry: "重试", conflict: "其他窗口或分支中的内容已变化。你的调整已保留，请选择使用哪份参数。", keep: "保存我的参数", reload: "加载已保存参数", invalid: "请输入允许范围内的值。", preview: "预览 · 此部分保存后即可操作", unavailable: "交互界面暂不可用", calculation: "当前参数无法计算", chart: "条形图", discard: "放弃未保存调整" },
};
type Copy = typeof messages.en;

function display(expression: UiExpression, state: UiState, copy: Copy): string {
  try { return String(evaluateExpression(expression, state)); } catch { return copy.calculation; }
}

function NodeView({ node, state, disabled, change, prefix, copy }: {
  node: UiNode; state: UiState; disabled: boolean; change: (id: string, value: string | number | boolean) => void; prefix: string; copy: Copy;
}) {
  const id = `${prefix}-${node.id}`;
  if (node.type === "text") return <p className={styles.text}>{node.text}</p>;
  if (node.type === "metric") return <div className={styles.metric}><span>{node.label}</span><output>{display(node.value, state, copy)}</output></div>;
  if (node.type === "table") return <div className={styles.tableScroll} tabIndex={0}><table><thead><tr>{node.columns.map((column, index) => <th key={index} scope="col">{column}</th>)}</tr></thead><tbody>{node.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{display(cell, state, copy)}</td>)}</tr>)}</tbody></table></div>;
  if (node.type === "barChart") {
    const values = node.values.map(value => {
      try { const result = evaluateExpression(value, state); return typeof result === "number" && Number.isFinite(result) ? result : null; } catch { return null; }
    });
    const min = Math.min(0, ...values.map(value => value ?? 0));
    const max = Math.max(0, ...values.map(value => value ?? 0));
    const range = max - min || 1;
    return <figure className={styles.chart} aria-label={copy.chart}>{node.labels.map((label, index) => <div key={index} className={styles.barRow}><span>{label}</span><div className={styles.barTrack}><div className={styles.barZero} style={{ left: `${-min / range * 100}%` }} /><div className={styles.bar} style={{ width: `${Math.abs(values[index] ?? 0) / range * 100}%`, left: `${(Math.min(0, values[index] ?? 0) - min) / range * 100}%` }} /></div><output>{values[index] === null ? copy.calculation : values[index]}</output></div>)}</figure>;
  }
  if (node.type === "checkbox") return <label className={styles.checkbox} htmlFor={id}><input id={id} type="checkbox" checked={state[node.id] === true} disabled={disabled} onChange={event => change(node.id, event.currentTarget.checked)} /><span>{node.label}</span></label>;
  if (node.type === "select") return <label className={styles.control} htmlFor={id}><span>{node.label}</span><select id={id} value={String(state[node.id] ?? node.value)} disabled={disabled} onChange={event => change(node.id, event.currentTarget.value)}>{node.options.map(option => <option key={option} value={option}>{option}</option>)}</select></label>;
  return <label className={styles.control} htmlFor={id}><span>{node.label}{node.type === "slider" ? <output className={styles.sliderValue}>{String(state[node.id] ?? node.value)}</output> : null}</span><input id={id} type={node.type === "slider" ? "range" : "number"} value={Number(state[node.id] ?? node.value)} min={node.min} max={node.max} step={node.step ?? "any"} disabled={disabled} onChange={event => {
    const value = event.currentTarget.valueAsNumber;
    if (Number.isFinite(value) && event.currentTarget.validity.valid) change(node.id, value);
  }} /></label>;
}

function Contents({ surface, state, disabled, change, copy }: { surface: UiSurface; state: UiState; disabled: boolean; change: (id: string, value: string | number | boolean) => void; copy: Copy }) {
  const prefix = useId();
  return <div className={styles.nodes}>{surface.nodes.map(node => <NodeView key={node.id} node={node} state={state} disabled={disabled} change={change} prefix={prefix} copy={copy} />)}</div>;
}

function InteractiveSurface({ store, copy, branchKey }: { store: SurfaceState; copy: Copy; branchKey?: string }) {
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [actionError, setActionError] = useState(false);
  useEffect(() => { void store.load(true); }, [store, branchKey]);
  const act = (operation: () => Promise<void>) => { setActionError(false); void operation().catch(() => setActionError(true)); };
  const disabled = view.status === "loading" || !view.leafId;
  return <section className={styles.surface} aria-label={view.surface.title}>
    <header className={styles.header}><h3>{view.surface.title}</h3><span className={styles.badge}>Intelligent UI</span></header>
    <Contents surface={view.surface} state={view.state} disabled={disabled} copy={copy} change={(id, value) => {
      try { store.change(id, value); setActionError(false); } catch { setActionError(true); }
    }} />
    <footer className={styles.footer}>
      {view.status === "conflict" ? <div role="alert" className={styles.notice}><span>{copy.conflict}</span><div className={styles.actions}><button type="button" onClick={() => act(() => store.resolve(true))}>{copy.keep}</button><button type="button" onClick={() => act(() => store.resolve(false))}>{copy.reload}</button></div></div> : view.status === "error" ? <div role="alert" className={styles.notice}><span>{copy.error}</span><div className={styles.actions}><button type="button" onClick={() => act(store.retry)}>{copy.retry}</button>{view.leafId ? <button type="button" onClick={() => act(() => store.resolve(false))}>{copy.reload}</button> : null}</div></div> : <span role="status" aria-live="polite">{copy[view.status]}</span>}
      {actionError ? <span role="alert">{copy.invalid}</span> : null}
      {view.status === "error" || view.status === "conflict" ? <div className={styles.notice}><button type="button" onClick={() => act(store.discard)}>{copy.discard}</button></div> : null}
    </footer>
  </section>;
}

function ValidSurface({ surface, props, copy }: { surface: UiSurface; props: IntelligentUiSurfaceProps; copy: Copy }) {
  const { sessionId, toolCallId, readOnly } = props;
  const store = useMemo(() => !readOnly && sessionId ? surfaceState(sessionId, toolCallId, surface) : null, [sessionId, toolCallId, readOnly, surface]);
  if (store) return <InteractiveSurface store={store} copy={copy} branchKey={props.branchKey} />;
  return <section className={styles.surface} aria-label={surface.title}><header className={styles.header}><h3>{surface.title}</h3><span className={styles.badge}>Intelligent UI</span></header><Contents surface={surface} state={initialState(surface)} disabled change={() => {}} copy={copy} /><footer className={styles.footer}>{copy.preview}</footer></section>;
}

export default function IntelligentUiSurface(props: IntelligentUiSurfaceProps) {
  const { locale } = useI18n();
  const copy = messages[locale === "en" ? "en" : "zh-CN"];
  const surface = useMemo(() => { try { return validateSurface(props.payload); } catch { return null; } }, [props.payload]);
  if (!surface) return <section className={styles.surface}><p>{copy.unavailable}</p><pre className={styles.snapshot}>{props.snapshot}</pre></section>;
  return <ValidSurface surface={surface} props={props} copy={copy} />;
}
