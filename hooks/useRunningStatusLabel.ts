"use client";

import { useEffect, useSyncExternalStore } from "react";


const key = "piora-running-status-label:v1";
let label = "";
const listeners = new Set<() => void>();
function notify() { listeners.forEach(listener => listener()); }
function read() {
  try { label = (localStorage.getItem(key) ?? "").slice(0, 80); notify(); } catch { /* Retain the in-memory preference. */ }
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => { if (event.key === key || event.key === null) read(); };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", onStorage); };
}
function setLabel(value: string) {
  label = value.slice(0, 80);
  try { localStorage.setItem(key, label); } catch { /* Apply in memory when storage is unavailable. */ }
  notify();
}
export function useRunningStatusLabel() {
  const value = useSyncExternalStore(subscribe, () => label, () => "");
  useEffect(read, []);
  return { label: value, setLabel };
}
