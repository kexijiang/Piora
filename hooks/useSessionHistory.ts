"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { HistoryDetail, HistoryIndex } from "@/lib/session-history";

export class HistoryApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export async function historyRequest<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000), cache: "no-store" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new HistoryApiError(body.error || `HTTP ${response.status}`, response.status);
  }
  return response.json() as Promise<T>;
}

export function useSessionHistory(sessionId: string, leafId: string | null) {
  const base = `/api/sessions/${encodeURIComponent(sessionId)}/history`;
  const [index, setIndex] = useState<HistoryIndex | null>(null);
  const [indexError, setIndexError] = useState("");
  const [loading, setLoading] = useState(true);
  const [changed, setChanged] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [details, setDetails] = useState(new Map<string, HistoryDetail>());
  const [errors, setErrors] = useState(new Map<string, string>());
  const cache = useRef(details);
  cache.current = details;
  const reload = useCallback(() => setGeneration(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setIndexError("");
    void historyRequest<HistoryIndex>(base, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setIndex(value); setChanged(false);
    }).catch(error => { if (!controller.signal.aborted) setIndexError(String(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [base, generation]);
  const version = index?.version;
  useEffect(() => { setDetails(new Map()); setErrors(new Map()); }, [version]);
  useEffect(() => {
    if (!version) return;
    const controller = new AbortController();
    let busy = false;
    const check = async () => {
      if (busy || document.visibilityState !== "visible") return;
      busy = true;
      try {
        const current = await historyRequest<{ version: string }>(`${base}?versionOnly=1`, controller.signal);
        if (!controller.signal.aborted && current.version !== version) setChanged(true);
      } catch { /* Background checks do not replace the saved snapshot. */ }
      finally { busy = false; }
    };
    const timer = setInterval(() => void check(), 10_000);
    document.addEventListener("visibilitychange", check);
    return () => { clearInterval(timer); controller.abort(); document.removeEventListener("visibilitychange", check); };
  }, [base, version]);

  const queueRef = useRef<{ version: string; leafId: string | null; add: (id: string, retry: boolean) => void } | null>(null);
  useEffect(() => {
    if (!version) return;
    const controller = new AbortController(), queue = new Set<string>(), requested = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = false;
    const flush = async () => {
      timer = undefined;
      const ids = [...queue].slice(0, 80);
      if (!ids.length) return;
      pending = true;
      ids.forEach(id => queue.delete(id));
      const query = new URLSearchParams({ version, ...(leafId ? { leafId } : {}) });
      ids.forEach(id => query.append("entryId", id));
      try {
        const result = await historyRequest<{ entries: HistoryDetail[] }>(`${base}/entries?${query}`, controller.signal);
        if (controller.signal.aborted) return;
        setDetails(current => { const next = new Map(current); for (const detail of result.entries) next.set(`${version}:${leafId}:${detail.id}`, detail); return next; });
        setErrors(current => { const next = new Map(current); ids.forEach(id => next.delete(`${leafId}:${id}`)); return next; });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof HistoryApiError && error.status === 409) setChanged(true);
        setErrors(current => { const next = new Map(current); ids.forEach(id => next.set(`${leafId}:${id}`, String(error))); return next; });
      }
      pending = false;
      if (queue.size && !controller.signal.aborted) timer = setTimeout(() => void flush(), 0);
    };
    queueRef.current = { version, leafId, add(id, retry) {
      if (!retry && (requested.has(id) || cache.current.has(`${version}:${leafId}:${id}`))) return;
      requested.add(id); queue.add(id);
      if (!pending && !timer) timer = setTimeout(() => void flush(), 0);
    } };
    return () => { controller.abort(); clearTimeout(timer); queueRef.current = null; };
  }, [base, leafId, version]);
  const ensure = useCallback((id: string, retry = false) => {
    if (version) queueMicrotask(() => {
      const queue = queueRef.current;
      if (queue?.version === version && queue.leafId === leafId) queue.add(id, retry);
    });
  }, [version, leafId]);
  return { base, index, indexError, loading, changed, reload, ensure,
    detail: (id: string) => details.get(`${version}:${leafId}:${id}`), error: (id: string) => errors.get(`${leafId}:${id}`) };
}
