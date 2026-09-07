"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

export function ToolbarIconButton({ onClick, title, disabled, skipHover, color, background = "none", marginRight, ariaPressed, children }: {
  onClick: () => void; title: string; disabled?: boolean; skipHover?: boolean; color: string;
  background?: string; marginRight?: number; ariaPressed?: boolean; children: ReactNode;
}) {
  return <button onClick={onClick} disabled={disabled} title={title} aria-label={title} aria-pressed={ariaPressed}
    style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, marginRight, background, border: "none", color, cursor: disabled ? "default" : "pointer", borderRadius: "var(--radius-control)", flexShrink: 0, opacity: disabled ? 0.6 : 1, transition: "color 0.3s, background 0.3s" }}
    onMouseEnter={(event) => { if (!disabled && !skipHover) { event.currentTarget.style.color = "var(--text-muted)"; event.currentTarget.style.background = "var(--bg-hover)"; } }}
    onMouseLeave={(event) => { if (!disabled && !skipHover) { event.currentTarget.style.color = color; event.currentTarget.style.background = background; } }}>
    {children}
  </button>;
}

export function PathLabel({ text, style }: { text: string; style?: CSSProperties }) {
  return <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block", minWidth: 0, lineHeight: 1.35, direction: "rtl", textAlign: "left", ...style }}>
    <span style={{ unicodeBidi: "plaintext" }}>{text}</span>
  </span>;
}

const DROPDOWN_ANIMATION_MS = 140;
export function AnimatedDropdown({ open, children, style }: { open: boolean; children: ReactNode; style: CSSProperties }) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);
  useEffect(() => {
    let frame: number | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (open) {
      setMounted(true); setVisible(false);
      frame = window.requestAnimationFrame(() => { frame = window.requestAnimationFrame(() => setVisible(true)); });
    } else { setVisible(false); timeout = setTimeout(() => setMounted(false), DROPDOWN_ANIMATION_MS); }
    return () => { if (frame !== undefined) window.cancelAnimationFrame(frame); if (timeout) clearTimeout(timeout); };
  }, [open]);
  if (!mounted) return null;
  return <div style={{ ...style, opacity: visible ? 1 : 0, transform: visible ? "translateY(0) scale(1)" : "translateY(-5px) scale(0.985)", transformOrigin: "top center", pointerEvents: visible ? "auto" : "none", transition: `opacity ${DROPDOWN_ANIMATION_MS}ms ease, transform ${DROPDOWN_ANIMATION_MS}ms ease` }}>{children}</div>;
}
