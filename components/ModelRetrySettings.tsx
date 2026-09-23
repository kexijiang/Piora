"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { AliIcon } from "./AliIcon";
import styles from "./ModelRetrySettings.module.css";

interface LoadedSettings {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
  provider: { timeoutMs: number | null; maxRetries: number | null; maxRetryDelayMs: number };
  httpIdleTimeoutMs: number;
}

interface Draft {
  enabled: boolean;
  maxRetries: string;
  baseDelayMs: string;
  providerTimeout: string;
  providerRetries: string;
  providerDelay: string;
  idleTimeout: string;
}

function secondsOf(ms: number | null): string {
  return ms === null ? "" : String(Math.round(ms / 1000));
}

function toDraft(settings: LoadedSettings): Draft {
  return {
    enabled: settings.enabled,
    maxRetries: String(settings.maxRetries),
    baseDelayMs: String(settings.baseDelayMs),
    providerTimeout: secondsOf(settings.provider.timeoutMs),
    providerRetries: settings.provider.maxRetries === null ? "" : String(settings.provider.maxRetries),
    providerDelay: String(Math.round(settings.provider.maxRetryDelayMs / 1000)),
    idleTimeout: String(Math.round(settings.httpIdleTimeoutMs / 1000)),
  };
}

function toPayload(draft: Draft): { settings: LoadedSettings } {
  const secondsToMs = (raw: string): number | null => (raw.trim() === "" ? null : Math.round(Number(raw.trim()) * 1000));
  const nullableInt = (raw: string): number | null => (raw.trim() === "" ? null : Number(raw.trim()));
  return {
    settings: {
      enabled: draft.enabled,
      maxRetries: Number(draft.maxRetries.trim()),
      baseDelayMs: Number(draft.baseDelayMs.trim()),
      provider: {
        timeoutMs: secondsToMs(draft.providerTimeout),
        maxRetries: nullableInt(draft.providerRetries),
        maxRetryDelayMs: secondsToMs(draft.providerDelay) ?? 0,
      },
      httpIdleTimeoutMs: secondsToMs(draft.idleTimeout) ?? 0,
    },
  };
}

async function responseError(response: Response): Promise<string> {
  const payload = await response.json().catch(() => ({})) as { error?: unknown };
  return typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
}

export function ModelRetrySettings() {
  const { t } = useI18n();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/models-config/retry", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseError(response));
        setDraft(toDraft(await response.json() as LoadedSettings));
      })
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : String(loadError));
      });
    return () => controller.abort();
  }, []);

  const update = useCallback((patch: Partial<Draft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setDirty(true);
    setError(null);
    setResult(null);
  }, []);

  const save = useCallback(async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch("/api/models-config/retry", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toPayload(draft)),
      });
      if (!response.ok) throw new Error(await responseError(response));
      setDraft(toDraft(await response.json() as LoadedSettings));
      setDirty(false);
      setResult(t("modelRetry.saved"));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setBusy(false);
    }
  }, [draft, t]);

  return (
    <section className={styles.card} aria-labelledby="model-retry-title">
      <div className={styles.heading}>
        <span className={styles.icon}><AliIcon name="timer" size={17} /></span>
        <div>
          <h3 id="model-retry-title">{t("modelRetry.title")}</h3>
          <p>{t("modelRetry.description")}</p>
        </div>
      </div>

      {draft ? (
        <div className={styles.fields}>
          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={draft.enabled}
              disabled={busy}
              onChange={(event) => update({ enabled: event.target.checked })}
            />
            {t("modelRetry.enabled")}
          </label>
          <label>
            <span>{t("modelRetry.maxRetries")}</span>
            <input type="number" min={0} max={10} value={draft.maxRetries} disabled={busy} onChange={(event) => update({ maxRetries: event.target.value })} />
          </label>
          <label>
            <span>{t("modelRetry.baseDelayMs")}</span>
            <input type="number" min={100} max={60000} value={draft.baseDelayMs} disabled={busy} onChange={(event) => update({ baseDelayMs: event.target.value })} />
          </label>
          <label>
            <span>{t("modelRetry.providerTimeout")}</span>
            <input type="number" min={1} max={3600} value={draft.providerTimeout} disabled={busy} onChange={(event) => update({ providerTimeout: event.target.value })} />
            <small>{t("modelRetry.providerTimeoutHint")}</small>
          </label>
          <label>
            <span>{t("modelRetry.idleTimeout")}</span>
            <input type="number" min={0} max={3600} value={draft.idleTimeout} disabled={busy} onChange={(event) => update({ idleTimeout: event.target.value })} />
            <small>{t("modelRetry.idleTimeoutHint")}</small>
          </label>
          <label>
            <span>{t("modelRetry.providerRetries")}</span>
            <input type="number" min={0} max={5} value={draft.providerRetries} disabled={busy} onChange={(event) => update({ providerRetries: event.target.value })} />
            <small>{t("modelRetry.providerRetriesHint")}</small>
          </label>
          <label>
            <span>{t("modelRetry.providerDelay")}</span>
            <input type="number" min={0} max={300} value={draft.providerDelay} disabled={busy} onChange={(event) => update({ providerDelay: event.target.value })} />
          </label>
        </div>
      ) : null}

      {error ? <div className={styles.error} role="alert">{error}</div> : null}
      {result ? <div className={styles.success} role="status">{result}</div> : null}

      <div className={styles.footer}>
        <p><AliIcon name="info" size={13} />{t("modelRetry.scope")}</p>
        <div className={styles.actions}>
          <button type="button" className={styles.primary} disabled={!draft || busy || !dirty} onClick={() => void save()}>
            {busy ? t("modelRetry.applying") : t("modelRetry.save")}
          </button>
        </div>
      </div>
    </section>
  );
}
