"use client";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ClipboardBridge, ClipboardItem } from "@/desktop/src/clipboard-types";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { ClipboardImage } from "./ClipboardPreview";
import { useClipboardI18n } from "./useClipboardI18n";
import styles from "./ClipboardWorkspace.module.css";

export function ClipboardImageViewer({ item, bridge, onClose, onCopy, busy, copied, error }: {
  item: ClipboardItem; bridge: ClipboardBridge; onClose: () => void; onCopy: () => void;
  busy: boolean; copied: boolean; error: string;
}) {
  const { tr } = useClipboardI18n();
  const [zoom, setZoom] = useState(0);
  const modal = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  useFocusTrap(modal, true, { initialFocus: canvas, onEscape: onClose });
  return createPortal(<div className={`${styles.workspace} ${styles.imageOverlay}`} onKeyDown={event => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || (event.target as HTMLElement).closest("button,select,input")) return;
    if (event.key === "Enter" || (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
      event.preventDefault(); if (!busy) onCopy();
    }
  }}>
    <div ref={modal} className={styles.imageViewer} role="dialog" aria-modal="true" aria-label={tr("图片大图预览")}>
      <header className={styles.imageViewerHeader}>
        <strong>{item.remark || item.title}</strong>
        <span>{item.image?.width} × {item.image?.height}</span>
        <button onClick={onClose} aria-label={tr("关闭大图预览")}>{tr("关闭")} <kbd>Esc</kbd></button>
      </header>
      <div className={styles.imageViewerTools}>
        <button aria-pressed={zoom === 0} onClick={() => setZoom(0)}>{tr("适应窗口")}</button>
        <button aria-pressed={zoom === 1} onClick={() => setZoom(1)}>100%</button>
        <select aria-label={tr("图片缩放")} value={zoom} onChange={event => setZoom(Number(event.target.value))}>
          <option value={0}>{tr("适应")}</option><option value={0.5}>50%</option><option value={1}>100%</option><option value={2}>200%</option><option value={4}>400%</option>
        </select>
        <span className={styles.spacer} />
        <span role="status">{copied ? tr("已复制") : ""}</span>
        <button className={styles.primary} disabled={busy} onClick={onCopy}>{tr("复制图片")} <kbd>↵</kbd></button>
      </div>
      <div ref={canvas} className={styles.imageViewerCanvas} tabIndex={0} aria-label={tr("图片预览区域")}>
        <div className={styles.imageCanvas} data-fit={zoom === 0} style={zoom ? { width: Math.max(1, (item.image?.width ?? 1) * zoom), height: Math.max(1, (item.image?.height ?? 1) * zoom) } : undefined}>
          <ClipboardImage bridge={bridge} id={item.id} title={item.title} />
        </div>
      </div>
      {error ? <div className={styles.error} role="alert">{tr(error)}</div> : null}
    </div>
  </div>, document.body);
}
