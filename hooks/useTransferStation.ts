"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CompanionLibraryItem } from "@/lib/companion-store";
export function useTransferStation(enabled: boolean) {
  const [items, setItems] = useState<CompanionLibraryItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const queue = useRef(Promise.resolve());
  const refresh = useCallback(() => {
    const operation = queue.current.then(async () => {
      const response = await fetch("/api/companion/library", { cache: "no-store", signal: AbortSignal.timeout(12_000) });
      const payload = await response.json();
      if (!response.ok || !Array.isArray(payload.items)) throw new Error(payload.error || "中转站加载失败。");
      setItems(payload.items); setLoaded(true); setError("");
    });
    queue.current = operation.catch(() => {});
    return operation;
  }, []);
  useEffect(() => {
    if (!enabled) return;
    void refresh().catch((cause: unknown) => setError(String(cause)));
    const onVisible = () => { if (document.visibilityState === "visible") void refresh().catch((cause: unknown) => setError(String(cause))); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [enabled, refresh]);
  const mutate = useCallback((method: "POST" | "PATCH", input: unknown): Promise<boolean> => {
    const operation = queue.current.then(async () => {
      setPending(true); setError("");
      try {
        const response = await fetch("/api/companion/library", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.timeout(20_000) });
        const payload = await response.json();
        if (!response.ok || !Array.isArray(payload.items)) throw new Error(payload.error || "暂存失败，请重试。");
        setItems(payload.items); setLoaded(true); return true;
      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
      finally { setPending(false); }
    });
    queue.current = operation.then(() => {});
    return operation;
  }, []);
  return { items, loaded, pending, error, refresh, mutate };
}
