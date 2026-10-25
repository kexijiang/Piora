"use client";
import type { ToolReviewRecord } from "@/lib/tool-review-types";
import { useI18n } from "@/hooks/useI18n";

export function ToolReviewStatus({ reviews }: { reviews: ToolReviewRecord[] }) {
  const { t } = useI18n();
  if (!reviews.length) return null;
  const latest = reviews[reviews.length - 1];
  return <details data-tool-reviews style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)", padding: "6px 10px", borderTop: "1px solid var(--border)" }}>
    <summary style={{ cursor: "pointer" }}><span role="status">{t("permission.reviewHistory")} · {latest.toolName} · {t(`permission.reviewStatus.${latest.status}`)}</span></summary>
    <div style={{ maxHeight: 200, overflowY: "auto", paddingTop: 6 }}>
      {[...reviews].reverse().map(review => <div key={review.id} data-review-status={review.status} style={{ padding: "6px 0", borderBottom: "1px solid var(--border)", overflowWrap: "anywhere" }}>
        <strong>{review.toolName} · {t(`permission.reviewStatus.${review.status}`)}</strong>
        <p style={{ margin: "4px 0", whiteSpace: "pre-wrap" }}>{review.reason}</p>
        {review.model && <small>{review.model}{review.durationMs !== undefined && ` · ${(review.durationMs / 1000).toFixed(1)}s`}{review.tokens !== undefined && ` · ${review.tokens} tokens`}{review.cost !== undefined && ` · $${review.cost.toFixed(4)}`}</small>}
      </div>)}
    </div>
  </details>;
}
