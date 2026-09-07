"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import { matchManualSpeechSourceName } from "@/lib/speech-manual-file";
import type { SpeechStatus } from "@/lib/speech-types";
import { AliIcon } from "./AliIcon";
import styles from "./SpeechSettings.module.css";

const SPEECH_SETTINGS_CHANGED_EVENT = "piora:speech-settings-changed";

interface ManualSpeechPackState {
  version: string;
  platformKey: string;
  sources: Array<{
    name: string;
    url: string;
    uploaded: boolean;
    algorithm: "sha256" | "sha512";
    digest: string;
    expectedBytes: number | null;
  }>;
  complete: boolean;
}

function formatBytes(bytes: number | null): string {
  if (!bytes || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

async function responseError(response: Response): Promise<string> {
  const payload = await response.json().catch(() => ({})) as { error?: unknown };
  return typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
}

export function SpeechSettings() {
  const { t } = useI18n();
  const [status, setStatus] = useState<SpeechStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [manualBusy, setManualBusy] = useState(false);
  const [manualFeedback, setManualFeedback] = useState<{ kind: "info" | "success" | "error"; message: string } | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState<ManualSpeechPackState | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/speech/settings", { cache: "no-store" });
    if (!response.ok) throw new Error(await responseError(response));
    const next = await response.json() as SpeechStatus;
    setStatus(next);
    return next;
  }, []);

  const loadManual = useCallback(async () => {
    const response = await fetch("/api/speech/manual", { cache: "no-store" });
    if (!response.ok) throw new Error(await responseError(response));
    const next = await response.json() as ManualSpeechPackState;
    setManual(next);
    return next;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void load()
      .catch((loadError: unknown) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [load]);

  useEffect(() => {
    void loadManual().catch((loadError: unknown) => {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    });
  }, [loadManual]);

  useEffect(() => {
    if (status?.install.phase !== "downloading" && status?.install.phase !== "installing") return;
    const timer = window.setInterval(() => {
      void load().catch((loadError: unknown) => {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      });
    }, 650);
    return () => window.clearInterval(timer);
  }, [load, status?.install.phase]);

  const patchSettings = useCallback(async (body: Record<string, unknown>) => {
    const response = await fetch("/api/speech/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(await responseError(response));
    const next = await response.json() as SpeechStatus;
    setStatus(next);
    window.dispatchEvent(new Event(SPEECH_SETTINGS_CHANGED_EVENT));
  }, []);

  const runAction = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setBusy(false);
    }
  }, []);

  const install = () => runAction(async () => {
    const response = await fetch("/api/speech/packs", { method: "POST" });
    if (!response.ok) throw new Error(await responseError(response));
    await load();
  });

  const remove = () => runAction(async () => {
    const response = await fetch("/api/speech/packs", { method: "DELETE" });
    if (!response.ok) throw new Error(await responseError(response));
    setStatus(await response.json() as SpeechStatus);
    window.dispatchEvent(new Event(SPEECH_SETTINGS_CHANGED_EVENT));
  });

  const chooseDirectory = () => runAction(async () => {
    const selected = await window.piDesktop?.selectSpeechPackDirectory?.(status?.packDirectory);
    if (selected) await patchSettings({ packDirectory: selected });
  });

  const importManualFiles = useCallback(async (files: File[]) => {
    if (!manual || files.length === 0) return;
    const expectedNames = manual.sources.map((source) => source.name);
    const selected = files.flatMap((file) => {
      const sourceName = matchManualSpeechSourceName(file.name, expectedNames);
      return sourceName ? [{ file, sourceName }] : [];
    });
    if (selected.length === 0) {
      const message = t("speech.manualUnknownFile");
      setError(message);
      setManualFeedback({ kind: "error", message });
      return;
    }
    setManualBusy(true);
    setError(null);
    setManualFeedback(null);
    try {
      let next = manual;
      for (const { file, sourceName } of selected) {
        setManualFeedback({
          kind: "info",
          message: t("speech.manualVerifyingFile", { name: sourceName }),
        });
        const response = await fetch(`/api/speech/manual?name=${encodeURIComponent(sourceName)}`, {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: file,
        });
        if (!response.ok) throw new Error(await responseError(response));
        const payload = await response.json() as { manual: ManualSpeechPackState };
        next = payload.manual;
        setManual(next);
        const uploadedCount = next.sources.filter((source) => source.uploaded).length;
        setManualFeedback({
          kind: "success",
          message: next.complete
            ? t("speech.manualAllAdded")
            : t("speech.manualFileAdded", {
                name: sourceName,
                count: uploadedCount,
                total: next.sources.length,
              }),
        });
      }
      await load();
    } catch (importError) {
      const message = importError instanceof Error ? importError.message : String(importError);
      setError(message);
      setManualFeedback({ kind: "error", message });
    } finally {
      setManualBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [load, manual, t]);

  const handleDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    if (status?.installed || manualBusy) return;
    void importManualFiles(Array.from(event.dataTransfer.files));
  }, [importManualFiles, manualBusy, status?.installed]);

  const installActive = status?.install.phase === "downloading" || status?.install.phase === "installing";
  const progress = status && status.install.totalBytes > 0
    ? Math.min(100, Math.round(status.install.downloadedBytes / status.install.totalBytes * 100))
    : 0;

  if (loading && !status) {
    return <div className={styles.loading}>{t("speech.loading")}</div>;
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h2>{t("speech.title")}</h2>
          <p>{t("speech.description")}</p>
        </div>
        <span className={styles.privacyBadge}><AliIcon name="lock" size={14} />{t("speech.offlineBadge")}</span>
      </header>

      {error ? <div className={styles.error} role="alert">{error}</div> : null}
      {status?.install.phase === "error" && status.install.error
        ? <div className={styles.error} role="alert">{status.install.error}</div>
        : null}

      <section className={styles.card}>
        <div className={styles.toggleRow}>
          <div>
            <h3 data-settings-id="speech.toggle">{t("speech.toggle")}</h3>
            <p>{t("speech.toggleDescription")}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={status?.enabled ?? false}
            className={styles.switch}
            data-enabled={status?.enabled || undefined}
            disabled={busy || !status?.installed || !status.hardware.supported}
            onClick={() => runAction(() => patchSettings({ enabled: !status?.enabled }))}
          >
            <span />
          </button>
        </div>
        {!status?.installed ? <p className={styles.hint}>{t("speech.installBeforeEnable")}</p> : null}
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <div>
            <h3 data-settings-id="speech.pack">{t("speech.packTitle")}</h3>
            <p>{t("speech.packDescription")}</p>
          </div>
          <span className={status?.installed ? styles.ready : styles.notInstalled}>
            {status?.installed ? t("speech.installed") : t("speech.notInstalled")}
          </span>
        </div>

        <div className={styles.factGrid}>
          <div><span>{t("speech.engine")}</span><strong>sherpa-onnx · SenseVoiceSmall INT8</strong></div>
          <div><span>{t("speech.languages")}</span><strong>{status?.languages.join(" / ") ?? "—"}</strong></div>
          <div><span>{t("speech.downloadSize")}</span><strong>{formatBytes(status?.approximateDownloadBytes ?? null)}</strong></div>
          <div><span>{t("speech.diskUsage")}</span><strong>{formatBytes(status?.installedBytes ?? null)}</strong></div>
        </div>

        {installActive ? (
          <div className={styles.progressBlock}>
            <div><span>{status?.install.phase === "installing" ? t("speech.installing") : t("speech.downloading")}</span><strong>{progress}%</strong></div>
            <progress value={progress} max={100} />
            {status?.install.currentFile ? <small>{status.install.currentFile}</small> : null}
          </div>
        ) : null}

        <div className={styles.actions}>
          {!status?.installed ? (
            <button type="button" className={styles.primary} disabled={busy || installActive || !status?.hardware.supported} onClick={install}>
              <AliIcon name="download" size={14} />{t("speech.download")}
            </button>
          ) : (
            <button type="button" className={styles.danger} disabled={busy || installActive} onClick={remove}>
              <AliIcon name="delete" size={14} />{t("speech.remove")}
            </button>
          )}
        </div>
        <p className={styles.networkNote}>{t("speech.networkNote")}</p>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <div>
            <h3 data-settings-id="speech.manual">{t("speech.manualTitle")}</h3>
            <p>{t("speech.manualDescription")}</p>
          </div>
          <span className={styles.manualBadge}>{t("speech.manualAlwaysAvailable")}</span>
        </div>
        <div className={styles.downloadList}>
          {manual?.sources.map((source, index) => (
            <a key={source.name} href={source.url} target="_blank" rel="noreferrer" download={source.name}>
              <span><AliIcon name="download" size={14} />{t("speech.manualDownloadFile", { index: index + 1 })}</span>
              <code>{source.name}</code>
              <small>{source.expectedBytes ? `${formatBytes(source.expectedBytes)} · ` : ""}{source.algorithm.toUpperCase()} {source.digest.slice(0, 12)}…</small>
              {source.uploaded ? <strong><AliIcon name="check" size={13} />{t("speech.manualAdded")}</strong> : null}
            </a>
          ))}
        </div>
        <div
          className={styles.dropZone}
          data-active={dragActive || undefined}
          data-disabled={manualBusy || status?.installed || undefined}
          onDragEnter={(event) => { event.preventDefault(); if (!status?.installed) setDragActive(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
          }}
          onDrop={handleDrop}
        >
          <AliIcon name={status?.installed ? "check-circle" : "cloud-upload"} size={24} />
          <strong>{status?.installed ? t("speech.manualInstalled") : manualBusy ? t("speech.manualVerifying") : t("speech.manualDrop")}</strong>
          <span>{status?.installed ? t("speech.manualInstalledHint") : t("speech.manualDropHint")}</span>
          {!status?.installed ? (
            <button type="button" className={styles.secondary} disabled={manualBusy} onClick={() => fileInputRef.current?.click()}>
              {t("speech.manualChooseFiles")}
            </button>
          ) : null}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            disabled={manualBusy || status?.installed}
            onChange={(event) => void importManualFiles(Array.from(event.target.files ?? []))}
          />
        </div>
        {manualFeedback ? (
          <div
            className={styles.manualFeedback}
            data-kind={manualFeedback.kind}
            role={manualFeedback.kind === "error" ? "alert" : "status"}
          >
            {manualFeedback.message}
          </div>
        ) : null}
        <p className={styles.networkNote}>{t("speech.manualIntegrity")}</p>
        <p className={styles.networkNote}>{t("speech.manualChecksumHelp")}</p>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <div>
            <h3>{t("speech.environmentTitle")}</h3>
            <p>{t("speech.environmentDescription")}</p>
          </div>
        </div>
        <div className={styles.factGrid}>
          <div><span>{t("speech.platform")}</span><strong>{status ? `${status.hardware.platform} / ${status.hardware.arch}` : "—"}</strong></div>
          <div><span>{t("speech.cpu")}</span><strong>{status ? t("speech.cores", { count: status.hardware.logicalCores }) : "—"}</strong></div>
          <div><span>{t("speech.memory")}</span><strong>{status ? `${status.hardware.memoryGiB} GiB` : "—"}</strong></div>
          <div><span>{t("speech.strategy")}</span><strong>{status ? t(`speech.tier.${status.hardware.tier}`, { threads: status.hardware.threads }) : "—"}</strong></div>
        </div>
        {status && !status.hardware.supported ? <p className={styles.unsupported}>{t("speech.unsupportedEnvironment")}</p> : null}
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <div>
            <h3 data-settings-id="speech.location">{t("speech.locationTitle")}</h3>
            <p>{t("speech.locationDescription")}</p>
          </div>
        </div>
        <div className={styles.pathRow}>
          <code>{status?.packDirectory ?? "—"}</code>
          {window.piDesktop?.selectSpeechPackDirectory ? (
            <button type="button" className={styles.secondary} disabled={busy || installActive} onClick={chooseDirectory}>
              {t("speech.chooseLocation")}
            </button>
          ) : null}
        </div>
        <p className={styles.hint}>{t("speech.locationHint")}</p>
      </section>
    </div>
  );
}
