"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import styles from "./SettingsDialog.module.css";
import updateStyles from "./DesktopUpdateSettings.module.css";
import type { DesktopUpdateState } from "./sidebar/sidebar-types";

export function DesktopUpdateScheduleSetting() {
  const { t } = useI18n();
  const [state, setState] = useState<{ enabled: boolean; time: string; supported: boolean; unsupportedReason?: DesktopUpdateState["unsupportedReason"] } | null>(null);
  const [time, setTime] = useState("03:00");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let disposed = false;
    void window.piDesktop?.getUpdateSchedule?.().then((value) => {
      if (!disposed && value) { setState(value); setTime(value.time); }
    }).catch(() => { if (!disposed) setError(true); });
    return () => { disposed = true; };
  }, []);

  async function save(enabled: boolean, nextTime = time) {
    if (!state?.supported || saving || !/^([01]\d|2[0-3]):[0-5]\d$/.test(nextTime)) return;
    setSaving(true); setError(false);
    try {
      const value = await window.piDesktop?.setUpdateSchedule?.({ enabled, time: nextTime });
      if (!value) throw new Error("Unavailable");
      setState(value); setTime(value.time);
    } catch { setError(true); }
    finally { setSaving(false); }
  }

  return <div data-settings-id="general.updateSchedule" className={updateStyles.setting}>
    <div className={updateStyles.field}>
      <div className={updateStyles.copy}>
        <div className={styles.rowTitle}>{t("settings.updateSchedule")}</div>
        <p id="desktop-update-schedule-description" className={updateStyles.description}>{t("settings.updateScheduleDescription")}</p>
      </div>
      <button type="button" className={styles.switch} role="switch" aria-label={t("settings.updateSchedule")} aria-checked={state?.enabled ?? false}
        aria-describedby={`desktop-update-schedule-description${state && !state.supported ? " desktop-update-schedule-unavailable" : ""}`}
        disabled={!state?.supported || saving} onClick={() => void save(!state?.enabled, state?.time)}><span /></button>
    </div>
    {state && !state.supported && <p id="desktop-update-schedule-unavailable" role="note" className={updateStyles.note}>{t(state.unsupportedReason === "non-stable" ? "settings.updateNonStableUnsupported" : "settings.updateScheduleUnsupported")}</p>}
    {state?.supported && <div className={updateStyles.field}>
      <label htmlFor="desktop-update-time" className={styles.rowTitle}>{t("settings.updateScheduleTime")}</label>
      <div className="ui-inline-actions">
        <input id="desktop-update-time" className="ui-input" type="time" value={time} disabled={saving}
          onChange={(event) => setTime(event.target.value)} />
        <button className="ui-button" type="button" disabled={saving || time === state.time || !time} onClick={() => void save(state.enabled)}>{t("i18n.save")}</button>
      </div>
    </div>}
    {error && <p className={`ui-error ${updateStyles.status}`} role="alert">{t("settings.updateScheduleError")}</p>}
  </div>;
}
