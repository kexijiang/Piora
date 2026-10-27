"use client";
import { useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import styles from "../../ConfirmDialog.module.css";
export function HarmonySettingsSurface({ children, onClose, title }: { children: ReactNode; onClose: () => void; title: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, { onEscape: onClose });
  return createPortal(<div className={styles.backdrop}><div ref={ref} className={styles.dialog} role="dialog" aria-modal="true" aria-label={title} style={{ width: "min(720px, calc(100vw - 32px))", maxHeight: "calc(100dvh - 40px)", overflow: "auto" }}>{children}</div></div>, document.body);
}
