"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { QuickAccessBridge, QuickAccessEntry, QuickAccessKind, QuickAccessMutation, QuickAccessSnapshot } from "@/desktop/src/quick-access-types";
import { quickAccessErrorKey, quickAccessName } from "@/lib/quick-access";
import { useI18n } from "./useI18n";

export function useQuickAccess() {
  const { t } = useI18n();
  const [data, setData] = useState<QuickAccessSnapshot>({ items: [], presets: [] });
  const [supported, setSupported] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const bridgeRef = useRef<QuickAccessBridge | undefined>(undefined);
  const revision = useRef(0);
  const mounted = useRef(false);
  const working = useRef(false);
  const nextRevision = useCallback(() => ++revision.current, []);
  const refresh = useCallback(async () => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    const request = nextRevision();
    try {
      const snapshot = await bridge.list();
      if (mounted.current && request === revision.current) { setData(snapshot); setError(""); }
    } catch (cause) { if (mounted.current && request === revision.current) setError(quickAccessErrorKey(cause)); }
    finally { if (mounted.current && request === revision.current) setLoading(false); }
  }, [nextRevision]);

  useEffect(() => {
    mounted.current = true;
    bridgeRef.current = window.piDesktop?.quickAccess;
    setSupported(Boolean(bridgeRef.current));
    if (bridgeRef.current) void refresh();
    else setLoading(false);
    const unsubscribe = bridgeRef.current?.subscribe(() => { void refresh(); });
    const focus = () => { if (!working.current) void refresh(); };
    const visible = () => { if (document.visibilityState === "visible") focus(); };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visible);
    return () => {
      mounted.current = false; nextRevision(); unsubscribe?.();
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [nextRevision, refresh]);

  const perform = useCallback(async <T,>(operation: (bridge: QuickAccessBridge) => Promise<T>): Promise<{ value: T } | null> => {
    if (working.current || !bridgeRef.current) return null;
    working.current = true; setBusy(true); setError(""); setNotice("");
    try { return { value: await operation(bridgeRef.current) }; }
    catch (cause) { if (mounted.current) setError(quickAccessErrorKey(cause)); return null; }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  }, []);

  const mutate = useCallback(async (input: QuickAccessMutation) => {
    nextRevision();
    const result = await perform(bridge => bridge.mutate(input));
    if (!result || !mounted.current) return false;
    nextRevision(); setData(result.value); setLoading(false);
    setNotice(input.type === "reorder" ? "" : t(input.type === "remove" ? "quickAccess.removed" : "quickAccess.saved"));
    return true;
  }, [nextRevision, perform, t]);

  const open = useCallback(async (item: QuickAccessEntry, action: Parameters<QuickAccessBridge["open"]>[1] = "open") => {
    const result = await perform(bridge => bridge.open(item.id, action));
    if (result && mounted.current) setNotice(result.value.status === "cancelled" ? t("quickAccess.cancelled") : action === "copy" ? t("quickAccess.copied") : t("quickAccess.opened", { name: quickAccessName(item, t) }));
    // Refresh availability without clearing a launch error.
    const request = nextRevision();
    try {
      const snapshot = await bridgeRef.current?.list();
      if (snapshot && mounted.current && request === revision.current) setData(snapshot);
    } catch { /* The operation's error takes precedence. */ }
    return Boolean(result);
  }, [nextRevision, perform, t]);

  const pick = useCallback(async (kind: QuickAccessKind) => (await perform(bridge => bridge.pick(kind)))?.value ?? null, [perform]);
  const clearNotice = useCallback(() => { setError(""); setNotice(""); }, []);
  return { ...data, supported, loading, busy, error, notice, refresh, mutate, open, pick, clearNotice };
}

export type QuickAccessController = ReturnType<typeof useQuickAccess>;
