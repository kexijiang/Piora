"use client";

import { useEffect, useSyncExternalStore } from "react";

interface ToolApprovalState {
  enabled: boolean;
  loading: boolean;
  ready: boolean;
  saving: boolean;
  error: string | null;
}
const initial: ToolApprovalState = { enabled: true, loading: true, ready: false, saving: false, error: null };
let state = initial;
let revision = 0;
let request: AbortController | null = null;
let cleanup: (() => void) | undefined;
const listeners = new Set<() => void>();
const changeKey = "piora-tool-approval-settings-changed";
function publish(next: ToolApprovalState) { state = next; listeners.forEach(listener => listener()); }

async function refresh() {
  if (state.saving || request) return;
  const controller = new AbortController();
  request = controller;
  const version = revision;
  try {
    const response = await fetch("/api/settings/tool-approval", { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
    const data = await response.json() as { enabled?: boolean; error?: string };
    if (!response.ok || typeof data.enabled !== "boolean") throw new Error(data.error ?? `HTTP ${response.status}`);
    if (version === revision && !controller.signal.aborted) publish({ ...state, enabled: data.enabled, loading: false, ready: true, error: null });
  } catch (error) {
    if (version === revision && !controller.signal.aborted) publish({ ...state, loading: false, error: error instanceof Error ? error.message : String(error) });
  } finally { if (request === controller) request = null; }
}

async function setEnabled(enabled: boolean): Promise<boolean> {
  if (state.saving) return false;
  revision++;
  request?.abort(); request = null;
  publish({ ...state, saving: true, error: null });
  try {
    const response = await fetch("/api/settings/tool-approval", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }), signal: AbortSignal.timeout(10_000),
    });
    const data = await response.json() as { enabled?: boolean; error?: string };
    if (!response.ok || typeof data.enabled !== "boolean") throw new Error(data.error ?? `HTTP ${response.status}`);
    publish({ enabled: data.enabled, loading: false, ready: true, saving: false, error: null });
    // This is only an invalidation signal. Every window reads the server value.
    try { localStorage.setItem(changeKey, `${Date.now()}:${Math.random()}`); } catch { /* Polling still synchronizes windows. */ }
    return true;
  } catch (error) {
    publish({ ...state, saving: false, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    const reconcile = () => { if (document.visibilityState !== "hidden") void refresh(); };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== changeKey && event.key !== null) return;
      revision++; request?.abort(); request = null;
      reconcile();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("online", reconcile);
    window.addEventListener("focus", reconcile);
    document.addEventListener("visibilitychange", reconcile);
    const timer = window.setInterval(reconcile, 5_000);
    cleanup = () => {
      window.clearInterval(timer);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("online", reconcile);
      window.removeEventListener("focus", reconcile);
      document.removeEventListener("visibilitychange", reconcile);
      request?.abort(); request = null;
    };
  }
  return () => { listeners.delete(listener); if (!listeners.size) { cleanup?.(); cleanup = undefined; } };
}

export function useToolApprovalSettings() {
  const current = useSyncExternalStore(subscribe, () => state, () => initial);
  useEffect(() => { void refresh(); }, []);
  return { ...current, refresh, setEnabled };
}
