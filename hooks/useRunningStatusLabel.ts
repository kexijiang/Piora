"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { normalizeRunningStatusLabels } from "@/lib/running-status-labels";


const key = "piora-running-status-labels:v2";
const legacyKey = "piora-running-status-label:v1";
const empty: readonly string[] = [];
let labels: readonly string[] = empty;
const listeners = new Set<() => void>();
function notify() { listeners.forEach(listener => listener()); }
function read() {
  try {
    const stored = localStorage.getItem(key);
    const legacy = localStorage.getItem(legacyKey)?.slice(0, 80).trim();
    const next = normalizeRunningStatusLabels(stored === null ? legacy ? [legacy] : [] : JSON.parse(stored));
    if (JSON.stringify(next) !== JSON.stringify(labels)) { labels = next; notify(); }
  } catch { /* Retain the in-memory preference if stored data cannot be read. */ }
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => { if (event.key === key || event.key === legacyKey || event.key === null) read(); };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", onStorage); };
}
function setLabels(value: readonly string[]) {
  labels = normalizeRunningStatusLabels(value);
  try { localStorage.setItem(key, JSON.stringify(labels)); } catch { /* Apply in memory when storage is unavailable. */ }
  notify();
}
function setLabel(value: string) { setLabels(value.trim() ? [Array.from(value).slice(0, 80).join("")] : []); }
export function useRunningStatusLabel() {
  const value = useSyncExternalStore(subscribe, () => labels, () => empty);
  const [ready, setReady] = useState(false);
  useEffect(() => { read(); setReady(true); }, []);
  return { labels: value, setLabels, label: value[0] ?? "", setLabel, ready };
}
