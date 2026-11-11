"use client";
import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { DesktopUpdateState } from "./sidebar/sidebar-types";
import styles from "./SettingsDialog.module.css";
import updateStyles from "./DesktopUpdateSettings.module.css";

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
  const unavailable = !state || state.status === "unsupported";
  const disabled = unavailable || busy || state?.status === "checking" || state?.status === "downloading";
  async function check() {
    if (disabled) return;
    setBusy(true); setFailed(false);
    try {
      const checked = await window.piDesktop?.checkForUpdates?.();
      if (!checked) throw new Error("Unavailable");
      setState(checked);
    } catch { setFailed(true); }
    finally { setBusy(false); }
  }
  return <div data-settings-id="general.updateSource" className={updateStyles.setting}>
    <div className={updateStyles.field}>
      <div className={updateStyles.copy}>
        <div className={styles.rowTitle}>{t("settings.updateSource")}</div>
        <p id="desktop-update-source-description" className={updateStyles.description}>{t("settings.updateSourceDescription")}</p>
      </div>
      <span className={updateStyles.note}>{t("settings.updateSourceGithub")}</span>
    </div>
    {!unavailable && <div className={updateStyles.field}>
      <span className={`${updateStyles.note} ${updateStyles.versions}`}>{t("settings.updateSourceVersions", { current: state.currentVersion, latest: state.latestVersion ?? state.availableVersion ?? "—" })}</span>
      <button type="button" className="ui-button" disabled={disabled} onClick={() => void check()}>{t("settings.updateSourceCheck")}</button>
    </div>}
    {state?.status === "up-to-date" && <p role="status" className={updateStyles.note}>{t("settings.updateSourceNoUpgrade")}</p>}
    {state?.status === "error" && <div role="alert" className={`ui-error ${updateStyles.status}`}>
      <p>{t("settings.updateSourceFailed", { source: t("settings.updateSourceGithub") })} {state.error}</p>
      <button type="button" className="ui-button" disabled={disabled} onClick={() => void check()}>{t("common.retry")}</button>
    </div>}
    {failed && <p role="alert" className={`ui-error ${updateStyles.status}`}>{t("settings.updateSourceSaveError")}</p>}
    {state?.status === "unsupported" && <p id="desktop-update-source-unavailable" role="note" className={updateStyles.note}>{t(state.unsupportedReason === "non-stable" ? "settings.updateNonStableUnsupported" : "settings.updateScheduleUnsupported")}</p>}
  </div>;
}
