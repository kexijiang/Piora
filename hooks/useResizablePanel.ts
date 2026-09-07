"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject,
  type PointerEvent,
} from "react";
import { clampPanelWidth } from "@/lib/panel-layout";

interface DragState {
  growthDirection: "left" | "right";
  pointerId: number;
  startX: number;
  startWidth: number;
  target: HTMLDivElement;
  previousCursor: string;
  previousUserSelect: string;
}

interface UseResizablePanelOptions {
  ariaLabel: string;
  cssVariable: `--${string}`;
  defaultWidth: number;
  getDefaultWidth?: () => number;
  getCurrentWidth?: () => number;
  getMaxWidth: () => number;
  growthDirection: "left" | "right";
  dragScale?: number;
  followDefaultWidth?: boolean;
  maxWidth: number;
  minWidth: number;
  panelRef?: MutableRefObject<HTMLDivElement | null>;
  storageKey: string;
  widthRef: MutableRefObject<number>;
}

interface CommitOptions {
  forcePersist?: boolean;
  persist?: boolean;
}

function readStoredWidth(storageKey: string): number | null {
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === null) return null;
    const parsed = Number.parseInt(stored, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredWidth(storageKey: string, width: number): void {
  try {
    window.localStorage.setItem(storageKey, String(width));
  } catch {
    // Resizing remains available when storage is unavailable.
  }
}

function readGrowthDirection(
  target: HTMLDivElement,
  fallback: "left" | "right",
): "left" | "right" {
  const direction = target.dataset.resizeGrowthDirection;
  return direction === "left" || direction === "right" ? direction : fallback;
}

function clearStoredWidth(storageKey: string): void {
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // Resetting still works for this window when storage is unavailable.
  }
}

