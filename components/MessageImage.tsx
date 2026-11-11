"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "@/hooks/useI18n";
import { copyImage } from "@/lib/clipboard";
import { AliIcon } from "./AliIcon";

export function MessageImage({ src, index, onOpen, className = "" }: { src: string; index: number; onOpen: () => void; className?: string }) {
  const { t } = useI18n();
  const label = t("chat.openImage", { count: String(index + 1) });

  return (
    <button type="button" className={`message-image-thumbnail ${className}`.trim()} onClick={onOpen} title={label} aria-label={label}>
      {/* Session images can be base64 data URLs or provider URLs. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" />
    </button>
  );
}

export function MessageImageViewer({ src, index, onClose }: { src: string; index: number; onClose: () => void }) {
  const { t, locale } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const copying = useRef(false);
  const [copyState, setCopyState] = useState<"idle" | "pending" | "copied" | "error">("idle");
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<number | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [area, setArea] = useState({ width: 1, height: 1 });
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const fit = Math.min(1, area.width / (natural.width || 1), area.height / (natural.height || 1));
  const scale = zoom ?? fit;
  const zh = locale === "zh-CN";
  const reset = (value: number | null) => { setZoom(value); setOffset({ x: 0, y: 0 }); };
  const copy = async () => {
    if (!image.current || copying.current) return;
    copying.current = true;
    setCopyState("pending");
    try { await copyImage(image.current); setCopyState("copied"); }
    catch { setCopyState("error"); }
    finally { copying.current = false; }
  };
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    const observer = new ResizeObserver(() => {
      if (viewport.current) setArea({ width: viewport.current.clientWidth, height: viewport.current.clientHeight });
    });
    if (viewport.current) observer.observe(viewport.current);
    return () => { observer.disconnect(); document.body.style.overflow = previousOverflow; if (dialog.open) dialog.close(); previousFocus?.focus(); };
  }, []);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      setZoom(Math.max(0.05, Math.min(16, scale * Math.exp(-event.deltaY * 0.002))));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [scale]);
  return typeof document === "undefined" ? null : createPortal(
    <dialog ref={dialogRef} className="message-image-dialog" aria-label={t("chat.imageViewer")}
      onKeyDown={event => {
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "c") {
          event.preventDefault(); event.stopPropagation(); void copy();
        }
      }}
      onCancel={event => { event.preventDefault(); onClose(); }}
      onClick={event => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
      }}>
      <div className="message-image-dialog-layout">
        <div className="message-image-dialog-toolbar">
          <span>{t("chat.imageNumber", { count: String(index + 1) })}</span>
          <button type="button" onClick={() => reset(null)}>{zh ? "适应窗口" : "Fit"}</button>
          <button type="button" onClick={() => reset(1)}>1:1</button>
          <button type="button" onClick={() => reset(null)}>{zh ? "还原" : "Reset"}</button>
          <output>{Math.round(scale * 100)}%</output>
          <button type="button" onClick={() => void copy()} disabled={copyState === "pending" || !natural.width}
            title={`${t("chat.copyImage")} · ${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘C" : "Ctrl+C"}`}>
            <AliIcon name="copy" size={14} />{t("chat.copyImage")}
          </button>
          <button type="button" onClick={onClose} aria-label={t("i18n.close")}><AliIcon name="close" size={15} /></button>
        </div>
        <div ref={viewport} className="message-image-dialog-viewport" tabIndex={0}
          onKeyDown={event => { if (event.key === "0") reset(null); if (event.key === "+" || event.key === "=") setZoom(Math.min(16, scale * 1.2)); if (event.key === "-") setZoom(Math.max(0.05, scale / 1.2)); }}
          onPointerDown={event => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, left: offset.x, top: offset.y }; }}
          onPointerMove={event => { const start = drag.current; if (start) setOffset({ x: start.left + event.clientX - start.x, y: start.top + event.clientY - start.y }); }}
          onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img ref={image} src={src} alt="" draggable={false} style={{ width: natural.width * scale || undefined, height: natural.height * scale || undefined, transform: `translate(${offset.x}px, ${offset.y}px)` }}
            onLoad={event => {
              const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
              setNatural({ width, height }); reset(null);
              const dialog = dialogRef.current;
              if (dialog) {
                dialog.style.width = `${Math.max(320, Math.min(innerWidth * 0.9, width + 24))}px`;
                const toolbarHeight = dialog.querySelector(".message-image-dialog-toolbar")?.getBoundingClientRect().height ?? 42;
                dialog.style.height = `${Math.max(180, Math.min(innerHeight * 0.85, height + toolbarHeight + 24))}px`;
              }
            }} />
          <div className={`message-image-copy-status${copyState === "error" ? " is-error" : ""}`} role="status" aria-live="polite">
            {copyState === "copied" ? t("i18n.copied") : copyState === "error" ? t("chat.copyImageFailed") : ""}
          </div>
        </div>
      </div>
    </dialog>, document.body);
}
