"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { flushPendingAnswerState } from "../../lib/answer-output-client";
import type { UiActionDeclaration } from "../../lib/intelligent-ui/action-contract";
import type { UiActionOperation, UiActionStart } from "../../lib/intelligent-ui/action-operation";
import { actionTerminal } from "../../lib/intelligent-ui/action-operation";
import { actionProblemText, readUiActionProblem, type UiActionProblem } from "../../lib/intelligent-ui/action-feedback";
import { uiActionBehaviorText } from "../../lib/intelligent-ui/action-description";
import { refreshSessionSurfaces, type SurfaceState } from "./client-state";
import styles from "./IntelligentUiSurface.module.css";

type Operation = UiActionOperation & { approval?: { id: string; message: string } };
type ActionView = { source: { digest: string; actions: UiActionDeclaration; revision: number } | null; operations: Operation[] };
type Feedback = { problem: UiActionProblem; details?: string };
class ActionResponseError extends Error {
  constructor(readonly feedback: Feedback, readonly definite: boolean) { super("Action request failed"); }
}
async function responseFailure(response: Response): Promise<ActionResponseError> {
  const body = await response.json().catch(() => null);
  return new ActionResponseError({ problem: readUiActionProblem(body?.problem) ?? "request_unknown",
    ...(typeof body?.error === "string" ? { details: body.error.slice(0, 2000) } : {}) }, response.status >= 400 && response.status < 500);
}
function FailureMessage({ feedback, locale }: { feedback: Feedback; locale: "en" | "zh-CN" }) {
  return <><p>{actionProblemText(feedback.problem, locale)}</p>{feedback.details ? <details>
    <summary>{locale === "en" ? "Technical details" : "技术详情"}</summary><pre className={styles.snapshot}>{feedback.details}</pre>
  </details> : null}</>;
}
const messages = {
  en: { title: "Actions", target: "Project file", prepared: "Preparing", waiting_approval: "Waiting for approval", executing: "Running", completed: "Completed", cancelled: "Cancelled", failed: "Could not complete", uncertain: "Result unknown — check the file before starting again", query: "Refresh results", retry: "Retry this same request", error: "Could not confirm the result. Refresh to check; the request will not be repeated automatically.", allow: "Allow once", deny: "Decline", cancel: "Cancel", verify: "Check saved file", apply: "Use these parameters", applied: "Parameters applied", matching: "The file matches the requested report. This does not prove which attempt created it.", missing: "The file is missing", different: "The file has different contents", proposed: "Read parameters — review before applying", changes: "Save or resolve your parameter changes first." },
  "zh-CN": { title: "操作", target: "项目内文件", prepared: "准备中", waiting_approval: "等待确认", executing: "执行中", completed: "已完成", cancelled: "已取消", failed: "未能完成", uncertain: "结果不确定，请先核对文件", query: "查询结果", retry: "重试同一次请求", error: "暂时无法确认结果，请查询后再操作。不会自动重复执行。", allow: "允许这一次", deny: "拒绝", cancel: "取消", verify: "核对保存结果", apply: "采用这些参数", applied: "已采用参数", matching: "文件内容与预期报告一致，但无法证明由哪次操作创建。", missing: "文件不存在", different: "文件内容与预期不一致", proposed: "读取的参数 · 核对后再采用", changes: "请先保存或处理当前参数的变更。" },
};

