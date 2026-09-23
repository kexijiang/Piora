"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ModelErrorText } from "./ModelErrorText";

export function ModelFallbackSetting() {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/models/fallback", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const config = await response.json() as { enabled: boolean };
        if (!controller.signal.aborted) setEnabled(config.enabled);
      })
      .catch((reason) => { if (!controller.signal.aborted) setError(String(reason)); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, []);
  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/models/fallback", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !enabled }),
      });
      const config = await response.json() as { enabled: boolean; error?: string };
      if (!response.ok) throw new Error(config.error || `HTTP ${response.status}`);
      setEnabled(config.enabled);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  return <div data-settings-id="models.fallback" style={{ padding: "12px 18px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
    <label style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--text)", fontSize: "var(--text-sm)" }}>
      <input type="checkbox" role="switch" checked={enabled} disabled={busy} onChange={() => void toggle()} />
      <strong>{t("models.fallback.title")}</strong>
    </label>
    <p style={{ margin: "5px 0 0", color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>{t("models.fallback.description")}</p>
    {error ? <p role="alert" style={{ color: "var(--error, #dc2626)", margin: "5px 0 0" }}>{<ModelErrorText value={error} />}</p> : null}
  </div>;
}
