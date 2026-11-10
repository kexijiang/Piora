"use client";

import { useState } from "react";
import { mapDraftValues, migrationControls, type MigrationControl } from "../../lib/intelligent-ui/draft-migration";
import type { DraftMigrationReview, SurfaceState } from "./client-state";
import styles from "./IntelligentUiSurface.module.css";

const messages = {
  en: { title: "Review fields before migrating", notice: "Choose which old values to copy. Check meaning and units yourself; values are copied without conversion. Unselected fields keep the latest saved values. The original draft stays on this device.", target: "New field", source: "Old field to copy", keep: "Keep saved value", value: "After migration", confirm: "Confirm mapping and save", cancel: "Cancel", invalid: "One or more values do not fit the new field's type, range or options.", failed: "Migration did not finish. Both drafts are retained. Reload the latest version and review again.", number: "Number", slider: "Number", select: "Choice", checkbox: "Yes/no", step: "Adjustment step", saving: "Saving…" },
  zh: { title: "核对字段后迁移", notice: "选择要复制的旧值，请核对字段含义和单位；复制时不会自动换算。未选择的字段保留最新已保存值，原稿会继续保存在本机。", target: "新字段", source: "使用哪个旧字段", keep: "保留已保存值", value: "迁移后的值", confirm: "确认字段对应并保存", cancel: "取消", invalid: "部分值不符合新字段的类型、范围或选项，请重新选择。", failed: "迁移未完成，两份草稿已保留。请加载最新版本后重新核对。", number: "数字", slider: "数字", select: "选项", checkbox: "是否", step: "调节步长", saving: "正在保存…" },
};
export function DraftMigration({ review, store, english }: { review: DraftMigrationReview; store: SurfaceState; english: boolean }) {
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  const copy = messages[english ? "en" : "zh"];
  const source = migrationControls(review.source.surface), target = migrationControls(review.target.surface);
  const describe = (node: MigrationControl) => `${node.label} · ${copy[node.type]}${node.type === "select" ? ` (${node.options.join(" / ")})` : node.type === "checkbox" ? "" : ` (${node.min ?? "−∞"} … ${node.max ?? "∞"}${node.step ? `; ${copy.step} ${node.step}` : ""})`}`;
  let result = review.target.state, valid = true;
  try { result = mapDraftValues(review.source.surface, review.source.state, review.target.surface, review.target.state, mapping); } catch { valid = false; }
  return <section className={styles.migration} aria-label={copy.title}>
    <h4>{copy.title}</h4><p>{copy.notice}</p>
    <div className={styles.tableScroll}><table><thead><tr><th scope="col">{copy.target}</th><th scope="col">{copy.source}</th><th scope="col">{copy.value}</th></tr></thead><tbody>{target.map(node => <tr key={node.id}>
      <th scope="row">{describe(node)}<br />{copy.keep}: {String(review.target.state[node.id])}</th>
      <td><select aria-label={`${copy.source}: ${node.label}`} disabled={busy} value={mapping[node.id] ?? ""} onChange={event => {
        const next = { ...mapping }; if (event.currentTarget.value) next[node.id] = event.currentTarget.value; else delete next[node.id]; setMapping(next); setFailed(false);
      }}><option value="">{copy.keep}</option>{source.map(old => <option key={old.id} value={old.id}>{describe(old)} = {String(review.source.state[old.id])}</option>)}</select></td>
      <td>{valid ? String(result[node.id]) : "—"}</td>
    </tr>)}</tbody></table></div>
    {!valid ? <p role="alert">{copy.invalid}</p> : null}{failed ? <p role="alert">{copy.failed}</p> : null}
    <div className={styles.actions}><button type="button" disabled={busy || !valid || !Object.keys(mapping).length} onClick={() => {
      setBusy(true); setFailed(false); void store.migrateDraft(review.id, mapping).catch(() => setFailed(true)).finally(() => setBusy(false));
    }}>{busy ? copy.saving : copy.confirm}</button><button type="button" disabled={busy} onClick={store.cancelMigration}>{copy.cancel}</button></div>
  </section>;
}
