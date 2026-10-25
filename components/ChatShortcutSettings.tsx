"use client";

import { useState, type KeyboardEvent } from "react";
import { useSendShortcut } from "@/hooks/useSendShortcut";
import { useI18n } from "@/hooks/useI18n";
import { formatShortcutBinding } from "@/lib/keyboard-shortcuts";
import { DEFAULT_CHAT_SHORTCUTS, recordChatShortcut, type ChatShortcutAction, type ChatShortcutError } from "@/lib/send-shortcut";
import { AliIcon } from "./AliIcon";
import styles from "./SettingsDialog.module.css";
import shortcuts from "./ShortcutSettings.module.css";

const actions = ["send", "steer", "newline"] as const;

export function ChatShortcutSettings() {
  const { t } = useI18n();
  const { bindings, setBinding } = useSendShortcut();
  const [recording, setRecording] = useState<ChatShortcutAction | null>(null);
  const [error, setError] = useState<{ action: ChatShortcutAction; type: ChatShortcutError } | null>(null);
  const save = (action: ChatShortcutAction, binding: string | null) => {
    const result = setBinding(action, binding);
    setError(result ? { action, type: result } : null);
    if (!result) setRecording(null);
  };
  const capture = (action: ChatShortcutAction, event: KeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.repeat) return;
    if (event.key === "Escape") { setRecording(null); setError(null); return; }
    if (event.key === "Backspace" || event.key === "Delete") { save(action, null); return; }
    if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) return;
    const binding = recordChatShortcut(event);
    if (!binding) { setError({ action, type: "invalid" }); return; }
    save(action, binding);
  };
  return <>{actions.map(action => {
    const title = t(`settings.${action}Shortcut`);
    return <div className={`${styles.conversationRow} ${styles.sendShortcutRow}`} data-settings-id={`conversation.${action}Shortcut`} key={action}>
      <div className={styles.conversationCopy}>
        <div className={styles.rowTitle}>{title}</div>
        <div className={styles.rowDescription}>{t(`settings.${action}ShortcutDescription`)}</div>
        {error?.action === action && <p className={shortcuts.error} role="alert">{t(`settings.chatShortcutError.${error.type}`)}</p>}
      </div>
      <div className={styles.shortcutRecorderControls}>
        <button type="button" className={shortcuts.recorder} data-recording={recording === action} data-app-shortcuts="preserve"
          aria-label={t("shortcuts.recordLabel", { command: title })} title={t("shortcuts.recordHint")}
          onClick={() => { setRecording(action); setError(null); }}
          onBlur={() => setRecording(current => current === action ? null : current)}
          onKeyDown={event => { if (recording === action) capture(action, event); }}>
          {recording === action ? t("shortcuts.recording") : bindings[action] ? <kbd>{formatShortcutBinding(bindings[action])}</kbd> : t("shortcuts.unassigned")}
        </button>
        <button type="button" className={shortcuts.resetOne} disabled={bindings[action] === DEFAULT_CHAT_SHORTCUTS[action]}
          aria-label={t("shortcuts.resetOneLabel", { command: title })} title={t("shortcuts.resetOne")}
          onClick={() => save(action, DEFAULT_CHAT_SHORTCUTS[action])}><AliIcon name="reload" size={14} /></button>
      </div>
    </div>;
  })}<div className={styles.conversationRow}><div className={styles.rowDescription}>{t("shortcuts.recordHint")}</div></div></>;
}
