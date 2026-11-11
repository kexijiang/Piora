"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import type { PioraMessage } from "@/desktop/src/harmony-window-types";
import styles from "./ConfirmDialog.module.css";
import { useTheme } from "@/hooks/useTheme";
import { useFontPreferences } from "@/hooks/useFontPreferences";

export async function showPioraMessage(message: PioraMessage): Promise<string | null> {
  if (window.piDesktop?.messages) return window.piDesktop.messages.show(message);
  return new Promise(resolve => window.dispatchEvent(new CustomEvent("piora:message", { detail: { message, resolve } })));
}
export function PioraMessageContent({ message, finish, standalone = false }: { message: PioraMessage; finish: (id: string | null) => void; standalone?: boolean }) {
  const { isDark } = useTheme();
  const ref = useRef<HTMLDivElement>(null);
  const notice = message.presentation === "notice";
  const finishRef = useRef(finish); finishRef.current = finish;
  useFocusTrap(ref, !notice, { onEscape: () => finish(null) });
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => finishRef.current(null), message.durationMs ?? 3000); return () => clearTimeout(timer); }, [notice, message]);
  if (notice) return <div ref={ref} data-dark={isDark} data-tone={message.tone} className={`${styles.notice} ${standalone ? styles.standalone : ""}`} role="status" aria-live="polite">
    <svg className={styles.noticeIcon} width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.4" /><path d={message.tone === "error" ? "m7 7 6 6M13 7l-6 6" : "m6.5 10 2.3 2.3 4.7-4.7"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
    <div className={styles.noticeCopy}><strong title={message.title}>{message.title}</strong><p title={message.message}>{message.message}</p></div>
    <div className={styles.noticeActions}>{message.actions.map(action => <button key={action.id} type="button" aria-label={action.label} title={action.label} className={action.id === "done" ? styles.noticeClose : undefined} onClick={() => finish(action.id)}>
      {action.id === "done" ? <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg> : action.label}
    </button>)}</div>
  </div>;
  return <div ref={ref} data-dark={isDark} className={`${styles.dialog} ${standalone ? styles.standalone : ""} ${notice ? styles.notice : ""}`} role={notice ? "status" : "dialog"} aria-modal={notice ? undefined : true} aria-labelledby="piora-message-title" aria-describedby="piora-message-body">
    <div className={styles.body}><h2 id="piora-message-title">{message.title}</h2>
      {message.preview ? <img className={styles.preview} src={message.preview} alt="截图预览" /> : null /* eslint-disable-line @next/next/no-img-element */}
      <p id="piora-message-body">{message.message}</p></div>
    <div className={styles.actions}>{message.actions.map(action => <button key={action.id} type="button" className={action.primary ? styles.primary : undefined} onClick={() => finish(action.id)}>{action.label}</button>)}</div>
  </div>;
}
export function PioraMessageHost() {
  const [queue, setQueue] = useState<Array<{ message: PioraMessage; resolve: (id: string | null) => void }>>([]);
  useEffect(() => { const receive = (event: Event) => setQueue(current => [...current, (event as CustomEvent).detail]); window.addEventListener("piora:message", receive); return () => window.removeEventListener("piora:message", receive); }, []);
  const item = queue[0];
  if (!item) return null;
  return createPortal(<div className={item.message.presentation === "notice" ? styles.noticeHost : styles.backdrop}><PioraMessageContent message={item.message} finish={id => { item.resolve(id); setQueue(current => current.slice(1)); }} /></div>, document.body);
}
export function DesktopMessageWindow() {
  useTheme();
  useFontPreferences();
  const [message, setMessage] = useState<PioraMessage | null>(null);
  useEffect(() => { void window.piDesktop?.messages?.get().then(setMessage); }, []);
  return message ? <PioraMessageContent standalone message={message} finish={id => { void window.piDesktop?.messages?.finish(id); }} /> : null;
}
