"use client";

import { useBrowserMode } from "@/hooks/useBrowserMode";
import { useI18n } from "@/hooks/useI18n";
import styles from "./SettingsDialog.module.css";

export function BrowserModeSetting() {
  const { t } = useI18n();
  const { mode, error, saving, changeMode } = useBrowserMode();
  return <section className={styles.conversationSection} data-settings-id="general.browser">
    <div className={styles.conversationRow}>
      <div className={styles.conversationCopy}>
        <div className={styles.rowTitle}>{t("browser.useBackground")}</div>
        <div id="background-browser-description" className={styles.rowDescription}>{t("settings.backgroundBrowserDescription")}</div>
        {error ? <div className={styles.agentDataError} role="alert">{error}</div> : null}
      </div>
      <button className={styles.switch} type="button" role="switch"
        aria-label={t("browser.useBackground")} aria-describedby="background-browser-description"
        aria-checked={mode === "background"} disabled={mode === null || saving}
        onClick={() => { void changeMode(mode === "background" ? "builtin" : "background"); }}
      ><span /></button>
    </div>
  </section>;
}
