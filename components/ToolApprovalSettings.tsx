"use client";

import { useToolApprovalSettings } from "@/hooks/useToolApprovalSettings";
import { useI18n } from "@/hooks/useI18n";
import { ModelErrorText } from "./ModelErrorText";
import styles from "./SettingsDialog.module.css";

export function ToolApprovalSettings() {
  const { t } = useI18n();
  const { enabled, ready, saving, error, setEnabled } = useToolApprovalSettings();
  const busy = !ready || saving;
  const toggle = () => setEnabled(!enabled);
  return <section className={styles.conversationSection} data-settings-id="permission.settings">
    <div className={styles.conversationRow}>
      <div className={styles.conversationCopy}>
        <div className={styles.rowTitle}>{t("permission.settings.title")}</div>
        <div id="ToolApprovalSettings-description" className={styles.rowDescription}>{t("permission.settings.description")}</div>
        {error ? <p role="alert" style={{ color: "var(--error, #dc2626)", margin: "5px 0 0" }}><ModelErrorText value={error} /></p> : null}
      </div>
      <button type="button" role="switch" className={styles.switch}
        aria-label={t("permission.settings.title")} aria-describedby="ToolApprovalSettings-description"
        aria-checked={enabled} disabled={busy} onClick={() => void toggle()}>
        <span />
      </button>
    </div>
  </section>;
}
