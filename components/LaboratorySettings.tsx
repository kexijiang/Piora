"use client";

import { useI18n } from "@/hooks/useI18n";
import { useLaboratorySettings } from "@/hooks/useLaboratorySettings";
import styles from "./SettingsDialog.module.css";

export function LaboratorySettings() {
  const { t } = useI18n();
  const settings = useLaboratorySettings();
  return <>
    <div className={styles.contentHeading}>
      <h2>{t("laboratory.title")}</h2>
      <p>{t("laboratory.description")}</p>
    </div>
    <section className={styles.sectionCard} data-settings-id="laboratory.planGoal">
      <label className={styles.conversationRow}>
        <span className={styles.conversationCopy}>
          <strong className={styles.rowTitle}>{t("laboratory.planGoal")}</strong>
          <span className={styles.rowDescription}>{t("laboratory.planGoalDescription")}</span>
        </span>
        <input type="checkbox" role="switch" data-testid="laboratory-plan-goal-toggle" checked={settings.planGoalEnabled}
          disabled={settings.loading || settings.saving} onChange={event => { void settings.setPlanGoalEnabled(event.target.checked); }} />
      </label>
    </section>
    <p className={styles.localNote}>{t("laboratory.disableHelp")}</p>
    {settings.error && <div role="alert"><p>{t("laboratory.error")} {settings.error}</p><button type="button" className={styles.primaryButton} onClick={() => { void settings.refresh(); }}>{t("workflow.refresh")}</button></div>}
  </>;
}
