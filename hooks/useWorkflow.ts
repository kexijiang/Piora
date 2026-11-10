"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "./useI18n";
import type { WorkflowAction, WorkflowSnapshot } from "@/lib/workflow-types";

/** Session and revision checks fence slow requests after switching chats or acting. */
export function useWorkflow(sessionId: string | null, visible: boolean, running: boolean,
  executeAction: (action: WorkflowAction) => Promise<WorkflowSnapshot>) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<WorkflowSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef({ sessionId, executeAction, t });
  latest.current = { sessionId, executeAction, t };
  const generation = useRef(0);
  const actionInFlight = useRef(false);
  const request = useRef<AbortController | null>(null);
  const accept = useCallback((next: WorkflowSnapshot) => {
    if (next.sessionId !== latest.current.sessionId) return;
    setSnapshot(current => current?.sessionId === next.sessionId && current.revision > next.revision ? current : next);
  }, []);
  const refresh = useCallback(async () => {
    const sid = latest.current.sessionId;
    if (!sid || request.current) return;
    const epoch = generation.current;
    const controller = new AbortController();
    request.current = controller;
    try {
      const response = await fetch(`/api/agent/${encodeURIComponent(sid)}/workflow`, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
      if (!response.ok) throw new Error(latest.current.t("workflow.loadError"));
      const next = await response.json() as WorkflowSnapshot;
      if (epoch !== generation.current || controller.signal.aborted || latest.current.sessionId !== sid) return;
      accept(next);
      setError(null);
    } catch {
      if (epoch === generation.current && !controller.signal.aborted) setError(latest.current.t("workflow.loadError"));
    } finally { if (request.current === controller) request.current = null; }
  }, [accept]);
  useEffect(() => {
    const epoch = ++generation.current;
    request.current?.abort(); request.current = null;
    actionInFlight.current = false;
    setSnapshot(null); setError(null); setBusy(false);
    if (sessionId) void refresh();
    return () => { generation.current = epoch + 1; request.current?.abort(); request.current = null; };
  }, [sessionId, refresh]);
  useEffect(() => {
    if (!sessionId || !visible) return;
    const reconcile = () => { if (document.visibilityState !== "hidden") void refresh(); };
    reconcile();
    const timer = setInterval(reconcile, running ? 1_000 : 3_000);
    window.addEventListener("online", reconcile);
    document.addEventListener("visibilitychange", reconcile);
    return () => { clearInterval(timer); window.removeEventListener("online", reconcile); document.removeEventListener("visibilitychange", reconcile); };
  }, [sessionId, visible, running, refresh]);
  const act = useCallback(async (action: WorkflowAction["action"], turnBudget?: number) => {
    const current = snapshot;
    if (!current?.current || current.sessionId !== latest.current.sessionId || actionInFlight.current) return false;
    const epoch = generation.current;
    actionInFlight.current = true; setBusy(true); setError(null);
    try {
      const next = await latest.current.executeAction({ action, runId: current.current.id, expectedRevision: current.revision, ...(turnBudget !== undefined ? { turnBudget } : {}) });
      if (epoch !== generation.current) return false;
      accept(next);
      return true;
    } catch (cause) {
      if (epoch === generation.current) {
        setError(cause instanceof Error ? cause.message : latest.current.t("workflow.actionError"));
        // A 409 may mean another window acted; reload before offering actions.
        void refresh();
      }
      return false;
    } finally {
      if (epoch === generation.current) { actionInFlight.current = false; setBusy(false); }
    }
  }, [snapshot, accept, refresh]);
  return { snapshot: snapshot?.sessionId === sessionId ? snapshot : null, error, busy, act, refresh };
}
