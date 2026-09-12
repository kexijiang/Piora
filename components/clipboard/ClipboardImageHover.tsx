"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ClipboardBridge, ClipboardItem } from "@/desktop/src/clipboard-types";
import { ClipboardImage } from "./ClipboardPreview";
import styles from "./ClipboardWorkspace.module.css";

function previewPosition(anchor: DOMRect, imageWidth?: number, imageHeight?: number) {
  const margin = 12, gap = 12, frame = 18;
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  const rightSpace = viewportWidth - margin - anchor.right - gap;
  const leftSpace = anchor.left - gap - margin;
  let maxWidth = Math.min(720, viewportWidth - margin * 2);
  const maxHeight = Math.min(560, viewportHeight - margin * 2);
  const side = Math.max(rightSpace, leftSpace) >= Math.min(320, maxWidth)
    ? rightSpace >= leftSpace ? "right" : "left" : null;
  if (side) maxWidth = Math.min(maxWidth, side === "right" ? rightSpace : leftSpace);
  const ratio = imageWidth && imageHeight ? imageWidth / imageHeight : 4 / 3;
  const imageAreaHeight = Math.min(maxHeight - frame, (maxWidth - frame) / ratio);
  const width = imageAreaHeight * ratio + frame;
  const height = imageAreaHeight + frame;
  const left = side === "right" ? anchor.right + gap : side === "left" ? anchor.left - gap - width : (viewportWidth - width) / 2;
  const top = side ? anchor.top + (anchor.height - height) / 2
    : anchor.bottom + gap + height <= viewportHeight - margin ? anchor.bottom + gap
      : anchor.top - gap - height >= margin ? anchor.top - gap - height : (viewportHeight - height) / 2;
  return {
    left: Math.max(margin, Math.min(viewportWidth - margin - width, left)),
    top: Math.max(margin, Math.min(viewportHeight - margin - height, top)), width, height,
  };
}

export function ClipboardImageHover({ item, bridge, className, disabled }: {
  item: ClipboardItem; bridge: ClipboardBridge; className: string; disabled: boolean;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [position, setPosition] = useState<ReturnType<typeof previewPosition> | null>(null);
  const hide = useCallback(() => { setHovered(false); setPosition(null); }, []);
  const imageWidth = item.image?.width, imageHeight = item.image?.height;

  useEffect(() => {
    if (!hovered || disabled) return;
    const timer = setTimeout(() => {
      if (anchor.current?.isConnected) setPosition(previewPosition(anchor.current.getBoundingClientRect(), imageWidth, imageHeight));
    }, 180);
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); hide();
    };
    // The list is virtualized: scrolling can replace the hovered row without
    // a pointerleave event. Only the hovered image installs these listeners.
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    window.addEventListener("pointerdown", hide, true);
    window.addEventListener("keydown", escape, true);
    document.addEventListener("visibilitychange", hide);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
      window.removeEventListener("pointerdown", hide, true);
      window.removeEventListener("keydown", escape, true);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [hovered, disabled, hide, item.id, imageWidth, imageHeight]);

  useEffect(() => { if (disabled) hide(); }, [disabled, hide]);

  return <span ref={anchor} className={className} onPointerEnter={event => {
    if (disabled || event.pointerType === "touch") return;
    setPosition(null); setHovered(true);
  }} onPointerLeave={hide} onPointerCancel={hide}>
    <ClipboardImage bridge={bridge} id={item.id} title={item.title} thumbnail />
    {hovered && position && !disabled ? createPortal(
      <div className={styles.imageHoverPreview} style={position} data-clipboard-image-hover={item.id} aria-hidden="true" inert>
        <ClipboardImage key={item.id} bridge={bridge} id={item.id} title={item.title} showRetry={false} />
      </div>, document.body,
    ) : null}
  </span>;
}
