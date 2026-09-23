"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { AliIcon } from "./AliIcon";
import styles from "./ModelRetrySettings.module.css";

export function ModelCompactionSettings() {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/models-config/compaction", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as { reserveTokens?: number; error?: string };
        if (!response.ok || typeof data.reserveTokens !== "number") throw new Error(data.error ?? `HTTP ${response.status}`);
        setValue(String(data.reserveTokens));
        setSaved(String(data.reserveTokens));
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => controller.abort();
  }, []);

  const numeric = Number(value);
  const valid = value.trim() !== "" && Number.isInteger(numeric) && numeric >= 0 && numeric <= 131_072;

  const save = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    setSuccess(false);
    try {
      const response = await fetch("/api/models-config/compaction", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings: { reserveTokens: numeric } }),
      });
      const data = await response.json() as { reserveTokens?: number; error?: string };
      if (!response.ok || typeof data.reserveTokens !== "number") throw new Error(data.error ?? `HTTP ${response.status}`);
      setValue(String(data.reserveTokens));
      setSaved(String(data.reserveTokens));
      setSuccess(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return <section className={styles.card} aria-labelledby="model-compaction-title">
    <div className={styles.heading}>
      <span className={styles.icon}><AliIcon name="timer" size={17} /></span>
      <div>
        <h3 id="model-compaction-title">{t("modelCompaction.title")}</h3>
        <p>{t("modelCompaction.description")}</p>
      </div>
    </div>
    <div className={styles.fields}>
      <label>
        <span>{t("modelCompaction.reserveTokens")}</span>
        <input type="number" min={0} max={131072} step={1} value={value} disabled={busy} aria-invalid={value !== "" && !valid} onChange={(event) => { setValue(event.target.value); setSuccess(false); setError(null); }} />
        <small>{t("modelCompaction.reserveHint")}</small>
      </label>
    </div>
    {error ? <div className={styles.error} role="alert">{error}</div> : null}
    {success ? <div className={styles.success} role="status">{t("modelCompaction.saved")}</div> : null}
    <div className={styles.footer}>
      <p><AliIcon name="info" size={13} />{t("modelCompaction.scope")}</p>
      <div className={styles.actions}><button type="button" className={styles.primary} disabled={busy || !valid || value === saved} onClick={() => void save()}>{busy ? t("modelRetry.applying") : t("modelRetry.save")}</button></div>
    </div>
  </section>;
}
