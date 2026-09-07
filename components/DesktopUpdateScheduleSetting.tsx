"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import styles from "./SettingsDialog.module.css";

export function DesktopUpdateScheduleSetting() {
  const { t } = useI18n();
  const [state, setState] = useState<{ enabled: boolean; time: string; supported: boolean } | null>(null);
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

  return <div data-settings-id="general.updateSchedule">
    <div className={styles.conversationRow}>
      <div className={styles.conversationCopy}>
        <div className={styles.rowTitle}>{t("settings.updateSchedule")}</div>
        <div className={styles.rowDescription}>{t(state && !state.supported ? "settings.updateScheduleUnsupported" : "settings.updateScheduleDescription")}</div>
      </div>
      <button type="button" className={styles.switch} role="switch" aria-label={t("settings.updateSchedule")} aria-checked={state?.enabled ?? false}
        disabled={!state?.supported || saving} onClick={() => void save(!state?.enabled, state?.time)}><span /></button>
    </div>
    {state?.supported && <div className={styles.conversationRow}>
      <label htmlFor="desktop-update-time" className={styles.rowTitle}>{t("settings.updateScheduleTime")}</label>
      <div className="ui-inline-actions">
        <input id="desktop-update-time" className="ui-input" type="time" value={time} disabled={saving}
          onChange={(event) => setTime(event.target.value)} />
        <button className="ui-button" type="button" disabled={saving || time === state.time || !time} onClick={() => void save(state.enabled)}>{t("i18n.save")}</button>
      </div>
    </div>}
    {error && <p className="ui-error" role="alert">{t("settings.updateScheduleError")}</p>}
  </div>;
}
