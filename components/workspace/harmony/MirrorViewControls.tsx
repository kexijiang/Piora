"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AliIcon } from "@/components/AliIcon";
import styles from "./MirrorWindow.module.css";

export function MirrorViewControls({ zoom, onZoom, pinned, onPin, chinese }: {
  zoom: string; onZoom: (value: string) => void; pinned: boolean; onPin: () => void; chinese: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape, true); };
  }, [open]);
  const label = chinese ? "显示选项" : "Display options";
  return <div ref={root} className={styles.viewControls} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button ref={trigger} type="button" aria-label={label} title={label} aria-expanded={open} aria-controls={id}
      onClick={() => setOpen(value => !value)}><AliIcon name="setting" size={18} /></button>
    {open ? <div id={id} className={styles.viewPopover} role="group" aria-label={label}>
      <span className={styles.optionLabel}>{chinese ? "画面缩放" : "Video zoom"}</span>
      <div className={styles.zoomOptions} role="group" aria-label={chinese ? "画面缩放" : "Video zoom"}>
        {[["fit", chinese ? "适应" : "Fit"], ["0.5", "50%"], ["1", "100%"], ["2", "200%"]].map(([value, text]) =>
          <button type="button" key={value} aria-pressed={zoom === value} onClick={() => onZoom(value)}>{text}</button>)}
      </div>
      <button type="button" className={styles.pinOption} aria-pressed={pinned} onClick={onPin}>
        <AliIcon name="pushpin" size={16} /><span>{chinese ? "窗口置顶" : "Always on top"}</span>
        {pinned ? <AliIcon name="check" size={16} /> : null}
      </button>
    </div> : null}
  </div>;
}
