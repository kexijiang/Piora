"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isPermissionMode, type PermissionMode, type ToolPermissionState } from "@/lib/tool-permission-policy";

export const DEFAULT_TOOL_PERMISSION_CHANGED = "piora:default-tool-permission-changed";

export function notifyDefaultToolPermissionChanged() {
  window.dispatchEvent(new Event(DEFAULT_TOOL_PERMISSION_CHANGED));
}

export async function saveDefaultToolPermission(mode: PermissionMode): Promise<ToolPermissionState> {
  const res = await fetch("/api/tool-permissions", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const value = await res.json();
  if (!isPermissionMode(value.mode)) throw new Error("Invalid permission state");
  notifyDefaultToolPermissionChanged();
  return { mode: value.mode, revision: 0 };
}

/** Shared by settings and the launcher; stale reads must not undo a saved choice. */
export function useDefaultToolPermission() {
  const [state, setState] = useState<ToolPermissionState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const savingRef = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    const refresh = async () => {
      if (savingRef.current) return;
      const request = ++generation.current;
      try {
        const res = await fetch("/api/tool-permissions", { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const value = await res.json();
        if (!isPermissionMode(value.mode)) throw new Error("Invalid permission state");
        if (!controller.signal.aborted && request === generation.current) setState({ mode: value.mode, revision: 0 });
      } catch (error) {
        if (!controller.signal.aborted && request === generation.current) setError(String(error));
      }
    };
    void refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener(DEFAULT_TOOL_PERMISSION_CHANGED, refresh);
    return () => {
      mounted.current = false;
      controller.abort();
      window.removeEventListener("focus", refresh);
      window.removeEventListener(DEFAULT_TOOL_PERMISSION_CHANGED, refresh);
    };
  }, []);
  const save = useCallback(async (mode: PermissionMode) => {
    if (savingRef.current) return;
    savingRef.current = true;
    ++generation.current;
    setSaving(true); setError("");
    try {
      const next = await saveDefaultToolPermission(mode);
      if (mounted.current) setState(next);
    } catch (error) {
      if (mounted.current) setError(String(error));
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  }, []);
  return { state, saving, savingRef, error, save };
}
