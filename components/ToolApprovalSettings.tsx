"use client";

import { useToolApprovalSettings } from "@/hooks/useToolApprovalSettings";
import { useI18n } from "@/hooks/useI18n";
import { ModelErrorText } from "./ModelErrorText";

export function ToolApprovalSettings() {
  const { t } = useI18n();
  const { enabled, ready, saving, error, setEnabled } = useToolApprovalSettings();
  const busy = !ready || saving;
  const toggle = () => setEnabled(!enabled);
  return <div data-settings-id="permission.settings" style={{ padding: "12px 18px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
    <label style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--text)", fontSize: "var(--text-sm)" }}>
      <input type="checkbox" role="switch" checked={enabled} disabled={busy} onChange={() => void toggle()} />
      <strong>{t("permission.settings.title")}</strong>
    </label>
    <p style={{ margin: "5px 0 0", color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>{t("permission.settings.description")}</p>
    {error ? <p role="alert" style={{ color: "var(--error, #dc2626)", margin: "5px 0 0" }}>{<ModelErrorText value={error} />}</p> : null}
  </div>;
}