export function useResizablePanel(options: UseResizablePanelOptions) {
  const {
    ariaLabel,
    cssVariable,
    defaultWidth,
    getDefaultWidth,
    getCurrentWidth,
    getMaxWidth,
    growthDirection,
    dragScale = 1,
    followDefaultWidth = false,
    maxWidth,
    minWidth,
    panelRef: providedPanelRef,
    storageKey,
    widthRef,
  } = options;
  const internalPanelRef = useRef<HTMLDivElement>(null);
  const panelRef = providedPanelRef ?? internalPanelRef;
  const dragRef = useRef<DragState | null>(null);
  const restoredRef = useRef(false);
  const preferredWidthRef = useRef<number | null>(null);
  const [width, setWidth] = useState(defaultWidth);
  const [isResizing, setIsResizing] = useState(false);
  const [hasMounted, setHasMounted] = useState(false);

  const effectiveMaxWidth = useCallback(
    () => Math.min(maxWidth, Math.max(minWidth, getMaxWidth())),
    [getMaxWidth, maxWidth, minWidth],
  );

  const clampWidth = useCallback(
    (candidate: number) => clampPanelWidth(candidate, minWidth, effectiveMaxWidth()),
    [effectiveMaxWidth, minWidth],
  );

  const applyLiveWidth = useCallback((nextWidth: number) => {
    widthRef.current = nextWidth;
    panelRef.current?.style.setProperty(cssVariable, `${nextWidth}px`);
  }, [cssVariable, panelRef, widthRef]);

  const applyResponsiveDefault = useCallback(() => {
    panelRef.current?.style.removeProperty(cssVariable);
    const nextWidth = clampWidth(getCurrentWidth?.() ?? getDefaultWidth?.() ?? defaultWidth);
    widthRef.current = nextWidth;
    setWidth(nextWidth);
    return nextWidth;
  }, [clampWidth, cssVariable, defaultWidth, getCurrentWidth, getDefaultWidth, panelRef, widthRef]);

  const commitWidth = useCallback((candidate: number, commitOptions: CommitOptions = {}) => {
    const { forcePersist = false, persist = true } = commitOptions;
    const nextWidth = clampWidth(candidate);
    const changed = nextWidth !== widthRef.current;
    if (persist) preferredWidthRef.current = nextWidth;
    applyLiveWidth(nextWidth);
    setWidth(nextWidth);
    if (persist && (changed || forcePersist)) writeStoredWidth(storageKey, nextWidth);
    return nextWidth;
  }, [applyLiveWidth, clampWidth, storageKey, widthRef]);

  const restoreBodyState = useCallback((drag: DragState) => {
    document.body.style.cursor = drag.previousCursor;
    document.body.style.userSelect = drag.previousUserSelect;
  }, []);

  const finishResize = useCallback((pointerId: number) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== pointerId) return;
    dragRef.current = null;
    restoreBodyState(drag);
    setIsResizing(false);
    commitWidth(widthRef.current, { forcePersist: true });

    try {
      if (drag.target.hasPointerCapture(pointerId)) {
        drag.target.releasePointerCapture(pointerId);
      }
    } catch {
      // The browser may have already released capture after pointer cancellation.
    }
  }, [commitWidth, restoreBodyState, widthRef]);

  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const activeDrag = dragRef.current;
    if (activeDrag) finishResize(activeDrag.pointerId);

    const target = event.currentTarget;
    const liveWidth = clampWidth(getCurrentWidth?.() ?? widthRef.current);
    widthRef.current = liveWidth;
    setWidth(liveWidth);
    target.focus({ preventScroll: true });
    target.setPointerCapture(event.pointerId);
    dragRef.current = {
      growthDirection: readGrowthDirection(target, growthDirection),
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: liveWidth,
      target,
      previousCursor: document.body.style.cursor,
      previousUserSelect: document.body.style.userSelect,
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setIsResizing(true);
  }, [clampWidth, finishResize, getCurrentWidth, growthDirection, widthRef]);

  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.pointerType === "mouse" && event.buttons === 0) {
      finishResize(event.pointerId);
      return;
    }
    event.preventDefault();

    const direction = drag.growthDirection === "right" ? 1 : -1;
    const nextWidth = clampWidth(drag.startWidth + ((event.clientX - drag.startX) * direction * dragScale));
    applyLiveWidth(nextWidth);
    event.currentTarget.setAttribute("aria-valuenow", String(nextWidth));
    event.currentTarget.setAttribute("aria-valuetext", `${nextWidth} px`);
  }, [applyLiveWidth, clampWidth, dragScale, finishResize]);

  const onPointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
    finishResize(event.pointerId);
  }, [finishResize]);

  const onPointerCancel = useCallback((event: PointerEvent<HTMLDivElement>) => {
    finishResize(event.pointerId);
  }, [finishResize]);

  const onLostPointerCapture = useCallback((event: PointerEvent<HTMLDivElement>) => {
    finishResize(event.pointerId);
  }, [finishResize]);

  const resetWidth = useCallback(() => {
    const nextDefault = getDefaultWidth?.() ?? defaultWidth;
    if (followDefaultWidth) {
      clearStoredWidth(storageKey);
      preferredWidthRef.current = null;
      applyResponsiveDefault();
      return;
    }
    commitWidth(nextDefault, { forcePersist: true });
  }, [applyResponsiveDefault, commitWidth, defaultWidth, followDefaultWidth, getDefaultWidth, storageKey]);

  const reclampWidth = useCallback(() => {
    // Settings hides the chat with display:none. Its zero-sized observation
    // is not a user resize and must never replace the saved preference.
    const panel = panelRef.current;
    if (panel && (panel.getClientRects().length === 0 || panel.clientWidth === 0)) return;
    const preferredWidth = preferredWidthRef.current ?? readStoredWidth(storageKey);
    const hasManualWidth = dragRef.current !== null || preferredWidth !== null;
    if (followDefaultWidth && !hasManualWidth) {
      applyResponsiveDefault();
      return;
    }
    commitWidth(dragRef.current ? widthRef.current : preferredWidth ?? widthRef.current, { persist: false });
  }, [applyResponsiveDefault, commitWidth, followDefaultWidth, panelRef, storageKey, widthRef]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 12;
    const separatorGrowthDirection = readGrowthDirection(event.currentTarget, growthDirection);
    const growKey = separatorGrowthDirection === "right" ? "ArrowRight" : "ArrowLeft";
    const shrinkKey = separatorGrowthDirection === "right" ? "ArrowLeft" : "ArrowRight";
    const currentWidth = clampWidth(getCurrentWidth?.() ?? widthRef.current);

    if (event.key === growKey) {
      event.preventDefault();
      commitWidth(currentWidth + step, { forcePersist: true });
    } else if (event.key === shrinkKey) {
      event.preventDefault();
      commitWidth(currentWidth - step, { forcePersist: true });
    } else if (event.key === "Home") {
      event.preventDefault();
      commitWidth(minWidth, { forcePersist: true });
    } else if (event.key === "End") {
      event.preventDefault();
      commitWidth(effectiveMaxWidth(), { forcePersist: true });
    } else if (event.key === "Enter") {
      event.preventDefault();
      resetWidth();
    }
  }, [clampWidth, commitWidth, effectiveMaxWidth, getCurrentWidth, growthDirection, minWidth, resetWidth, widthRef]);

  useEffect(() => {
    setHasMounted(true);
  }, []);

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;

    const storedWidth = readStoredWidth(storageKey);
    preferredWidthRef.current = storedWidth;
    if (storedWidth === null && followDefaultWidth) {
      applyResponsiveDefault();
      return;
    }
    const candidate = storedWidth ?? getDefaultWidth?.() ?? defaultWidth;
    commitWidth(candidate, { persist: false });
  }, [applyResponsiveDefault, commitWidth, defaultWidth, followDefaultWidth, getDefaultWidth, storageKey]);

  useEffect(() => {
    if (!restoredRef.current) return;
    reclampWidth();

    let frame = 0;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      if (settleTimer) clearTimeout(settleTimer);
      frame = requestAnimationFrame(() => {
        frame = 0;
        reclampWidth();
      });
      // Flex panels have short width transitions; sync the keyboard/ARIA value
      // once more after those transitions finish.
      settleTimer = setTimeout(reclampWidth, 260);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (frame !== 0) cancelAnimationFrame(frame);
      if (settleTimer) clearTimeout(settleTimer);
    };
  }, [reclampWidth]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!followDefaultWidth || !panel || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => reclampWidth());
    observer.observe(panel);
    return () => observer.disconnect();
  }, [followDefaultWidth, panelRef, reclampWidth]);

  useEffect(() => {
    if (!isResizing) return;
    const cancelResize = () => {
      const drag = dragRef.current;
      if (drag) finishResize(drag.pointerId);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") cancelResize();
    };
    window.addEventListener("blur", cancelResize);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", cancelResize);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [finishResize, isResizing]);

  useEffect(() => {
    return () => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      restoreBodyState(drag);
    };
  }, [restoreBodyState]);

  return {
    isResizing,
    panelRef,
    reclampWidth,
    resetWidth,
    separatorProps: {
      "aria-label": ariaLabel,
      "aria-orientation": "vertical" as const,
      "aria-valuemax": hasMounted ? effectiveMaxWidth() : maxWidth,
      "aria-valuemin": minWidth,
      "aria-valuenow": width,
      "aria-valuetext": `${width} px`,
      "data-resize-growth-direction": growthDirection,
      onDoubleClick: resetWidth,
      onKeyDown,
      onLostPointerCapture,
      onPointerCancel,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      role: "separator" as const,
      tabIndex: 0,
    },
    width,
  };
}
