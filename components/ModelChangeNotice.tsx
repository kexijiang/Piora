"use client";

import { useI18n } from "@/hooks/useI18n";
import type { ModelChangeNotice as Notice } from "@/lib/model-change-notices";

export function ModelChangeNotice({ notice, modelNames }: { notice: Notice; modelNames?: Record<string, string> }) {
  const { t } = useI18n();
  const name = (model: Notice["from"]) => modelNames?.[`${model.provider}:${model.modelId}`] ?? model.modelId;
  let from = name(notice.from), to = name(notice.to);
  if (from === to && notice.from.provider !== notice.to.provider) {
    from = `${from} (${notice.from.provider})`;
    to = `${to} (${notice.to.provider})`;
  }
  return <div data-model-change={notice.id} style={{ display: "flex", alignItems: "center", gap: 10, margin: "18px 0 22px", color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>
    <span aria-hidden="true" style={{ flex: 1, minWidth: 12, height: 1, background: "var(--border)" }} />
    <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 5, minWidth: 0, maxWidth: "85%" }}>
      <span style={{ overflowWrap: "anywhere", textAlign: "center" }}>{t("chat.modelChanged", { from, to })}</span>
      <button type="button" title={t("chat.modelChangedHint")} aria-label={t("chat.modelChangedInfo")}
        style={{ display: "inline-flex", flexShrink: 0, alignItems: "center", justifyContent: "center", width: 24, height: 24, border: 0, padding: 3, background: "transparent", color: "inherit", cursor: "help" }}>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7v1" /></svg>
      </button>
    </span>
    <span aria-hidden="true" style={{ flex: 1, minWidth: 12, height: 1, background: "var(--border)" }} />
  </div>;
}
