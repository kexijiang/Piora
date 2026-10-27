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
  const ref = useRef<HTMLDivElement>(null);
  const notice = message.presentation === "notice";
  const finishRef = useRef(finish); finishRef.current = finish;
  useFocusTrap(ref, !notice, { onEscape: () => finish(null) });
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => finishRef.current(null), message.durationMs ?? 3000); return () => clearTimeout(timer); }, [notice, message]);
  return <div ref={ref} className={`${styles.dialog} ${standalone ? styles.standalone : ""} ${notice ? styles.notice : ""}`} role={notice ? "status" : "dialog"} aria-modal={notice ? undefined : true} aria-labelledby="piora-message-title" aria-describedby="piora-message-body">
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
