"use client";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import styles from "../HarmonyPanel.module.css";
import { AliIcon } from "@/components/AliIcon";

type Option = { value: string; label: string };
export function HarmonyDeviceSelect({ label, options, value, displayLabel, onChange }: { label: string; options: Option[]; value: string; displayLabel?: string; onChange(value: string): void }) {
  const [open, setOpen] = useState(false), [cursor, setCursor] = useState(0);
  const root = useRef<HTMLDivElement>(null), id = useId();
  const selected = Math.max(0, options.findIndex(option => option.value === value));
  useEffect(() => { if (!open) return; const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); }; document.addEventListener("pointerdown", close); return () => document.removeEventListener("pointerdown", close); }, [open]);
  const choose = (index: number) => { const option = options[index]; if (option) onChange(option.value); setOpen(false); };
  const keyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") { setOpen(false); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if (!open) { setCursor(selected); setOpen(true); } else setCursor(index => (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length); }
    else if (open && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); choose(cursor); }
    else if (open && (event.key === "Home" || event.key === "End")) { event.preventDefault(); setCursor(event.key === "Home" ? 0 : options.length - 1); }
  };
  return <div className={styles.deviceSelect} ref={root}>
    <button type="button" role="combobox" aria-label={label} aria-expanded={open} aria-controls={`${id}-list`} aria-activedescendant={open ? `${id}-${cursor}` : undefined} aria-haspopup="listbox" data-value={value} onClick={() => { setCursor(selected); setOpen(!open); }} onKeyDown={keyboard}>
      <span title={options[selected]?.label}>{displayLabel ?? options[selected]?.label ?? ""}</span><AliIcon name="chevron-right" size={14} style={{ transform: open ? "rotate(-90deg)" : "rotate(90deg)", flexShrink: 0 }} />
    </button>
    {open ? <div id={`${id}-list`} role="listbox" aria-label={label} className={styles.deviceSelectMenu}>{options.map((option, index) => <button id={`${id}-${index}`} key={option.value} type="button" role="option" aria-selected={option.value === value} data-active={index === cursor} onMouseMove={() => setCursor(index)} onClick={() => choose(index)}>{option.label}</button>)}</div> : null}
  </div>;
}
