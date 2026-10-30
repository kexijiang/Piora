"use client";
import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { saveBetaFeatures, useBetaFeatures } from "@/hooks/useBetaFeatures";

export function BetaFeaturesSettings() {
  const { t } = useI18n();
  const { features, loading, error: loadError, refresh } = useBetaFeatures();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const toggle = async (retainPending = false) => {
    setSaving(true); setError(""); setSaved(false);
    try { await saveBetaFeatures({ ...features, intelligentUi: !features.intelligentUi }, retainPending); setSaved(true); }
    catch (reason) { setError(String(reason)); }
    finally { setSaving(false); }
  };
  return <section style={{ padding: 24, color: "var(--text)" }}>
    <h2>{t("beta.title")}</h2>
    <p style={{ color: "var(--text-muted)" }}>{t("beta.description")}</p>
    <div data-settings-id="beta.intelligentUi" style={{ padding: "18px 0", borderTop: "1px solid var(--border)" }}>
      <label style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <input type="checkbox" role="switch" checked={features.intelligentUi} disabled={loading || saving || !!loadError} onChange={() => void toggle()} />
        <strong>Intelligent UI</strong>
      </label>
      <p style={{ color: "var(--text-muted)" }}>{t("beta.intelligentUiDescription")}</p>
      <p style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>{t("beta.timing")}</p>
      {saved ? <p role="status">{t("beta.saved")}</p> : null}
      {error || loadError ? <div role="alert">{error || loadError} {loadError ? <button type="button" onClick={() => void refresh()}>{t("common.retry")}</button> : null}</div> : null}
      {error && features.intelligentUi ? <button type="button" disabled={saving} onClick={() => void toggle(true)}>{t("beta.disableKeepDraft")}</button> : null}
    </div>
  </section>;
}
