"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type PointerEvent, type ReactNode } from "react";
import styles from "./CompanionTransferStation.module.css";

const STORAGE_KEY = "piora:transfer-workspace-size:v1";
type Size = { width: number | null; height: number | null };
type Edge = "left" | "right" | "bottom" | "corner";
export interface TransferWorkspaceFrameHandle { resetSize(): void }

export const TransferWorkspaceFrame = forwardRef<TransferWorkspaceFrameHandle, { children: ReactNode }>(function TransferWorkspaceFrame({ children }, ref) {
  const frame = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size>({ width: null, height: null });
  const current = useRef(size);
  const drag = useRef<{ edge: Edge; x: number; y: number; width: number; height: number; pointer: number; target: HTMLDivElement } | null>(null);
  const persist = () => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(current.current)); } catch { /* Optional layout preference. */ } };
  const apply = (next: Size) => { current.current = next; setSize(next); };
  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
      if (stored) apply({ width: Number.isFinite(stored.width) ? Math.max(320, stored.width) : null, height: Number.isFinite(stored.height) ? Math.max(360, Math.min(1600, stored.height)) : null });
    } catch { /* Invalid preferences do not prevent resizing. */ }
  }, []);
  useImperativeHandle(ref, () => ({ resetSize() { apply({ width: null, height: null }); persist(); } }), []);
  const resize = (width: number, height: number, edge: Edge) => {
    const available = frame.current?.parentElement?.clientWidth ?? width;
    apply({
      width: edge === "bottom" ? current.current.width : Math.min(available, Math.max(Math.min(320, available), width)),
      height: edge === "left" || edge === "right" ? current.current.height : Math.max(360, Math.min(1600, height)),
    });
  };
  const start = (event: PointerEvent<HTMLDivElement>, edge: Edge) => {
    if (event.button !== 0 || !frame.current) return;
    event.preventDefault();
    const rect = frame.current.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { edge, x: event.clientX, y: event.clientY, width: rect.width, height: rect.height, pointer: event.pointerId, target: event.currentTarget };
  };
  const finish = () => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    if (active.target.hasPointerCapture(active.pointer)) active.target.releasePointerCapture(active.pointer);
    persist();
  };
  const labels: Record<Edge, string> = { left: "从左侧调整中转站宽度", right: "从右侧调整中转站宽度", bottom: "调整中转站高度", corner: "调整中转站宽度和高度" };
  return <div ref={frame} className={styles.workspaceFrame} style={{ width: size.width === null ? "100%" : `${size.width}px`, height: size.height === null ? "70dvh" : `${size.height}px` }}>
    {children}
    {(["left", "right", "bottom", "corner"] as const).map((edge) => <div key={edge} className={styles.workspaceGrip} data-edge={edge} role={edge === "corner" ? "button" : "separator"} tabIndex={0}
      aria-label={labels[edge]} title={`${labels[edge]} · 拖动或方向键调整 · 双击恢复`}
      aria-orientation={edge === "corner" ? undefined : edge === "bottom" ? "horizontal" : "vertical"}
      onPointerDown={(event) => start(event, edge)} onPointerMove={(event) => {
        const active = drag.current;
        if (!active || active.pointer !== event.pointerId) return;
        resize(active.width + (event.clientX - active.x) * (edge === "left" ? -2 : 2), active.height + event.clientY - active.y, edge);
      }} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
      onDoubleClick={() => { apply({ width: null, height: null }); persist(); }}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) || !frame.current) return;
        event.preventDefault(); event.stopPropagation();
        const rect = frame.current.getBoundingClientRect();
        const step = event.shiftKey ? 80 : 20;
        const widthDelta = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
        const heightDelta = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
        resize(rect.width + widthDelta * (edge === "left" ? -1 : 1), rect.height + heightDelta, edge); persist();
      }}><span aria-hidden="true" /></div>)}
  </div>;
});
