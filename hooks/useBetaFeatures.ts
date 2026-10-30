"use client";
import { useEffect, useSyncExternalStore } from "react";
import { DEFAULT_BETA_FEATURES, type BetaFeatures } from "@/lib/beta-feature-types";
import { flushPendingAnswerState, setAnswerStateEnabled } from "@/lib/answer-output-client";

const initial = { features: DEFAULT_BETA_FEATURES as BetaFeatures, loading: true, error: "" };
let snapshot = initial;
const listeners = new Set<() => void>();
let request: Promise<void> | undefined;
let generation = 0;
function publish(next: typeof snapshot) { snapshot = next; listeners.forEach(listener => listener()); }
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function refreshBetaFeatures(): Promise<void> {
  if (request) return request;
  const current = generation;
  request = fetch("/api/beta-features", { cache: "no-store" }).then(async response => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const features = await response.json() as BetaFeatures;
    if (current === generation) {
      setAnswerStateEnabled(features.intelligentUi === true);
      publish({ features: { intelligentUi: features.intelligentUi === true }, loading: false, error: "" });
    }
  }).catch(error => {
    if (current === generation) publish({ ...snapshot, loading: false, error: String(error) });
  }).finally(() => { request = undefined; });
  return request;
}
export async function saveBetaFeatures(features: BetaFeatures, retainPending = false): Promise<void> {
  if (!features.intelligentUi && !retainPending) await flushPendingAnswerState();
  const response = await fetch("/api/beta-features", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(features) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  generation++;
  setAnswerStateEnabled(body.intelligentUi === true);
  publish({ features: { intelligentUi: body.intelligentUi === true }, loading: false, error: "" });
  // Other renderer windows refresh through a lightweight preference notification.
  try { window.localStorage.setItem("piora-beta-features-changed", String(Date.now())); } catch { /* private browsing */ }
}
export function useBetaFeatures() {
  const state = useSyncExternalStore(subscribe, () => snapshot, () => initial);
  useEffect(() => {
    void refreshBetaFeatures();
    const refresh = () => { void refreshBetaFeatures(); };
    const storage = (event: StorageEvent) => { if (event.key === "piora-beta-features-changed") refresh(); };
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", storage);
    return () => { window.removeEventListener("focus", refresh); window.removeEventListener("storage", storage); };
  }, []);
  return { ...state, refresh: refreshBetaFeatures };
}