/** The action lifecycle belongs to the surface, independently of chat rendering. */
export function SurfaceActions({ store, locale }: { store: SurfaceState; locale: "en" | "zh-CN" }) {
  const copy = messages[locale], view = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [data, setData] = useState<ActionView | null>(null), [error, setError] = useState<Feedback | null>(null), [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState<UiActionStart | null>(null);
  const alive = useRef(false), locked = useRef(false), sequence = useRef({ value: 0 });
  const endpoint = `/api/sessions/${encodeURIComponent(store.sessionId)}/intelligent-ui/actions`;
  const refresh = useCallback(async () => {
    const request = ++sequence.current.value;
    const response = await fetch(`${endpoint}?toolCallId=${encodeURIComponent(store.toolCallId)}`, { cache: "no-store" });
    if (!response.ok) throw await responseFailure(response);
    const next = await response.json() as ActionView;
    if (!next || !Array.isArray(next.operations) || next.source !== null && (!next.source
      || typeof next.source.digest !== "string" || !Array.isArray(next.source.actions?.actions))) throw new Error("Invalid action status response");
    if (next.operations.some(operation => !operation || typeof operation.id !== "string" || typeof operation.action?.label !== "string"
      || typeof operation.file?.path !== "string" || !["prepared", "waiting_approval", "executing", "completed", "cancelled", "failed", "uncertain"].includes(operation.status)
      || operation.result?.kind === "parameters" && (!operation.result.state || typeof operation.result.state !== "object" || Array.isArray(operation.result.state)))) {
      throw new Error("Invalid action result response");
    }
    if (!alive.current || request !== sequence.current.value) return null;
    setData(next); setError(null);
    setUnknown(previous => previous && !next.operations.some(item => item.id === previous.requestId) ? previous : null);
    return next;
  }, [endpoint, store.toolCallId]);
  useEffect(() => {
    const requests = sequence.current;
    alive.current = true;
    const load = () => { if (!document.hidden) void refresh().catch(() => { if (alive.current) setError({ problem: "request_unknown" }); }); };
    load(); window.addEventListener("online", load); document.addEventListener("visibilitychange", load);
    return () => { alive.current = false; requests.value++; window.removeEventListener("online", load); document.removeEventListener("visibilitychange", load); };
  }, [refresh]);
  useEffect(() => { void refresh().catch(() => { if (alive.current) setError({ problem: "request_unknown" }); }); }, [view.revision, refresh]);
  const running = !!data?.operations.some(item => !actionTerminal(item.status));
  useEffect(() => {
    if (!running && !unknown) return;
    const timer = setInterval(() => { if (!document.hidden) void refresh().catch(() => { if (alive.current) setError({ problem: "request_unknown" }); }); }, 1500);
    return () => clearInterval(timer);
  }, [running, unknown, refresh]);
  async function post(body: unknown) {
    const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw await responseFailure(response);
    return response.json();
  }
  function act(work: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(null);
    void work().catch(failure => { if (alive.current) setError(failure instanceof ActionResponseError ? failure.feedback : { problem: "request_unknown" }); }).finally(() => {
      locked.current = false; if (alive.current) setBusy(false);
    });
  }
  async function start(actionId: string, retry?: UiActionStart) {
    await flushPendingAnswerState(store.sessionId);
    if (!alive.current) return;
    const fresh = await refresh();
    if (!alive.current || !fresh?.source) return;
    const input = retry ?? { requestId: crypto.randomUUID(), toolCallId: store.toolCallId, sourceDigest: fresh.source.digest, actionId };
    setUnknown(input); // An ambiguous HTTP result is resolved with GET, never an automatic new POST.
    try { await post({ command: "start", ...input }); }
    catch (failure) {
      if (failure instanceof ActionResponseError && failure.definite && alive.current) {
        // A definite rejection can be dismissed after a successful status read.
        // Transport and server failures keep the same request ID for an explicit retry.
        const checked = await refresh();
        if (checked && alive.current && !checked.operations.some(item => item.id === input.requestId)) setUnknown(null);
      }
      throw failure;
    }
    if (alive.current) await refresh();
  }
  async function control(operation: Operation, command: "approve" | "deny" | "cancel" | "reconcile" | "apply") {
    if (command === "apply") {
      const current = store.getSnapshot();
      if (current.hasPendingDraft || current.status !== "saved") throw new ActionResponseError({ problem: "unsaved" }, true);
      await flushPendingAnswerState(store.sessionId);
      if (!alive.current || store.getSnapshot().hasPendingDraft) return;
    }
    await post({ command, operationId: operation.id, ...(operation.approval ? { approvalId: operation.approval.id } : {}) });
    if (!alive.current) return;
    if (command === "apply") await refreshSessionSurfaces(store.sessionId);
    await refresh();
  }
  if (!data?.source?.actions.actions.length && !data?.operations.length && !error) return null;
  return <section className={styles.notice} aria-label={copy.title}>
    <h4>{copy.title}</h4>
    {data?.source?.actions.actions.map(action => <div key={action.id}>
      <button type="button" disabled={busy || running || !!unknown || view.status !== "saved" || view.hasPendingDraft}
        onClick={() => act(() => start(action.id))}>{action.label}</button>
      <p>{copy.target}: <code>{action.path}</code></p>
      <p>{uiActionBehaviorText(action.kind, locale)}</p>
    </div>)}
    {data?.operations.map(operation => <div key={operation.id}>
      <p><strong>{operation.action.label}</strong> · <span role="status">{copy[operation.status]}</span></p>
      <p><code>{operation.file.path}</code></p>
      {operation.error || operation.problem ? <FailureMessage locale={locale} feedback={{
        problem: readUiActionProblem(operation.problem) ?? (operation.status === "uncertain" ? "uncertain" : operation.status === "cancelled" ? "cancelled" : "interrupted"),
        details: typeof operation.error === "string" ? operation.error.slice(0, 2000) : undefined,
      }} /> : null}
      {operation.approval ? <div><pre className={styles.snapshot}>{operation.approval.message}</pre>
        <button disabled={busy} onClick={() => act(() => control(operation, "approve"))}>{copy.allow}</button>
        <button disabled={busy} onClick={() => act(() => control(operation, "deny"))}>{copy.deny}</button></div> : null}
      {!actionTerminal(operation.status) ? <button disabled={busy} onClick={() => act(() => control(operation, "cancel"))}>{copy.cancel}</button> : null}
      {operation.status === "uncertain" ? <button disabled={busy} onClick={() => act(() => control(operation, "reconcile"))}>{copy.verify}</button> : null}
      {operation.reconciliation ? <p>{copy[operation.reconciliation]}</p> : null}
      {operation.result?.kind === "parameters" ? <div><p>{copy.proposed}</p>
        <dl>{Object.entries(operation.result.state).map(([id, value]) => <div key={id}><dt>{(view.surface.nodes.find(node => node.id === id) as { label?: string } | undefined)?.label ?? id}</dt><dd>{String(value)}</dd></div>)}</dl>
        {operation.appliedRevision !== undefined ? <p>{copy.applied}</p> : <button disabled={busy || running || view.hasPendingDraft || view.status !== "saved"}
          onClick={() => act(() => control(operation, "apply"))}>{copy.apply}</button>}</div> : null}
    </div>)}
    {error ? <div role="alert"><FailureMessage feedback={error} locale={locale} /></div> : null}
    {unknown && !busy && !running && !error ? <p role="alert">{actionProblemText("request_unknown", locale)}</p> : null}
    <button disabled={busy} onClick={() => act(async () => { await refresh(); })}>{copy.query}</button>
    {unknown ? <button disabled={busy || running} onClick={() => act(() => start(unknown.actionId, unknown))}>{copy.retry}</button> : null}
  </section>;
}
