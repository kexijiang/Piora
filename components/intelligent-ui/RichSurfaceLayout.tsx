"use client";

import { useId, useMemo, type CSSProperties, type ReactNode } from "react";
import { evaluateExpression, type UiNode, type UiState } from "../../lib/intelligent-ui/surface-document";
import { evaluateRichSurface, validateRichSurface, type UiRichSurface } from "../../lib/intelligent-ui/rich-protocol";
import styles from "./RichSurfaceLayout.module.css";

const messages = {
  en: { unavailable: "This layout cannot be displayed.", calculation: "Cannot calculate with these values", empty: "No rows match the current filters.", count: (visible: number, total: number) => `${visible} of ${total} rows`, uncertain: (count: number) => `${count} rows could not be checked against the filters and remain visible.` },
  "zh-CN": { unavailable: "暂时无法显示此布局。", calculation: "当前参数无法计算", empty: "没有符合当前筛选条件的记录。", count: (visible: number, total: number) => `显示 ${visible} 条，共 ${total} 条`, uncertain: (count: number) => `${count} 条记录暂时无法判断是否符合筛选条件，仍保留显示。` },
};

/** Layout has no persistence or action authority. The owner supplies the same
 * controlled node renderer used by ordinary answers, including disabled state. */
export function RichSurfaceLayout({ surface, state, renderNode, locale = "en" }: {
  surface: UiRichSurface;
  state: UiState;
  renderNode: (node: UiNode) => ReactNode;
  locale?: "en" | "zh-CN";
}) {
  const prefix = useId(), copy = messages[locale];
  const content = useMemo(() => {
    try {
      const checked = validateRichSurface(surface);
      return { surface: checked, evaluation: evaluateRichSurface(checked, state) };
    } catch { return undefined; }
  }, [surface, state]);
  if (!content) return <p role="alert">{copy.unavailable}</p>;
  const nodes = new Map(content.surface.nodes.map(node => [node.id, node]));
  const nodeViews = (ids: string[]) => ids.map(id => <div key={id} className={styles.node}>{renderNode(nodes.get(id)!)}</div>);
  const display = (expression: Parameters<typeof evaluateExpression>[0]) => {
    try { return String(evaluateExpression(expression, state)); } catch { return copy.calculation; }
  };
  return <div className={styles.layout}>{content.surface.layout.map(block => {
    const titleId = `${prefix}-${block.id}`;
    if (block.type === "group") return <section key={block.id} className={styles.group} aria-labelledby={titleId}>
      <h4 id={titleId}>{block.title}</h4>
      <div className={styles.groupGrid} style={{ "--ui-columns": block.columns } as CSSProperties}>{nodeViews(block.nodeIds)}</div>
    </section>;
    if (block.type === "comparison") return <section key={block.id} className={styles.group} aria-labelledby={titleId}>
      <h4 id={titleId}>{block.title}</h4>
      <div className={styles.cards}>{block.cards.map(card => <article key={card.id} className={styles.card} aria-labelledby={`${prefix}-${card.id}`}>
        <h5 id={`${prefix}-${card.id}`}>{card.title}</h5>{nodeViews(card.nodeIds)}
      </article>)}</div>
    </section>;
    const table = nodes.get(block.tableId) as Extract<UiNode, { type: "table" }>;
    const filtered = content.evaluation.tableViews[block.id];
    return <section key={block.id} className={styles.group} aria-labelledby={titleId}>
      <h4 id={titleId}>{block.title}</h4>
      <p className={styles.count} role="status" aria-live="polite">{copy.count(filtered.visibleRowIndices.length, filtered.totalRows)}</p>
      {filtered.unknownRowIndices.length > 0 && <p className={styles.notice} role="status">{copy.uncertain(filtered.unknownRowIndices.length)}</p>}
      <div className={styles.tableScroll} tabIndex={0} role="region" aria-labelledby={titleId}><table>
        <thead><tr>{table.columns.map((column, index) => <th key={index} scope="col">{column}</th>)}</tr></thead>
        <tbody>{filtered.visibleRowIndices.map(index => <tr key={index}>{table.rows[index].map((cell, column) => <td key={column}>{display(cell)}</td>)}</tr>)}</tbody>
      </table></div>
      {filtered.visibleRowIndices.length === 0 && <p className={styles.notice}>{copy.empty}</p>}
    </section>;
  })}</div>;
}
