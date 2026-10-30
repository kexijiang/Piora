"use client";

import { useId } from "react";
import { evaluateExpression, type UiExpression, type UiNode, type UiState, type UiSurface } from "../../lib/intelligent-ui/surface-document";
import { RichSurfaceLayout } from "./RichSurfaceLayout";
import styles from "./IntelligentUiSurface.module.css";

export interface UiContentCopy { calculation: string; chart: string }

function display(expression: UiExpression, state: UiState, copy: UiContentCopy): string {
  try { return String(evaluateExpression(expression, state)); } catch { return copy.calculation; }
}

function NodeView({ node, state, disabled, change, prefix, copy }: {
  node: UiNode; state: UiState; disabled: boolean; change: (id: string, value: string | number | boolean) => void; prefix: string; copy: UiContentCopy;
}) {
  const id = `${prefix}-${node.id}`;
  if (node.type === "text") return <p className={styles.text}>{node.text}</p>;
  if (node.type === "dynamicText") return <p className={styles.text} data-ui-dynamic-text={node.id}>{node.parts.map(part => display(part, state, copy)).join("")}</p>;
  if (node.type === "metric") return <div className={styles.metric}><span id={`${id}-label`}>{node.label}</span><output aria-labelledby={`${id}-label`}>{display(node.value, state, copy)}</output></div>;
  if (node.type === "table") return <div className={styles.tableScroll} tabIndex={0}><table><thead><tr>{node.columns.map((column, index) => <th key={index} scope="col">{column}</th>)}</tr></thead><tbody>{node.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{display(cell, state, copy)}</td>)}</tr>)}</tbody></table></div>;
  if (node.type === "barChart") {
    const values = node.values.map(value => {
      try { const result = evaluateExpression(value, state); return typeof result === "number" && Number.isFinite(result) ? result : null; } catch { return null; }
    });
    const min = Math.min(0, ...values.map(value => value ?? 0));
    const max = Math.max(0, ...values.map(value => value ?? 0));
    const range = max - min || 1;
    return <figure className={styles.chart} aria-label={copy.chart}>{node.labels.map((label, index) => <div key={index} className={styles.barRow}><span id={`${id}-${index}-label`}>{label}</span><div className={styles.barTrack}><div className={styles.barZero} style={{ left: `${-min / range * 100}%` }} /><div className={styles.bar} style={{ width: `${Math.abs(values[index] ?? 0) / range * 100}%`, left: `${(Math.min(0, values[index] ?? 0) - min) / range * 100}%` }} /></div><output aria-labelledby={`${id}-${index}-label`}>{values[index] === null ? copy.calculation : values[index]}</output></div>)}</figure>;
  }
  if (node.type === "checkbox") return <label className={styles.checkbox} htmlFor={id}><input id={id} type="checkbox" checked={state[node.id] === true} disabled={disabled} onChange={event => change(node.id, event.currentTarget.checked)} /><span>{node.label}</span></label>;
  if (node.type === "select") return <label className={styles.control} htmlFor={id}><span>{node.label}</span><select id={id} value={String(state[node.id] ?? node.value)} disabled={disabled} onChange={event => change(node.id, event.currentTarget.value)}>{node.options.map(option => <option key={option} value={option}>{option}</option>)}</select></label>;
  return <label className={styles.control} htmlFor={id}><span>{node.label}{node.type === "slider" ? <output className={styles.sliderValue}>{String(state[node.id] ?? node.value)}</output> : null}</span><input id={id} type={node.type === "slider" ? "range" : "number"} value={Number(state[node.id] ?? node.value)} min={node.min} max={node.max} step={node.step ?? "any"} disabled={disabled} onChange={event => {
    const value = event.currentTarget.valueAsNumber;
    if (Number.isFinite(value) && event.currentTarget.validity.valid) change(node.id, value);
  }} /></label>;
}

export function SurfaceContents({ surface, state, disabled, change, copy, locale }: { surface: UiSurface; state: UiState; disabled: boolean; change: (id: string, value: string | number | boolean) => void; copy: UiContentCopy; locale: "en" | "zh-CN" }) {
  const prefix = useId();
  return <div className={styles.nodes}>{surface.version === 2
    ? <RichSurfaceLayout surface={surface} state={state} locale={locale} renderNode={node => <NodeView key={node.id} node={node} state={state} disabled={disabled} change={change} prefix={prefix} copy={copy} />} />
    : surface.nodes.map(node => <NodeView key={node.id} node={node} state={state} disabled={disabled} change={change} prefix={prefix} copy={copy} />)}</div>;
}
