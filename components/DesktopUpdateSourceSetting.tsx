"use client";
import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { DesktopUpdateState } from "./sidebar/sidebar-types";
import styles from "./SettingsDialog.module.css";

export function DesktopUpdateSourceSetting() {
  const { t } = useI18n();
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    let revision = 0;
    const off = window.piDesktop?.onUpdateState?.(value => { revision++; if (!disposed) setState(value); });
    void window.piDesktop?.getUpdateState?.().then(value => { if (!disposed && !revision && value) setState(value); }).catch(() => { if (!disposed) setFailed(true); });
    return () => { disposed = true; off?.(); };
  }, []);
  const source = state?.source ?? "github";
  const unavailable = !state || state.status === "unsupported";
  const disabled = unavailable || busy || state?.status === "checking" || state?.status === "downloading";
  async function act(next?: "github" | "internal", check = false) {
    if (disabled) return;
    setBusy(true); setFailed(false);
    try {
      if (next) {
        const saved = await window.piDesktop?.setUpdateSource?.(next);
        if (!saved) throw new Error("Unavailable");
        setState(saved);
      }
      if (check) {
        const checked = await window.piDesktop?.checkForUpdates?.();
        if (!checked) throw new Error("Unavailable");
        setState(checked);
      }
    } catch { setFailed(true); }
    finally { setBusy(false); }
  }
  return <div data-settings-id="general.updateSource">
    <div className={styles.conversationRow}>
      <div className={styles.conversationCopy}>
        <label htmlFor="desktop-update-source" className={styles.rowTitle}>{t("settings.updateSource")}</label>
        <div className={styles.rowDescription}>{t("settings.updateSourceDescription")}</div>
      </div>
      <select id="desktop-update-source" className="ui-input" value={source} disabled={disabled}
        onChange={event => { const value = event.target.value; if (value === "github" || value === "internal") void act(value); }}>
        <option value="github">{t("settings.updateSourceGithub")}</option>
        <option value="internal">{t("settings.updateSourceInternal")}</option>
      </select>
    </div>
    {!unavailable && <div className={styles.conversationRow}>
      <span>{t("settings.updateSourceVersions", { current: state.currentVersion, latest: state.latestVersion ?? state.availableVersion ?? "—" })}</span>
      <button type="button" className="ui-button" disabled={disabled} onClick={() => void act(undefined, true)}>{t("settings.updateSourceCheck")}</button>
    </div>}
    {state?.status === "up-to-date" && <p role="status">{t("settings.updateSourceNoUpgrade")}</p>}
    {state?.status === "error" && <div role="alert" className="ui-error">
      <p>{t("settings.updateSourceFailed", { source: t(source === "github" ? "settings.updateSourceGithub" : "settings.updateSourceInternal") })} {state.error}</p>
      <button type="button" className="ui-button" disabled={disabled} onClick={() => void act(source === "github" ? "internal" : "github", true)}>{t("settings.updateSourceSwitchRetry")}</button>
    </div>}
    {failed && <p role="alert" className="ui-error">{t("settings.updateSourceSaveError")}</p>}
    {state?.status === "unsupported" && <p>{t("settings.updateScheduleUnsupported")}</p>}
  </div>;
}
