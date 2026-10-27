"use client";
import { useEffect, useState } from "react";
import type { HarmonyWindowState } from "@/desktop/src/harmony-window-types";
export function useHarmonyWindow() {
  const [state, setState] = useState<HarmonyWindowState | null>(null);
  useEffect(() => {
    const bridge = window.piDesktop?.harmonyMirror;
    if (!bridge) return;
    let disposed = false;
    let observedEvent = false;
    const update = (next: HarmonyWindowState) => { if (!disposed) setState(next); };
    const unsubscribe = bridge.onStateChange(next => { observedEvent = true; update(next); });
    void bridge.getState().then(next => { if (!observedEvent) update(next); }).catch(() => undefined);
    return () => { disposed = true; unsubscribe(); };
  }, []);
  return state;
}
