"use client";

import { useId, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { filterCommandHistory, readCommandHistory, rememberCommand, terminalHistoryKey } from "@/lib/command-history";
import styles from "./TerminalPanel.module.css";

export function TerminalCommandInput({ cwd, disabled, onRun }: {
  cwd: string;
  disabled: boolean;
  onRun: (command: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const sending = useRef(false);
  const currentValue = useRef("");
  const [value, setValue] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const candidates = value.trim() ? filterCommandHistory(history, value) : history.slice(0, 8);
  const visible = open && !disabled && candidates.length > 0;
  const change = (next: string) => { currentValue.current = next; setValue(next); setActive(-1); };
  const loadHistory = () => {
    try { setHistory(readCommandHistory(window.localStorage, cwd)); } catch { /* Storage may be disabled. */ }
  };
  const choose = (command: string) => { change(command); setOpen(false); input.current?.focus(); };
  const run = async () => {
    const command = currentValue.current.trim();
    if (!command || disabled || sending.current) return;
    sending.current = true; setBusy(true); setOpen(false); setError("");
    const original = currentValue.current;
    try {
      await onRun(command);
      let updated = rememberCommand(history, command);
      try {
        updated = rememberCommand(readCommandHistory(window.localStorage, cwd), command);
        window.localStorage.setItem(terminalHistoryKey(cwd), JSON.stringify(updated));
      } catch { /* Keep this window's history even when storage is unavailable. */ }
      setHistory(updated);
      if (currentValue.current === original) change("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { sending.current = false; setBusy(false); }
  };

  return <div className={styles.composer} onKeyDown={(event) => event.stopPropagation()}>
    {visible && <div className={styles.suggestions}>
      <div className={styles.suggestionHeading}><span>{t("terminal.history")}</span><span>{t("terminal.historyHint")}</span></div>
      <div id={listId} role="listbox" aria-label={t("terminal.history")}>
        {candidates.map((command, index) => <div
          role="option" id={`${listId}-${index}`} key={command} aria-selected={active === index}
          className={styles.suggestion} title={command}
          onMouseDown={(event) => event.preventDefault()} onClick={() => choose(command)} onMouseMove={() => setActive(index)}
        ><span aria-hidden="true">↶</span><code>{command}</code><span aria-hidden="true">↵</span></div>)}
      </div>
    </div>}
    <form className={styles.commandInput} onSubmit={(event) => { event.preventDefault(); void run(); }}>
      <span className={styles.promptMark} aria-hidden="true">❯</span>
      <input ref={input} role="combobox" aria-label={t("terminal.commandInput")} aria-autocomplete="list"
        aria-expanded={visible} aria-controls={visible ? listId : undefined} aria-activedescendant={visible && active >= 0 ? `${listId}-${active}` : undefined}
        value={value} placeholder={t("terminal.commandPlaceholder")} disabled={disabled} autoComplete="off" spellCheck={false}
        onFocus={loadHistory} onBlur={() => { setOpen(false); setActive(-1); }}
        onChange={(event) => { change(event.target.value); setOpen(true); }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) {
            if (event.key === "Enter") event.preventDefault();
            return;
          }
          if (event.key === "Escape") { event.preventDefault(); setOpen(false); setActive(-1); }
          else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && candidates.length) {
            event.preventDefault(); setOpen(true);
            setActive((index) => event.key === "ArrowDown" ? (index + 1) % candidates.length : (index <= 0 ? candidates.length - 1 : index - 1));
          } else if (visible && (event.key === "Tab" && !event.shiftKey || event.key === "Enter" && active >= 0)) {
            event.preventDefault(); choose(candidates[Math.max(0, active)]);
          }
        }}
      />
      <button type="button" aria-label={t("terminal.history")} title={t("terminal.history")} aria-expanded={visible} disabled={disabled}
        onMouseDown={(event) => event.preventDefault()} onClick={() => { loadHistory(); input.current?.focus(); setOpen(!open); setActive(-1); }}>↶</button>
      <button type="submit" disabled={disabled || busy || !value.trim()} aria-label={t("terminal.runCommand")} title={t("terminal.runCommand")}>↵</button>
    </form>
    {error && <div className={styles.commandInputError} role="alert">{error}</div>}
  </div>;
}
