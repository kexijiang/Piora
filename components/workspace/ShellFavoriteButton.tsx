"use client";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { shellRequest } from "@/lib/shell/client";
import type { HistoryRecord } from "@/lib/shell/types";

export function ShellFavoriteButton({ id, onError }: { id: string; onError: (message: string) => void }) {
  const { t } = useI18n();
  const [favorite, setFavorite] = useState(false), [pending, setPending] = useState(true);
  const busy = useRef(true), request = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController(); request.current = controller; busy.current = true;
    void shellRequest<{ record: HistoryRecord | null }>(`history/${id}`, undefined, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setFavorite(result.record?.favorite === true); })
      .catch(cause => { if (!controller.signal.aborted) onError(String(cause)); })
      .finally(() => { if (!controller.signal.aborted) { busy.current = false; setPending(false); } });
    return () => request.current?.abort();
  }, [id, onError]);
  const toggle = async () => {
    if (busy.current) return;
    const controller = new AbortController(); request.current = controller;
    const next = !favorite; busy.current = true; setPending(true);
    try {
      await shellRequest(`history/${id}`, { favorite: next }, { method: "PATCH", signal: controller.signal });
      if (!controller.signal.aborted) setFavorite(next);
    } catch (cause) { if (!controller.signal.aborted) onError(String(cause)); }
    finally { if (!controller.signal.aborted) { busy.current = false; setPending(false); } }
  };
  return <button aria-pressed={favorite} disabled={pending} title={t("shell.favorite")} aria-label={t("shell.favorite")} onClick={() => void toggle()}>{favorite ? "★" : "☆"}</button>;
}
