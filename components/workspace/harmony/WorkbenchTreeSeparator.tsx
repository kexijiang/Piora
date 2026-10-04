"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import styles from "../HarmonyPanel.module.css";

const SEPARATOR_WIDTH = 8;
const CONTENT_MIN_WIDTH = 320;

interface Props {
  layoutRef: RefObject<HTMLDivElement | null>;
  treeId: string;
  label: string;
  chinese: boolean;
  storageKey: string;
  minimumTreeWidth: number;
  defaultWidth: number;
  enabled?: boolean;
}

export function WorkbenchTreeSeparator({ layoutRef, treeId, label, chinese, storageKey, minimumTreeWidth, defaultWidth, enabled = true }: Props) {
  const widthRef = useRef(defaultWidth);
  const [maximumWidth, setMaximumWidth] = useState(600);
  const getCurrentWidth = useCallback(() => layoutRef.current?.firstElementChild?.getBoundingClientRect().width ?? defaultWidth, [layoutRef, defaultWidth]);
  const getMaxWidth = useCallback(() => (layoutRef.current?.clientWidth ?? 0) - CONTENT_MIN_WIDTH - SEPARATOR_WIDTH, [layoutRef]);
  const { separatorProps, isResizing, reclampWidth } = useResizablePanel({
    ariaLabel: label, cssVariable: "--harmony-tree-width", defaultWidth,
    getCurrentWidth, getMaxWidth, followDefaultWidth: true, growthDirection: "right",
    minWidth: minimumTreeWidth, maxWidth: 600, panelRef: layoutRef, storageKey, widthRef,
  });

  // The database starts with a full-width app tree. Restore its split width when a snapshot opens.
  useEffect(() => { reclampWidth(); }, [enabled, reclampWidth]);
  useEffect(() => {
    const layout = layoutRef.current;
    if (!layout || typeof ResizeObserver === "undefined") return;
    // A container can change its limit without changing a small preferred tree width.
    // Keep the announced limit current even when the shared hook has no width state to update.
    const updateLimit = () => setMaximumWidth(Math.max(minimumTreeWidth, Math.min(600, getMaxWidth())));
    updateLimit();
    const observer = new ResizeObserver(updateLimit);
    observer.observe(layout);
    return () => observer.disconnect();
  }, [getMaxWidth, layoutRef, minimumTreeWidth]);

  return <div {...separatorProps} className={styles.treeSeparator} data-resizing={isResizing} hidden={!enabled}
    aria-valuemax={maximumWidth} aria-controls={treeId} title={chinese
      ? "拖动调整目录树宽度。←/→ 调整，Shift 加速，Home/End 最小/最大，Enter 或双击恢复默认。"
      : "Drag to resize the tree. Left/Right adjust, Shift speeds up, Home/End set limits, Enter or double-click restores the default."} />;
}
