"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowserMode } from "@/lib/browser-config";
import { useI18n } from "./useI18n";

const CHANGED_EVENT = "piora:browser-mode-changed";

export function useBrowserMode(active = true) {
  const { t } = useI18n();
  const [mode, setMode] = useState<BrowserMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const version = useRef(0);
  const savingRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      const request = ++version.current;
      try {
        const response = await fetch("/api/browser/settings", { cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || t("browser.unavailable"));
        if (request !== version.current || controller.signal.aborted) return;
        setMode(data.mode === "background" ? "background" : "builtin");
        setError(null);
      } catch (failure) {
        if (request === version.current && !controller.signal.aborted) setError(String(failure));
      }
    };
    const changed = (event: Event) => {
      const next = (event as CustomEvent<BrowserMode>).detail;
      if (next !== "builtin" && next !== "background") return;
      ++version.current; // A late GET must not overwrite the confirmed save.
      setMode(next);
      setError(null);
    };
    const refresh = () => { if (active && !savingRef.current) void load(); };
    window.addEventListener(CHANGED_EVENT, changed);
    window.addEventListener("focus", refresh);
    if (active) void load();
    return () => {
      controller.abort();
      window.removeEventListener(CHANGED_EVENT, changed);
      window.removeEventListener("focus", refresh);
    };
  }, [active, t]);

  const changeMode = useCallback(async (next: BrowserMode) => {
    if (savingRef.current) return;
    savingRef.current = true;
    ++version.current;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/browser/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: next }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t("browser.actionFailed"));
      window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: data.mode }));
    } catch (failure) { setError(String(failure)); }
    finally { savingRef.current = false; setSaving(false); }
  }, [t]);

  return { mode, error, saving, changeMode };
}
