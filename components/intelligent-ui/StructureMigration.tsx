"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flushPendingAnswerState } from "../../lib/answer-output-client";
import type { UiMigrationReview, MigrationControl } from "../../lib/intelligent-ui/structure-migration";
import type { UiState } from "../../lib/intelligent-ui/surface-document";
import { refreshSessionSurfaces, type SurfaceState } from "./client-state";
import styles from "./IntelligentUiSurface.module.css";

const messages = {
  en: { title: "Review changes before using the new version", notice: "The saved version remains available. Check changed meanings and units; values are not converted automatically. Removed fields will not be included. Local drafts remain on this device.", before: "Saved field and value", after: "New field", value: "Value to use", compatible: "Keep saved value", changed: "Changed", added: "Added", removed: "Removed", confirm: "Confirm and use new version", cancel: "Cancel this change", busy: "Saving your choice…", loading: "Loading changes…", provisional: "Waiting for the current task to finish. You can confirm after it completes.", stale: "The conversation or saved values changed. Ask for a new version using the latest values.", cancelled: "Change cancelled. Your saved version is retained.", committed: "New version confirmed.", error: "Could not confirm the outcome. Your saved version and drafts are retained. Refresh the review before trying again.", refresh: "Refresh review", retry: "Retry the same confirmation", pending: "An earlier confirmation did not finish. Check its original values below, then retry or cancel. It will not retry automatically.", invalid: "Enter a number within the allowed range.", number: "Number", slider: "Number", select: "Choice", checkbox: "Yes/no", unit: "Unit", step: "Step", none: "—", unknown: "Not recorded" },
  zh: { title: "核对变更后使用新版", notice: "已保存的旧版仍可使用。请核对变化的含义和单位，参数不会自动换算；移除的字段不会进入新版。本机草稿会继续保留。", before: "原字段和已保存值", after: "新字段", value: "新版使用的值", compatible: "保留已保存值", changed: "已变化", added: "新增", removed: "移除", confirm: "确认并使用新版", cancel: "取消这次变更", busy: "正在保存选择…", loading: "正在加载字段变更…", provisional: "正在等待当前任务完成，完成后可以确认。", stale: "对话或已保存参数已变化，请让模型根据最新参数重新生成。", cancelled: "已取消变更，保留已保存的旧版。", committed: "已确认使用新版。", error: "暂时无法确认操作结果，已保存的版本和草稿仍被保留。请刷新核对内容后重试。", refresh: "刷新核对内容", retry: "重试原确认", pending: "上次确认尚未完成。请核对下方原选择，再重试或取消；系统不会自动重试。", invalid: "请输入允许范围内的数字。", number: "数字", slider: "数字", select: "选项", checkbox: "是否", unit: "单位", step: "步长", none: "—", unknown: "未记录" },
};
type Copy = typeof messages.en;

function Choices({ review, copy, busy, submit }: { review: UiMigrationReview; copy: Copy; busy: boolean;
  submit(decision: "confirm" | "cancel", state: UiState, requestId: string): Promise<void> }) {
  const [values, setValues] = useState<Record<string, string | boolean>>(() => Object.fromEntries(
    Object.entries(review.pendingConfirmation?.state ?? review.suggestedState).map(([key, value]) => [key, typeof value === "boolean" ? value : String(value)])));
  const requestId = useRef(review.pendingConfirmation?.requestId ?? crypto.randomUUID());
  const cancelId = useRef(crypto.randomUUID());
  const pending = !!review.pendingConfirmation;
  const state: UiState = {};
  let valid = true;
  for (const field of review.fields) {
    if (!field.after) continue;
    const node = field.after, raw = values[field.id];
    if (node.type === "number" || node.type === "slider") {
      const value = typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
      if (!Number.isFinite(value) || node.min !== undefined && value < node.min || node.max !== undefined && value > node.max) valid = false;
      state[field.id] = value;
    } else if (node.type === "checkbox") { state[field.id] = raw === true; }
    else if (node.type === "select") { state[field.id] = String(raw); if (!node.options.includes(String(raw))) valid = false; }
  }
  const describe = (node: MigrationControl, unit?: string) => `${node.label} · ${copy[node.type]} · ${copy.unit}: ${unit ?? copy.unknown}${node.type === "select" ? ` (${node.options.join(" / ")})` : node.type === "checkbox" ? "" : ` (${node.min ?? "−∞"} … ${node.max ?? "∞"}${node.step ? `; ${copy.step} ${node.step}` : ""})`}`;
  const change = (id: string, value: string | boolean) => {
    requestId.current = crypto.randomUUID(); setValues(previous => ({ ...previous, [id]: value }));
  };
  const disabled = busy || review.status !== "ready";
  return <>
    {pending ? <p role="status">{copy.pending}</p> : null}
    <div className={styles.tableScroll}><table><thead><tr><th scope="col">{copy.before}</th><th scope="col">{copy.after}</th><th scope="col">{copy.value}</th></tr></thead>
      <tbody>{review.fields.map(field => <tr key={field.id}>
        <td>{field.before ? <>{describe(field.before, field.beforeMeaning?.unit)}<br />{String(field.savedValue)}</> : copy.none}</td>
        <th scope="row">{field.after ? describe(field.after, field.afterMeaning?.unit) : copy.none}<br />{copy[field.change]}</th>
        <td>{!field.after ? copy.none : field.change === "compatible" ? String(field.suggestedValue) : field.after.type === "checkbox"
          ? <input type="checkbox" aria-label={`${copy.value}: ${field.after.label}`} checked={values[field.id] === true} disabled={disabled || pending} onChange={event => change(field.id, event.currentTarget.checked)} />
          : field.after.type === "select" ? <select aria-label={`${copy.value}: ${field.after.label}`} value={String(values[field.id])} disabled={disabled || pending} onChange={event => change(field.id, event.currentTarget.value)}>{field.after.options.map(value => <option key={value}>{value}</option>)}</select>
            : <input type="number" aria-label={`${copy.value}: ${field.after.label}`} value={String(values[field.id])} min={field.after.min} max={field.after.max} step={field.after.step ?? "any"} disabled={disabled || pending} onChange={event => change(field.id, event.currentTarget.value)} />}</td>
      </tr>)}</tbody></table></div>
    {!valid ? <p role="alert">{copy.invalid}</p> : null}
    <div className={styles.actions}><button type="button" disabled={disabled || !valid} onClick={() => void submit("confirm", state, requestId.current)}>{busy ? copy.busy : pending ? copy.retry : copy.confirm}</button>
      <button type="button" disabled={disabled} onClick={() => void submit("cancel", {}, cancelId.current)}>{copy.cancel}</button></div>
  </>;
}

