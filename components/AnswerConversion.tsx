"use client";

import { useEffect, useRef, useState } from "react";
import type { AnswerConversionChoice, AnswerConversionField, AnswerConversionInputs, AnswerConversionReview } from "../lib/answer-output-conversion-types";
import { flushPendingAnswerState, isAnswerStateEnabled } from "../lib/answer-output-client";
import { refreshMiniAppClients } from "../lib/mini-app/client-cache";
import { refreshSessionSurfaces } from "./intelligent-ui/client-state";
import { readMiniAppResource } from "../lib/mini-app/resource";
import styles from "./mini-app/MiniAppSurface.module.css";

function accepts(field: AnswerConversionField, value: unknown) {
  if (field.type === "checkbox") return typeof value === "boolean";
  if (field.type === "number") return typeof value === "number" && Number.isFinite(value) && value >= (field.min ?? -Infinity) && value <= (field.max ?? Infinity);
  return typeof value === "string" && (field.type === "select" ? field.options?.some(option => option.value === value) : value.length <= (field.maxLength ?? 4000));
}
export default function AnswerConversion({ sessionId, toolCallId, kind, english }: {
  sessionId: string; toolCallId: string; kind: AnswerConversionChoice["kind"]; english: boolean;
}) {
  const [review, setReview] = useState<AnswerConversionReview>(), [inputs, setInputs] = useState<AnswerConversionInputs>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const pending = useRef<AnswerConversionChoice | undefined>(undefined), lifetime = useRef<AbortController | undefined>(undefined);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  const endpoint = `/api/sessions/${encodeURIComponent(sessionId)}/answer-output/conversion?kind=${kind}&toolCallId=${encodeURIComponent(toolCallId)}`;
  const refresh = () => Promise.all([refreshMiniAppClients(sessionId), refreshSessionSurfaces(sessionId)]);
  const request = async (choice?: AnswerConversionChoice) => {
    if (!isAnswerStateEnabled() || lifetime.current?.signal.aborted) throw new Error("Conversion unavailable");
    const response = await fetch(endpoint, { cache: "no-store", signal: AbortSignal.any([lifetime.current!.signal, AbortSignal.timeout(15_000)]),
      ...(choice ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(choice) } : {}) });
    const data = JSON.parse(new TextDecoder().decode(await readMiniAppResource(response, 1024 * 1024, { allowErrorStatus: true })));
    if (!response.ok) { if (response.status >= 400 && response.status < 500) pending.current = undefined; throw new Error("Conversion not acknowledged"); }
    if (lifetime.current?.signal.aborted) throw new Error("View closed");
    return data;
  };
  const load = async () => {
    setBusy(true); setError(false);
    try {
      if (!pending.current) await flushPendingAnswerState(sessionId);
      const next: AnswerConversionReview = (await request()).review;
      if (next.status === "confirmed" || next.status === "cancelled") { await refresh(); return; }
      pending.current = next.pending; setReview(next); setInputs(next.pending?.inputs ?? next.target.inputs);
    } catch { if (!lifetime.current?.signal.aborted) setError(true); }
    finally { if (!lifetime.current?.signal.aborted) setBusy(false); }
  };
  const decide = async (decision: "confirm" | "cancel") => {
    if (!review || busy) return;
    setBusy(true); setError(false);
    try {
      if (!pending.current) await flushPendingAnswerState(sessionId);
      const choice = (pending.current?.decision === decision ? pending.current : undefined) ?? { kind, toolCallId, requestId: crypto.randomUUID(), leafId: review.leafId,
        digest: review.digest, decision, inputs: decision === "confirm" ? inputs : {} };
      pending.current = choice;
      await request(choice); await refresh();
    } catch { if (!lifetime.current?.signal.aborted) setError(true); }
    finally { if (!lifetime.current?.signal.aborted) setBusy(false); }
  };
  const frozen = busy || !!pending.current || review?.status !== "ready";
  return <section className={styles.migration} aria-label={english ? "Review output conversion" : "核对界面切换"} aria-busy={busy}>
    <div className={styles.controls}><button type="button" disabled={busy} onClick={event => { if (event.nativeEvent.isTrusted) void load(); }}>{english ? "Review conversion / refresh" : "核对切换 / 刷新"}</button></div>
    {review && <>
      <p>{review.description}</p>
      <p>{english ? "Task progress, steps, random state and camera start over. Old values are shown for reference; choose them explicitly or edit the new inputs. The previous output remains in history." : "任务进度、步数、随机状态和镜头将重新开始。旧值仅供核对；需要保留的参数请逐项选择或填写。原版仍保留在历史中。"}</p>
      {review.source && <details><summary>{english ? "Previous values and result" : "旧版参数和结果"}</summary><pre className={styles.currentSummary}>{review.source.summary}</pre>
        {review.source.fields.map(field => <p key={field.id}>{field.label}{field.meaning ? ` · ${field.meaning}` : ""}：{String(review.source!.inputs[field.id])}</p>)}</details>}
      <div className={styles.migrationFields}>{review.target.fields.map(field => <div key={field.id} className={styles.migrationField}>
        <label><strong>{field.label}</strong>{field.meaning && <span>{field.meaning}</span>}
          {field.type === "checkbox" ? <input type="checkbox" disabled={frozen} checked={inputs[field.id] === true} onChange={e => setInputs({ ...inputs, [field.id]: e.target.checked })} />
            : field.type === "select" ? <select disabled={frozen} value={String(inputs[field.id] ?? "")} onChange={e => setInputs({ ...inputs, [field.id]: e.target.value })}>{field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
              : <input type={field.type === "number" ? "number" : "text"} disabled={frozen} value={String(inputs[field.id] ?? "")} min={field.min} max={field.max} step={field.step ?? "any"} maxLength={field.maxLength}
                onChange={e => setInputs({ ...inputs, [field.id]: field.type === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value })} />}
        </label>
        <select aria-label={`${english ? "Copy previous value to" : "为此参数选取旧值"} ${field.label}`} disabled={frozen} value="" onChange={e => {
          const value = review.source?.inputs[e.target.value]; if (accepts(field, value)) setInputs({ ...inputs, [field.id]: value! });
        }}><option value="">{english ? "Choose an old value (optional)" : "选择旧值（可选）"}</option>{review.source?.fields.filter(old => accepts(field, review.source!.inputs[old.id])).map(old => <option key={old.id} value={old.id}>{old.label}{old.meaning ? ` · ${old.meaning}` : ""}：{String(review.source!.inputs[old.id])}</option>)}</select>
      </div>)}</div>
      {review.status === "stale" && <p role="alert">{english ? "The source changed. Request a new proposal before confirming." : "来源已变化，请生成基于当前结果的新提案。"}</p>}
      <div className={styles.controls}>
        <button type="button" disabled={busy || review.status !== "ready"} onClick={event => { if (event.nativeEvent.isTrusted) void decide(pending.current?.decision ?? "confirm"); }}>{pending.current ? english ? "Resume saved choice" : "继续已保存的选择" : english ? "Confirm conversion" : "确认切换"}</button>
        <button type="button" disabled={busy || !review.source} onClick={event => { if (event.nativeEvent.isTrusted) void decide("cancel"); }}>{english ? "Keep previous output" : "保留原版"}</button>
      </div>
    </>}
    {error && <p role="alert">{english ? "Conversion was not acknowledged. Refresh its saved status before retrying." : "尚未确认切换成功，请刷新核对已保存的状态后重试。"}</p>}
  </section>;
}
