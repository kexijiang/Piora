"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { COMPACT_PROCESS_STORAGE_KEY, DEFAULT_COMPACT_PROCESS, parseCompactProcessPreference } from "@/lib/compact-process-preference";

const listeners = new Set<() => void>();
let enabled = DEFAULT_COMPACT_PROCESS;

function update(next: boolean) {
  if (next === enabled) return;
  enabled = next;
  listeners.forEach((listener) => listener());
}

function readStored() {
  try { update(parseCompactProcessPreference(window.localStorage.getItem(COMPACT_PROCESS_STORAGE_KEY))); }
  catch { /* Retain the renderer's choice when storage is unavailable. */ }
}

function storageChanged(event: StorageEvent) {
  if (event.key === COMPACT_PROCESS_STORAGE_KEY || event.key === null) readStored();
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) window.addEventListener("storage", storageChanged);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", storageChanged);
  };
}

export function useCompactProcessPreference() {
  const current = useSyncExternalStore(subscribe, () => enabled, () => DEFAULT_COMPACT_PROCESS);
  useEffect(readStored, []);
  const setEnabled = useCallback((next: boolean) => {
    try { window.localStorage.setItem(COMPACT_PROCESS_STORAGE_KEY, String(next)); }
    catch { /* Apply immediately even if persistence is unavailable. */ }
    update(next);
  }, []);
  return { enabled: current, setEnabled };
}
