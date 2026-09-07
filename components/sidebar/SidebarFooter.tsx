"use client";

import { useI18n } from "@/hooks/useI18n";
import type { SessionInfo } from "@/lib/types";

export function SidebarFooter({ deletedToast, archivedToast, onUndoDelete, onUndoArchive }: {
  deletedToast: { session: SessionInfo; key: number } | null;
  archivedToast: SessionInfo | null;
  onUndoDelete: () => Promise<void>;
  onUndoArchive: () => void;
}) {
  const { t } = useI18n();
  return <>
    {deletedToast && <div role="status" style={{ position: "absolute", bottom: 12, left: "50%", transform: "translateX(-50%)", display: "flex", alignItems: "center", gap: 10, zIndex: 60, maxWidth: "calc(100% - 24px)", padding: "8px 10px 8px 14px", borderRadius: "var(--radius-control)", border: "1px solid var(--border)", background: "var(--bg)", boxShadow: "var(--shadow-popover)", color: "var(--text)", fontSize: "var(--text-sm)", animation: "notice-shelf-in 0.18s ease-out both" }}>
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {t("sidebar.deletedToast", { title: (deletedToast.session.name || deletedToast.session.firstMessage || deletedToast.session.id).slice(0, 30) })}
      </span>
      <button type="button" onClick={() => void onUndoDelete()} style={{ flexShrink: 0, padding: "4px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-hover)", color: "var(--accent)", cursor: "pointer", fontSize: "var(--text-sm)", fontWeight: 600, whiteSpace: "nowrap" }}>{t("sidebar.undo")}</button>
    </div>}
    {archivedToast && <div role="status" style={{ position: "fixed", left: 14, bottom: 14, zIndex: 10000, display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", boxShadow: "var(--shadow-popover)", color: "var(--text)", fontSize: "var(--text-sm)" }}>
      <span>{t("sidebar.taskArchived")}</span>
      <button type="button" onClick={onUndoArchive} style={{ border: 0, background: "transparent", color: "var(--accent)", cursor: "pointer", fontWeight: 600 }}>{t("sidebar.undo")}</button>
    </div>}
  </>;
}
