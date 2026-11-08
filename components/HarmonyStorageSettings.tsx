"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { AliIcon } from "./AliIcon";

type StoragePaths = { screenshotDirectory: string; recordingDirectory: string };
type ConfigPayload = {
  config?: { storage?: Partial<StoragePaths> };
  storage?: StoragePaths;
  error?: string | { message?: string };
};
function errorText(payload: ConfigPayload, status: number): string {
  return typeof payload.error === "string" ? payload.error : payload.error?.message || `HTTP ${status}`;
}

export function HarmonyStorageSettings({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useI18n();
  const [desktopAvailable, setDesktopAvailable] = useState<boolean | null>(null);
  const [paths, setPaths] = useState<StoragePaths>({ screenshotDirectory: "", recordingDirectory: "" });
  const [defaults, setDefaults] = useState<StoragePaths | null>(null);
  const saved = useRef("");
  const latest = useRef(paths);
  const queue = useRef(Promise.resolve());
  const intent = useRef(0);
  const resetSnapshot = useRef<string | null>(null);
  latest.current = paths;
  const [status, setStatus] = useState<"loading" | "idle" | "saving" | "saved" | "error">("loading");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const response = await fetch("/api/harmony/config", { cache: "no-store" });
      const payload = await response.json() as ConfigPayload;
      if (!response.ok || !payload.storage) throw new Error(errorText(payload, response.status));
      setDefaults(payload.storage);
      const initial = {
        screenshotDirectory: payload.config?.storage?.screenshotDirectory || payload.storage.screenshotDirectory,
        recordingDirectory: payload.config?.storage?.recordingDirectory || payload.storage.recordingDirectory,
      };
      saved.current = JSON.stringify(initial);
      setPaths(initial);
      setError("");
      setStatus("idle");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    const available = Boolean(window.piDesktop);
    setDesktopAvailable(available);
    if (available) void load();
    else setStatus("idle");
  }, [load]);

  const choose = async (field: keyof StoragePaths) => {
    const selected = await window.piDesktop?.selectDirectory?.();
    if (selected) setPaths((current) => ({ ...current, [field]: selected }));
  };

  const save = async (reset = false, snapshot = paths) => {
    setStatus("saving");
    try {
      const response = await fetch("/api/harmony/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storage: reset ? null : {
            screenshotDirectory: snapshot.screenshotDirectory.trim(),
            recordingDirectory: snapshot.recordingDirectory.trim(),
          },
        }),
      });
      const payload = await response.json() as ConfigPayload;
      if (!response.ok || !payload.storage) throw new Error(errorText(payload, response.status));
      setDefaults(payload.storage);
      saved.current = JSON.stringify(reset ? payload.storage : snapshot);
      if (reset) resetSnapshot.current = null;
      if (JSON.stringify(latest.current) === JSON.stringify(snapshot)) {
        if (reset) setPaths(payload.storage);
        setError("");
        setStatus("saved");
      }
    } catch (reason) {
      if (reset) resetSnapshot.current = null;
      setError(reason instanceof Error ? reason.message : String(reason));
      setStatus("error");
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => () => {
    const snapshot = latest.current;
    if (saved.current && JSON.stringify(snapshot) !== saved.current && JSON.stringify(snapshot) !== resetSnapshot.current && snapshot.screenshotDirectory.trim() && snapshot.recordingDirectory.trim()) {
      queue.current = queue.current.then(() => saveRef.current(false, snapshot));
    }
  }, []);

  useEffect(() => {
    const snapshot = paths, signature = JSON.stringify(snapshot), expectedIntent = intent.current;
    if (!saved.current || signature === saved.current || !snapshot.screenshotDirectory.trim() || !snapshot.recordingDirectory.trim()) return;
    const timer = setTimeout(() => {
      queue.current = queue.current.then(async () => {
        if (intent.current !== expectedIntent || JSON.stringify(latest.current) !== signature) return;
        await save(false, snapshot);
      });
    }, 700);
    return () => clearTimeout(timer);
  // Changes to paths schedule persistence; status updates must not restart the timer.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paths]);

  const field = (key: keyof StoragePaths, label: string, description: string) => (
    <label data-settings-id={key === "screenshotDirectory" ? "harmony.screenshots" : "harmony.recordings"} style={{ display: "grid", gap: 7 }}>
      <span style={{ display: "grid", gap: 2 }}>
        <strong style={{ color: "var(--text)", fontSize: "var(--text-sm)" }}>{label}</strong>
        <small style={{ color: "var(--text-dim)", lineHeight: 1.45 }}>{description}</small>
      </span>
      <span style={{ display: "flex", gap: 8 }}>
        <input
          aria-label={label}
          value={paths[key]}
          disabled={status === "loading"}
          onChange={(event) => { setPaths((current) => ({ ...current, [key]: event.target.value })); setStatus("idle"); }}
          style={{ flex: 1, minWidth: 0 }}
        />
        {desktopAvailable && window.piDesktop?.selectDirectory ? (
          <button type="button" onClick={() => void choose(key)} title={t("harmonyStorage.choose")} aria-label={t("harmonyStorage.choose")}>
            <AliIcon name="folder-open" size={14} />
          </button>
        ) : null}
      </span>
    </label>
  );

  return (
    <div className="settings-embedded-surface" style={embedded ? { padding: "20px 24px 24px" } : { height: "100%", overflowY: "auto", padding: "26px 30px 34px" }}>
      {!embedded ? <div style={{ marginBottom: 22 }}>
        <h2 style={{ margin: 0, color: "var(--text)", fontSize: "calc(var(--text-lg) * 1.22)", fontWeight: 680 }}>{t("harmonyStorage.title")}</h2>
        <p style={{ margin: "7px 0 0", color: "var(--text-muted)", fontSize: "var(--text-sm)", lineHeight: 1.55 }}>{t("harmonyStorage.description")}</p>
      </div> : null}
      {desktopAvailable === false ? (
        <section className="settings-conversation-section" style={{ maxWidth: 760 }}>
          <p style={{ margin: 0, color: "var(--text-muted)", lineHeight: 1.55 }}>{t("harmonyStorage.desktopOnly")}</p>
        </section>
      ) : null}
      {desktopAvailable !== false ? (
      <div style={{ display: "grid", gap: 18, maxWidth: 760 }}>
      <section className={embedded ? undefined : "settings-conversation-section"} style={{ display: "grid", gap: 20, maxWidth: 760 }}>
        <div style={{ display: "grid", gap: 4 }}><strong style={{ color: "var(--text)" }}>{t("harmonyStorage.mediaTitle")}</strong><small style={{ color: "var(--text-dim)", lineHeight: 1.5 }}>{t("harmonyStorage.mediaDescription")}</small></div>
        {field("screenshotDirectory", t("harmonyStorage.screenshotDirectory"), t("harmonyStorage.screenshotDescription"))}
        {field("recordingDirectory", t("harmonyStorage.recordingDirectory"), t("harmonyStorage.recordingDescription"))}
        {defaults ? <p style={{ margin: 0, color: "var(--text-dim)", fontSize: "var(--text-xs)", lineHeight: 1.5 }}>{t("harmonyStorage.absolutePathHint")}</p> : null}
        <div><button type="button" disabled={status === "saving" || status === "loading"} onClick={() => { intent.current++; resetSnapshot.current = JSON.stringify(latest.current); queue.current = queue.current.then(() => save(true)); }}>{t("harmonyStorage.restoreDefaults")}</button></div>
        {status === "saved" ? <span role="status" style={{ color: "var(--status-success)", fontSize: "var(--text-xs)" }}>{t("harmonyStorage.saved")}</span> : null}
        {status === "loading" ? <p>{t("harmonyStorage.loading")}</p> : null}
        {error ? <p role="alert" style={{ color: "var(--status-failed)", overflowWrap: "anywhere" }}>{error}</p> : null}
      </section>
      </div>
      ) : null}
    </div>
  );
}
