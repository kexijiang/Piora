"use client";

import { useEffect, useRef, useState } from "react";
import { ModelProviderIcon } from "./ModelProviderIcon";
import { moveProvider } from "@/lib/provider-order";
import styles from "./ModelsExperience.module.css";

export function ProviderOrderList({ ids, selected, disabled, locale, displayName, enabled, onSelect, onReorder }: {
  ids: string[]; selected: string; disabled: boolean; locale: string;
  displayName: (id: string) => string; enabled: (id: string) => boolean;
  onSelect: (id: string) => void; onReorder: (ids: string[]) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; target: string | null; active: boolean; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const hint = locale === "zh-CN" ? "长按拖动排序 · Alt + ↑↓" : "Hold to reorder · Alt + ↑↓";
  useEffect(() => () => { if (drag.current) clearTimeout(drag.current.timer); }, []);

  const finish = (cancel = false) => {
    const current = drag.current;
    if (!current) return;
    clearTimeout(current.timer);
    drag.current = null;
    setDragging(null); setTarget(null);
    if (current.active) suppressClick.current = true;
    if (!cancel && !disabled && current.active && current.target && current.target !== current.id) {
      onReorder(moveProvider(ids, current.id, current.target));
    }
  };

  return <div ref={root} className={styles.providerOrderList}>
    <p className={styles.orderHint}>{hint}</p>
    {ids.map(id => <button key={id} type="button" className={styles.navItem} data-provider-id={id}
      data-dragging={dragging === id} data-drop-target={target === id && dragging !== id}
      aria-current={selected === id ? "page" : undefined} disabled={disabled} title={hint}
      onClick={event => { if (suppressClick.current && event.detail !== 0) { suppressClick.current = false; return; } onSelect(id); }}
      onContextMenu={event => event.preventDefault()}
      onPointerDown={event => {
        if (disabled || event.button !== 0 || !event.isPrimary) return;
        finish(true); suppressClick.current = false;
        event.currentTarget.setPointerCapture(event.pointerId);
        const current = { id, target: id as string | null, active: false, x: event.clientX, y: event.clientY,
          timer: setTimeout(() => { current.active = true; suppressClick.current = true; setDragging(id); }, 350) };
        drag.current = current;
      }}
      onPointerMove={event => {
        const current = drag.current;
        if (!current) return;
        if (!current.active) {
          if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > 8) finish(true);
          return;
        }
        const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-provider-id]");
        current.target = row && root.current?.contains(row) ? row.dataset.providerId ?? null : null;
        setTarget(current.target);
        const scroller = root.current?.closest<HTMLElement>(`.${styles.root}`);
        if (scroller) {
          const bounds = scroller.getBoundingClientRect();
          if (event.clientY < bounds.top + 48) scroller.scrollBy(0, -16);
          else if (event.clientY > bounds.bottom - 48) scroller.scrollBy(0, 16);
        }
      }}
      onPointerUp={() => finish()} onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish(true)}
      onKeyDown={event => {
        if (event.key === "Escape") finish(true);
        if (disabled || !event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault();
        const next = ids[ids.indexOf(id) + (event.key === "ArrowUp" ? -1 : 1)];
        if (next) onReorder(moveProvider(ids, id, next));
      }}>
      <ModelProviderIcon provider={id} size={18} /><span>{displayName(id)}</span>
      <i className={enabled(id) ? styles.readyDot : styles.pendingDot} />
    </button>)}
  </div>;
}
