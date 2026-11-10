"use client";

import { useId } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useRunningStatusLabel } from "@/hooks/useRunningStatusLabel";
import { AliIcon } from "./AliIcon";
import shared from "./ModelRetrySettings.module.css";
import styles from "./RunningStatusSettings.module.css";

export function RunningStatusSettings() {
  const { t } = useI18n();
  const { label, setLabel } = useRunningStatusLabel();
  const id = useId();
  return <section className={shared.card} aria-labelledby={`${id}-title`}>
    <div className={shared.heading}>
      <span className={shared.icon}><AliIcon name="timer" size={17} /></span>
      <div>
        <h3 id={`${id}-title`}>{t("settings.runningStatusLabel")}</h3>
        <p id={`${id}-hint`}>{t("settings.runningStatusLabelHint")}</p>
      </div>
    </div>
    <div className={shared.fields}>
      <label className={styles.field}>
        <span>{t("settings.runningStatusText")}</span>
        <input className={styles.input} value={label} maxLength={80}
          aria-describedby={`${id}-hint`} placeholder={t("chat.taskDuration.running")}
          onChange={(event) => setLabel(event.target.value)} />
      </label>
    </div>
    <div className={styles.preview}>
      <span className={styles.caption}>{t("settings.runningStatusPreview")}</span>
      <div className={styles.status}>
        <span className={styles.dot} aria-hidden="true" />
        <span className={styles.label}>{label.trim() || t("chat.taskDuration.running")}</span>
        <span className={styles.elapsed}>· {t("chat.taskDuration.elapsed")} 25s</span>
      </div>
    </div>
  </section>;
}
