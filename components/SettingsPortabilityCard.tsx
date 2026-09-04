"use client";

import { useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  PORTABLE_SETTINGS_MAX_BYTES,
  SETTINGS_REOPEN_STORAGE_KEY,
  SettingsPortabilityError,
  applyPortableSettings,
  createPortableSettingsBundle,
  getPortableSettingsDiff,
  parsePortableSettings,
  readPortableSettingsPreferences,
  serializePortableSettings,
  type PortableSettingKey,
  type PortableSettingsBundle,
  type PortableSettingsDiff,
} from "@/lib/settings-portability";
import { AliIcon } from "./AliIcon";
import styles from "./SettingsPortabilityCard.module.css";

interface ImportPreview {
  fileName: string;
  bundle: PortableSettingsBundle;
  diff: PortableSettingsDiff[];
}

export function SettingsPortabilityCard() {
  const { locale, t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const exportSettings = () => {
    const bundle = createPortableSettingsBundle(window.localStorage, locale);
    const blob = new Blob([serializePortableSettings(bundle)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `piora-settings-${bundle.exportedAt.slice(0, 10)}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setErrorCode(null);
    setAnnouncement(bundle.excluded.includes("customBackgroundImage")
      ? t("settings.portability.exportedWithoutCustomBackground")
      : t("settings.portability.exported"));
  };

  const previewImport = async (file: File | undefined) => {
    if (!file) return;
    setAnnouncement("");
    setErrorCode(null);
    setPreview(null);
    try {
      if (file.size > PORTABLE_SETTINGS_MAX_BYTES) throw new SettingsPortabilityError("oversized");
      const bundle = parsePortableSettings(await file.text());
      const current = readPortableSettingsPreferences(window.localStorage, locale).preferences;
      setPreview({ fileName: file.name, bundle, diff: getPortableSettingsDiff(current, bundle.preferences) });
    } catch (error) {
      setErrorCode(error instanceof SettingsPortabilityError ? error.code : "malformed");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const applyImport = () => {
    if (!preview) return;
    try {
      applyPortableSettings(window.localStorage, preview.bundle);
      window.sessionStorage.setItem(SETTINGS_REOPEN_STORAGE_KEY, "general");
      setAnnouncement(t("settings.portability.applying"));
      window.location.reload();
    } catch {
      setErrorCode("storage");
    }
  };

  return (
    <section className={styles.card} aria-labelledby="settings-portability-title">
      <div className={styles.header}>
        <div>
          <h3 id="settings-portability-title">{t("settings.portability.title")}</h3>
          <p>{t("settings.portability.description")}</p>
        </div>
        <AliIcon name="export" size={18} />
      </div>

      <div className={styles.actions}>
        <button type="button" className={styles.secondaryButton} onClick={exportSettings}>
          <AliIcon name="download" size={14} />
          {t("settings.portability.export")}
        </button>
        <button type="button" className={styles.secondaryButton} onClick={() => fileInputRef.current?.click()}>
          <AliIcon name="import" size={14} />
          {t("settings.portability.import")}
        </button>
        <input
          ref={fileInputRef}
          className={styles.fileInput}
          type="file"
          accept=".json,application/json"
          aria-label={t("settings.portability.chooseFile")}
          onChange={(event) => void previewImport(event.target.files?.[0])}
        />
      </div>

      <div className={styles.securityNote}>
        <AliIcon name="lock" size={13} />
        <span>{t("settings.portability.security")}</span>
      </div>

      {announcement ? <div className={styles.status} role="status" aria-live="polite">{announcement}</div> : null}
      {errorCode ? <div className={styles.error} role="alert">{t(`settings.portability.error.${errorCode}`)}</div> : null}

      {preview ? (
        <div className={styles.preview} aria-labelledby="settings-import-preview-title">
          <div className={styles.previewHeader}>
            <div>
              <h4 id="settings-import-preview-title">{t("settings.portability.previewTitle")}</h4>
              <p>{preview.fileName} · {t("settings.portability.changeCount", { count: preview.diff.length })}</p>
            </div>
            <button type="button" className={styles.iconButton} onClick={() => setPreview(null)} aria-label={t("i18n.close")}>
              <AliIcon name="close" size={13} />
            </button>
          </div>

          {preview.diff.length > 0 ? (
            <div className={styles.tableWrap}>
              <table>
                <thead><tr><th>{t("settings.portability.setting")}</th><th>{t("settings.portability.current")}</th><th>{t("settings.portability.incoming")}</th></tr></thead>
                <tbody>{preview.diff.map((item) => (
                  <tr key={item.key}>
                    <th scope="row">{t(`settings.portability.field.${item.key}`)}</th>
                    <td>{formatValue(item.key, item.before, t)}</td>
                    <td>{formatValue(item.key, item.after, t)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : <div className={styles.noChanges} role="status">{t("settings.portability.noChanges")}</div>}

          {preview.bundle.excluded.includes("customBackgroundImage") ? <div className={styles.excludedNote}>{t("settings.portability.customBackgroundExcluded")}</div> : null}
          <div className={styles.previewActions}>
            <button type="button" className={styles.secondaryButton} onClick={() => setPreview(null)}>{t("i18n.cancel")}</button>
            <button type="button" className={styles.primaryButton} onClick={applyImport} disabled={preview.diff.length === 0}>{t("settings.portability.apply")}</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function formatValue(
  key: PortableSettingKey,
  value: PortableSettingsDiff["before"] | PortableSettingsDiff["after"],
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (value === undefined) return t("settings.portability.notIncluded");
  if (typeof value === "boolean") return t(value ? "settings.portability.enabled" : "settings.portability.disabled");
  if (typeof value === "string") return value;
  if (key === "font" && "family" in value) return `${value.family} · ${value.size}px · ${t(`appearance.font.weight.${value.weight}`)}`;
  if (key === "background" && "source" in value) return value.source === "builtin"
    ? `${value.presetId} · ${value.overlay}% · ${value.blur}px`
    : t("settings.portability.backgroundNone");
  return JSON.stringify(value);
}
