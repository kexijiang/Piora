"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ModelErrorText } from "./ModelErrorText";
import styles from "./SettingsDialog.module.css";

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
  return <section className={styles.conversationSection} data-settings-id="models.fallback">
    <div className={styles.conversationRow}>
      <div className={styles.conversationCopy}>
        <div className={styles.rowTitle}>{t("models.fallback.title")}</div>
        <div id="ModelFallbackSetting-description" className={styles.rowDescription}>{t("models.fallback.description")}</div>
        {error ? <p role="alert" style={{ color: "var(--error, #dc2626)", margin: "5px 0 0" }}><ModelErrorText value={error} /></p> : null}
      </div>
      <button type="button" role="switch" className={styles.switch}
        aria-label={t("models.fallback.title")} aria-describedby="ModelFallbackSetting-description"
        aria-checked={enabled} disabled={busy} onClick={() => void toggle()}>
        <span />
      </button>
    </div>
  </section>;
}