/** A human confirmation boundary, separate from normal parameter saving. */
export function StructureMigration({ store, english }: { store: SurfaceState; english: boolean }) {
  const copy = messages[english ? "en" : "zh"];
  const [review, setReview] = useState<UiMigrationReview | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), [resolved, setResolved] = useState(true);
  const lifecycle = useRef<AbortController | null>(null), sending = useRef(false);
  const readSequence = useRef(0);
  const endpoint = `/api/sessions/${encodeURIComponent(store.sessionId)}/intelligent-ui/migration`;
  const read = useCallback(async (signal: AbortSignal) => {
    const sequence = ++readSequence.current;
    const response = await fetch(`${endpoint}?toolCallId=${encodeURIComponent(store.toolCallId)}`, { cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
    if (!response.ok) throw new Error("Review unavailable");
    const body = await response.json();
    if (!body.review || body.review.toolCallId !== store.toolCallId) throw new Error("Review changed");
    if (!signal.aborted && sequence === readSequence.current) { setReview(body.review); setResolved(true); }
    return body.review as UiMigrationReview;
  }, [endpoint, store.toolCallId]);
  useEffect(() => {
    const controller = new AbortController(); lifecycle.current = controller;
    let timer: ReturnType<typeof setTimeout>, attempt = 0;
    const refresh = async () => {
      if (controller.signal.aborted || sending.current) return;
      try {
        const next = await read(controller.signal);
        if (!controller.signal.aborted && next.status === "provisional" && attempt++ < 20) timer = setTimeout(() => void refresh(), Math.min(attempt * 500, 5000));
      } catch { if (!controller.signal.aborted) { setError(true); setResolved(false); } }
    };
    const visible = () => { if (!document.hidden) { clearTimeout(timer); void refresh(); } };
    void refresh(); document.addEventListener("visibilitychange", visible); window.addEventListener("online", visible);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", visible); window.removeEventListener("online", visible); };
  }, [read]);
  const refresh = async () => {
    const signal = lifecycle.current?.signal; if (!signal || signal.aborted || sending.current) return;
    setBusy(true);
    try { await read(signal); setError(false); } catch { if (!signal.aborted) { setError(true); setResolved(false); } }
    finally { if (!signal.aborted) setBusy(false); }
  };
  const submit = async (decision: "confirm" | "cancel", state: UiState, requestId: string) => {
    const signal = lifecycle.current?.signal;
    if (!review || !resolved || !signal || signal.aborted || sending.current) return;
    sending.current = true; readSequence.current++; setBusy(true); setError(false);
    try {
      if (decision === "confirm") await flushPendingAnswerState(store.sessionId);
      if (signal.aborted) return;
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), body: JSON.stringify({ proposalId: review.proposalId, digest: review.digest, leafId: review.leafId, requestId, decision, state }) });
      if (!response.ok) throw new Error("Confirmation failed");
      const result = await response.json();
      if (result.status !== (decision === "confirm" ? "committed" : "cancelled")) throw new Error("Unconfirmed outcome");
      if (!signal.aborted) { setReview({ ...review, status: result.status }); await refreshSessionSurfaces(store.sessionId); }
    } catch {
      if (!signal.aborted) {
        setError(true); setResolved(false);
        // Query the receipt after an unknown outcome; never automatically POST.
        try { const next = await read(signal); if (next.status === "committed" || next.status === "cancelled") await refreshSessionSurfaces(store.sessionId); } catch { /* Explicit refresh remains available. */ }
      }
    } finally { sending.current = false; if (!signal.aborted) setBusy(false); }
  };
  return <section className={styles.migration} aria-label={copy.title}>
    <h4>{copy.title}</h4><p>{copy.notice}</p>
    {error ? <p role="alert">{copy.error}</p> : null}
    {!review ? <p role="status">{copy.loading}</p> : review.status !== "ready" ? <p role="status">{copy[review.status]}</p> : null}
    {review && (review.status === "ready" || review.status === "provisional") ? <Choices key={`${review.proposalId}:${review.pendingConfirmation?.requestId ?? "new"}`} review={review} copy={copy} busy={busy || !resolved} submit={submit} /> : null}
    <button type="button" disabled={busy} onClick={() => void refresh()}>{copy.refresh}</button>
  </section>;
}
