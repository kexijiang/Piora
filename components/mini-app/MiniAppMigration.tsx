"use client";

import { useEffect, useRef, useState } from "react";
import { flushPendingAnswerState, isAnswerStateEnabled } from "../../lib/answer-output-client";
import { refreshMiniAppClients } from "../../lib/mini-app/client-cache";
import { readMiniAppResource } from "../../lib/mini-app/resource";
import type { MiniAppMigrationChoice, MiniAppMigrationReview, MiniAppMigrationPreview } from "../../lib/mini-app/migration-types";
import type { JsonRecord } from "../../lib/mini-app/json";
import styles from "./MiniAppSurface.module.css";

class MigrationRequestError extends Error {
  constructor(readonly status: number) { super("Review could not be confirmed"); }
}

export default function MiniAppMigration({ sessionId, toolCallId, english }: { sessionId: string; toolCallId: string; english: boolean }) {
  const [review, setReview] = useState<MiniAppMigrationReview>(), [inputs, setInputs] = useState<JsonRecord>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const [progress, setProgress] = useState<"reset" | "migrate">("reset");
  const [preview, setPreview] = useState<{ key: string; value: MiniAppMigrationPreview }>();
  const pending = useRef<MiniAppMigrationChoice | undefined>(undefined), lifetime = useRef<AbortController | undefined>(undefined);
  useEffect(() => { const current = new AbortController(); lifetime.current = current; return () => current.abort(); }, []);
  const endpoint = `/api/sessions/${encodeURIComponent(sessionId)}/mini-app/migration`;
  const active = () => {
    if (lifetime.current?.signal.aborted || !isAnswerStateEnabled()) throw new Error("Review is no longer active");
  };
  const request = async (init?: RequestInit, previewing = false) => {
    active();
    const response = await fetch(`${endpoint}${previewing ? "/preview" : ""}?toolCallId=${encodeURIComponent(toolCallId)}`, { ...init, cache: "no-store",
      signal: AbortSignal.any([lifetime.current!.signal, AbortSignal.timeout(15_000)]) });
    const data = JSON.parse(new TextDecoder().decode(await readMiniAppResource(response, 1024 * 1024, { allowErrorStatus: true })));
    active(); if (!response.ok) throw new MigrationRequestError(response.status);
    return data;
  };
  const load = async () => {
    setBusy(true); setError(false); setPreview(undefined);
    try {
      if (!pending.current) await flushPendingAnswerState(sessionId);
      const next: MiniAppMigrationReview = (await request()).review;
      if (["committed", "cancelled"].includes(next.status)) { await refreshMiniAppClients(sessionId); return; }
      if (pending.current && !next.pending && next.digest !== pending.current.digest) pending.current = undefined;
      pending.current = next.pending ?? pending.current;
      setReview(next); setInputs(pending.current?.inputs ?? next.suggestedInputs);
      setProgress(pending.current?.progress ?? "reset");
    } catch { if (!lifetime.current?.signal.aborted) setError(true); }
    finally { if (!lifetime.current?.signal.aborted) setBusy(false); }
  };
  const previewKey = JSON.stringify({ digest: review?.digest, inputs, progress });
  const previewMatches = preview?.key === previewKey;
  const editInputs = (next: JsonRecord) => { setInputs(next); setPreview(undefined); };
  const rehearse = async () => {
    if (!review || busy || pending.current) return;
    setBusy(true); setError(false); setPreview(undefined);
    try {
      await flushPendingAnswerState(sessionId);
      const choice: MiniAppMigrationChoice = { toolCallId, publicationId: review.publicationId, digest: review.digest,
        leafId: review.leafId, requestId: crypto.randomUUID(), decision: "confirm", inputs, progress };
      const value: MiniAppMigrationPreview = (await request({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(choice) }, true)).preview;
      setPreview({ key: previewKey, value });
    } catch (error) {
      if (!lifetime.current?.signal.aborted) {
        if (error instanceof MigrationRequestError && error.status === 409) setReview(undefined);
        setError(true);
      }
    } finally { if (!lifetime.current?.signal.aborted) setBusy(false); }
  };
  const decide = async (decision: "confirm" | "cancel") => {
    if (!review || busy) return;
    if (decision === "confirm" && !pending.current && !previewMatches) return;
    setBusy(true); setError(false);
    try {
      active();
      // Pause and save old instances before binding the click. A new save will
      // invalidate this review instead of silently replacing its source state.
      if (!pending.current) await flushPendingAnswerState(sessionId);
      const choice = pending.current ?? { toolCallId, publicationId: review.publicationId, digest: review.digest, leafId: review.leafId,
        requestId: crypto.randomUUID(), decision, inputs: decision === "confirm" ? inputs : {},
        ...(decision === "confirm" ? { progress, previewDigest: preview!.value.digest } : {}) };
      pending.current = choice;
      await request({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(choice) });
      await refreshMiniAppClients(sessionId);
    } catch (error) {
      if (!lifetime.current?.signal.aborted) {
        if (error instanceof MigrationRequestError && error.status >= 400 && error.status < 500) {
          // A rejected choice is editable after a new server review. Any
          // already-persisted intent is restored by that review, never guessed.
          pending.current = undefined; setReview(undefined);
        }
        setError(true);
      }
    }
    finally { if (!lifetime.current?.signal.aborted) setBusy(false); }
  };
  const frozen = busy || !!pending.current;
  return <section className={styles.migration} aria-label={english ? "Review revision" : "核对新版变化"} aria-busy={busy}>
    <div className={styles.controls}><button type="button" disabled={busy} onClick={event => { if (event.nativeEvent.isTrusted) void load(); }}>{english ? "Review changes / refresh" : "核对变化 / 刷新"}</button></div>
    {review && <>
      {review.sourceSummary && <div className={styles.migrationOutcome}><strong>{english ? "Saved progress at review time" : "核对时已保存的进度"}</strong><p>{review.sourceSummary}</p></div>}
      <p>{english ? "Only inputs with identical meaning, type and constraints are suggested for retention. The old version remains available in history." : "含义、类型和约束一致的参数建议保留，旧版仍保留在历史中。"}</p>
      {review.progress && <label className={styles.migrationField}>
        <strong>{english ? "Task progress" : "任务进度"}</strong>
        <select aria-label={english ? "Task progress" : "任务进度"} disabled={frozen} value={progress} onChange={e => { setProgress(e.target.value as "reset" | "migrate"); setPreview(undefined); }}>
          <option value="reset">{english ? "Start over" : "重新开始"}</option>
          <option value="migrate">{english ? "Apply the proposed progress migration" : "使用提议的进度迁移"}</option>
        </select>
        <span>{english ? "Proposed behavior: " : "提议的迁移说明："}{review.progress.description}</span>
      </label>}
      <p>{progress === "migrate" ? english
        ? `The migration runs in isolation and must match the current source. ${review.progress?.clock === "preserve" ? "Runtime clock and random state are retained." : "Runtime clock and random state restart."} Task steps follow the preview result. Held input is released; the camera starts over. Failure keeps the old version.`
        : `迁移将在隔离环境执行并核对当前来源。${review.progress?.clock === "preserve" ? "运行时钟和随机状态延续。" : "运行时钟和随机状态重新开始。"}任务步数以预演结果为准。旧按键与拖动会释放，镜头重新开始；失败保留旧版。`
        : english ? "Task progress, runtime clock, random state and camera start over." : "任务进度、运行时钟、随机状态和镜头将重新开始。"}</p>
      <div className={styles.migrationFields}>{review.fields.map(field => <label key={field.id} className={styles.migrationField}>
        <strong>{field.after?.label ?? field.before?.label}</strong>
        <span>{english ? { compatible: "Retained", changed: "Changed", added: "Added", removed: "Removed" }[field.change]
          : { compatible: "可保留", changed: "含义或约束变化", added: "新增", removed: "移除" }[field.change]}</span>
        <span>{field.before && `${english ? "Saved" : "原值"}: ${String(field.savedValue)} · ${field.before.meaning}`}</span>
        {field.after && <><span>{field.after.meaning}</span>
          {field.after.type === "select" ? <select disabled={frozen} value={String(inputs[field.id] ?? "")} onChange={e => editInputs({ ...inputs, [field.id]: e.target.value })}>
            {field.after.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select> : field.after.type === "checkbox" ? <input type="checkbox" disabled={frozen} checked={inputs[field.id] === true} onChange={e => editInputs({ ...inputs, [field.id]: e.target.checked })} />
            : field.after.type === "text" ? <input type="text" disabled={frozen} value={String(inputs[field.id] ?? "")} maxLength={field.after.maxLength} onChange={e => editInputs({ ...inputs, [field.id]: e.target.value })} />
              : <input type="number" disabled={frozen} value={typeof inputs[field.id] === "number" ? Number(inputs[field.id]) : ""} min={field.after.min} max={field.after.max} step={field.after.step}
                onChange={e => editInputs({ ...inputs, [field.id]: e.target.value === "" ? "" : Number(e.target.value) })} />}
        </>}
      </label>)}</div>
      {review.status === "ready" && !pending.current && <>
        <div className={styles.controls}><button type="button" disabled={busy} onClick={event => { if (event.nativeEvent.isTrusted) void rehearse(); }}>{english ? "Preview selected changes" : "预演所选变化"}</button></div>
        {previewMatches ? <section className={styles.migrationOutcome} aria-label={english ? "Revision preview" : "修订预演"}>
          <strong>{english ? "After applying these choices" : "按这些选择应用后"}</strong><p>{preview.value.resultSummary}</p>
          <p>{english ? "Preview only. Your current version and progress have not changed." : "仅作预演，当前版本和进度尚未改变。"}</p>
          <details><summary>{english ? "View data changes" : "查看数据变化明细"}</summary>
            <p>{english ? `Observed ${preview.value.changes.total} changes; ${preview.value.changes.omitted} omitted.` : `观察到 ${preview.value.changes.total} 项变化，${preview.value.changes.omitted} 项未展示。`}</p>
            {!preview.value.changes.complete && <p>{english ? "This is a partial list; omitted data must not be assumed unchanged." : "这里只展示部分变化，未列出的数据不能视为保持不变。"}</p>}
            <div className={styles.migrationChangeTable}><table><thead><tr><th>{english ? "Data" : "数据项"}</th><th>{english ? "Before" : "应用前"}</th><th>{english ? "After" : "应用后"}</th></tr></thead>
              <tbody>{preview.value.changes.items.map(item => <tr key={item.path}><th scope="row">{item.path}</th><td>{item.kind === "add" ? english ? "Absent" : "不存在" : JSON.stringify(item.before)}</td><td>{item.kind === "remove" ? english ? "Removed" : "移除" : JSON.stringify(item.after)}</td></tr>)}</tbody></table></div>
          </details>
        </section> : <p>{english ? "Preview these choices before confirming. Changing an input or progress mode requires another preview." : "确认前请预演所选变化；修改参数或进度选项后需要重新预演。"}</p>}
      </>}
      {review.status === "ready" ? <div className={styles.controls}>
        <button type="button" disabled={busy || pending.current?.decision === "cancel" || (!pending.current && !previewMatches)} onClick={event => { if (event.nativeEvent.isTrusted) void decide("confirm"); }}>{progress === "migrate" ? english ? "Confirm revision and migrate progress" : "确认新版并迁移进度" : english ? "Confirm revision and restart progress" : "确认新版并重新开始进度"}</button>
        <button type="button" disabled={busy || pending.current?.decision === "confirm"} onClick={event => { if (event.nativeEvent.isTrusted) void decide("cancel"); }}>{english ? "Cancel revision" : "取消这次变更"}</button>
      </div> : <p role="status">{english ? "This review is stale. Keep the current version and request a new revision." : "这份候选已失效，请保留当前版本并重新提出修改。"}</p>}
    </>}
    {error && <p role="alert">{english ? "Not confirmed. Refresh to check the saved result; your previous version remains available." : "尚未确认成功，请刷新核对保存结果；旧版仍然保留。"}</p>}
  </section>;
}
