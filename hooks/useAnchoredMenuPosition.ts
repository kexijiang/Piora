"use client";

import { useLayoutEffect, useState, type RefObject } from "react";

interface MenuPosition {
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
}

/** Viewport coordinates for a body portal, including the mobile keyboard. */
export function useAnchoredMenuPosition(anchor: RefObject<HTMLElement | null>, open: boolean): MenuPosition | null {
  const [position, setPosition] = useState<MenuPosition | null>(null);
  useLayoutEffect(() => {
    if (!open) { setPosition(null); return; }
    const element = anchor.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      const viewport = window.visualViewport;
      const x = viewport?.offsetLeft ?? 0;
      const y = viewport?.offsetTop ?? 0;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const margin = 8;
      const gap = 8;
      const width = Math.min(Math.max(rect.width, 320), 680, Math.max(0, viewportWidth - margin * 2));
      const left = Math.max(x + margin, Math.min(rect.left, x + viewportWidth - margin - width));
      const aboveEdge = Math.min(y + viewportHeight - margin, Math.max(y + margin, rect.top - gap));
      const belowEdge = Math.max(y + margin, Math.min(y + viewportHeight - margin, rect.bottom + gap));
      const above = Math.max(0, aboveEdge - y - margin);
      const below = Math.max(0, y + viewportHeight - margin - belowEdge);
      const useAbove = above >= Math.min(320, viewportHeight * 0.5) || above >= below;
      const next: MenuPosition = {
        left,
        width,
        maxHeight: Math.min(400, useAbove ? above : below),
        ...(useAbove ? { bottom: window.innerHeight - aboveEdge } : { top: belowEdge }),
      };
      setPosition((previous) => previous && previous.left === next.left && previous.width === next.width
        && previous.maxHeight === next.maxHeight && previous.top === next.top && previous.bottom === next.bottom ? previous : next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, [anchor, open]);
  return open ? position : null;
}
