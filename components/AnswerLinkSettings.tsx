"use client";

import { useAnswerLinkPreference } from "@/hooks/useAnswerLinkPreference";
import { useI18n } from "@/hooks/useI18n";
import styles from "./SettingsDialog.module.css";

export function AnswerLinkSettings() {
  const { t } = useI18n();
  const { target, setTarget } = useAnswerLinkPreference();
  return <section className={styles.conversationSection} data-settings-id="conversation.answerLinks">
    <div className={styles.conversationRow}>
      <div className={styles.conversationCopy}>
        <div id="answer-link-target-label" className={styles.rowTitle}>{t("settings.answerLinks")}</div>
        <div id="answer-link-target-help" className={styles.rowDescription}>{t("settings.answerLinksHelp")}</div>
      </div>
      <div className={styles.sendModeTabs} role="group" aria-labelledby="answer-link-target-label" aria-describedby="answer-link-target-help">
        {(["builtin", "system"] as const).map(value => <button key={value} type="button" aria-pressed={target === value} onClick={() => setTarget(value)}>
          {t(value === "builtin" ? "settings.answerLinksBuiltin" : "settings.answerLinksSystem")}
        </button>)}
      </div>
    </div>
  </section>;
}
