"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../hooks/useI18n";
import { validateMiniAppPreview } from "../../lib/mini-app/preview";
import { MiniAppFrameHost } from "../../lib/mini-app/frame-host";
import type { AnswerOutputPreview } from "../../lib/answer-output-preview";
import styles from "./MiniAppSurface.module.css";

/** Layout only. No generated program, state writer or permission action is loaded. */
export default function MiniAppPreview({ preview }: { preview: AnswerOutputPreview }) {
  const { locale } = useI18n(), en = locale === "en";
  const container = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<unknown>();
  const compiled = useMemo(() => {
    try { return preview.payload ? validateMiniAppPreview(preview.payload) : undefined; }
    catch { return undefined; }
  }, [preview.payload]);
  useEffect(() => {
    if (!compiled || !container.current) return;
    const abort = new AbortController();
    void MiniAppFrameHost.create(container.current, { signal: abort.signal, onEvent() {}, onError() { if (!abort.signal.aborted) setFailed(compiled); } })
      .then(frame => {
        if (abort.signal.aborted) { frame.dispose(); return; }
        frame.setDocument({ document: compiled.document, inputs: compiled.initialInputs, viewports: compiled.plan.viewports, readOnly: true });
      }).catch(() => { if (!abort.signal.aborted) setFailed(compiled); });
    return () => abort.abort();
  }, [compiled]);
  return <section className={styles.surface} data-answer-output-preview aria-busy={preview.phase !== "complete"}>
    <header className={styles.header}><h3>{compiled?.plan.title ?? (en ? "Preparing interactive answer" : "正在准备交互内容")}</h3><span className={styles.badge}>Intelligent UI</span></header>
    <div ref={container} className={styles.document} />
    {(!compiled || failed === compiled) && <p className={styles.message}>{en ? "Preparing layout preview…" : "正在准备布局预览…"}</p>}
    <footer className={styles.footer} role="status">{en ? "Layout preview · not published or saved" : "布局预览 · 尚未发布或保存"}</footer>
  </section>;
}
