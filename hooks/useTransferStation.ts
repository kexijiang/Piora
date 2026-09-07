"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CompanionLibraryItem } from "@/lib/companion-store";
import { requestTransferItems } from "@/lib/transfer-station-client";
export function useTransferStation(enabled: boolean) {
  const [items, setItems] = useState<CompanionLibraryItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const queue = useRef(Promise.resolve());
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const refresh = useCallback(() => {
    if (refreshInFlight.current) return refreshInFlight.current;
    setLoading(true);
    setError("");
    const operation = queue.current.then(async () => {
      const items = await requestTransferItems();
      setItems(items); setLoaded(true); setError("");
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }).finally(() => {
      setLoading(false);
      refreshInFlight.current = null;
    });
    refreshInFlight.current = operation;
    queue.current = operation.catch(() => {});
    return operation;
  }, []);
  useEffect(() => {
    if (!enabled) return;
    const report = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));
    void refresh().catch(report);
    const onVisible = () => { if (document.visibilityState === "visible") void refresh().catch(report); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [enabled, refresh]);
  const mutate = useCallback((method: "POST" | "PATCH", input: unknown, throwOnError = false): Promise<boolean> => {
    const operation = queue.current.then(async () => {
      setPending(true); setError("");
      try {
        const items = await requestTransferItems(method, input);
        setItems(items); setLoaded(true); return true;
      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); if (throwOnError) throw cause; return false; }
      finally { setPending(false); }
    });
    queue.current = operation.then(() => {}, () => {});
    return operation;
  }, []);
  return { items, loaded, loading, pending, error, refresh, mutate };
}
