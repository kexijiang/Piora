"use client";

import { useMemo } from "react";
import { useI18n } from "../../hooks/useI18n";
import { initialState, validateSurface } from "../../lib/intelligent-ui/surface-document";
import type { AnswerOutputPreview } from "../../lib/answer-output-preview";
import { SurfaceContents } from "./SurfaceContents";
import styles from "./IntelligentUiSurface.module.css";

/** Display-only: never imports the saved-parameter store or registers a writer. */
export default function IntelligentUiPreview({ preview }: { preview: AnswerOutputPreview }) {
  const { locale } = useI18n();
  const english = locale === "en";
  const surface = useMemo(() => {
    try { return preview.phase === "partial" || preview.phase === "complete" ? validateSurface(preview.payload) : null; }
    catch { return null; }
  }, [preview.payload, preview.phase]);
  const status = preview.phase === "complete"
    ? english ? "Preview complete · not published or saved" : "预览已生成 · 尚未发布或保存"
    : english ? "Generating preview · content may change, not saved" : "正在生成预览 · 内容可能调整，尚未保存";
  return <section className={styles.surface} data-answer-output-preview aria-label={surface?.title ?? (english ? "Generating preview" : "正在生成预览")} aria-busy={preview.phase !== "complete"}>
    {surface ? <><header className={styles.header}><h3>{surface.title}</h3><span className={styles.badge}>Intelligent UI</span></header>
      <SurfaceContents surface={surface} state={initialState(surface)} disabled change={() => {}} locale={english ? "en" : "zh-CN"}
        copy={{ calculation: english ? "Cannot calculate with these values" : "当前参数无法计算", chart: english ? "Bar chart" : "条形图" }} /></>
      : <p>{preview.phase === "preparing" ? (english ? "Preparing preview…" : "正在准备预览…") : (english ? "Preview unavailable" : "预览暂不可用")}</p>}
    <footer className={styles.footer}><span role="status" aria-live="polite">{status}</span></footer>
  </section>;
}
