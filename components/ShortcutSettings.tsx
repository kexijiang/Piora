"use client";

import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useApplicationShortcuts } from "@/hooks/useApplicationShortcuts";
import { useI18n } from "@/hooks/useI18n";
import {
  APPLICATION_SHORTCUTS,
  formatShortcutBinding,
  isMacPlatform,
  recordShortcutFromEvent,
  type ApplicationShortcutId,
} from "@/lib/keyboard-shortcuts";
import { AliIcon } from "./AliIcon";
import styles from "./ShortcutSettings.module.css";

const SHORTCUT_GROUPS = [
  {
    id: "navigation",
    titleKey: "shortcuts.group.navigation",
    descriptionKey: "shortcuts.group.navigationDescription",
    icon: "search",
    includes: (id: ApplicationShortcutId) => id.startsWith("navigate.") || id === "palette.open",
  },
  {
    id: "workspace",
    titleKey: "shortcuts.group.workspace",
    descriptionKey: "shortcuts.group.workspaceDescription",
    icon: "layout",
    includes: (id: ApplicationShortcutId) => id.startsWith("panel."),
  },
  {
    id: "system",
    titleKey: "shortcuts.group.system",
    descriptionKey: "shortcuts.group.systemDescription",
    icon: "sparkles",
    includes: (id: ApplicationShortcutId) => id.startsWith("companion.") || id === "settings.general",
  },
] as const;

export function ShortcutSettings() {
  const { t } = useI18n();
  const { bindings, overrides, setBinding, resetBinding, resetAll } = useApplicationShortcuts();
  const [recording, setRecording] = useState<ApplicationShortcutId | null>(null);
  const [error, setError] = useState<{ type: "conflict"; conflict: ApplicationShortcutId } | { type: "reserved"; binding: string } | null>(null);
  const mac = isMacPlatform(window.piDesktop?.platform);

  const capture = (id: ApplicationShortcutId, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setRecording(null);
      setError(null);
      return;
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      setBinding(id, null);
      setRecording(null);
      setError(null);
      return;
    }
    const binding = recordShortcutFromEvent(event.nativeEvent, mac);
    if (!binding) return;
    const result = setBinding(id, binding);
    if (!result.ok) {
      setError("reserved" in result
        ? { type: "reserved", binding }
        : { type: "conflict", conflict: result.conflict });
      return;
    }
    setError(null);
    setRecording(null);
  };

  const titleFor = (id: ApplicationShortcutId) => t(APPLICATION_SHORTCUTS.find((item) => item.id === id)?.titleKey ?? id);
  const changedCount = Object.keys(overrides).length;

  return (
    <div className={styles.surface} data-testid="shortcut-settings">
      <header className={styles.heading}>
        <div className={styles.headingCopy}>
          <span className={styles.headingIcon}><AliIcon name="code" size={18} /></span>
          <div>
          <h2>{t("settings.shortcuts")}</h2>
          <p>{t("settings.shortcutsDescription")}</p>
          </div>
        </div>
        <div className={styles.headingActions}>
          <span className={styles.changedBadge} data-active={changedCount > 0 || undefined}>{t("shortcuts.changedCount", { count: changedCount })}</span>
          <button type="button" className={styles.resetAll} disabled={changedCount === 0} onClick={() => { resetAll(); setError(null); setRecording(null); }}>
            <AliIcon name="reload" size={14} />{t("shortcuts.resetAll")}
          </button>
        </div>
      </header>
      <div className={styles.groups}>
        {SHORTCUT_GROUPS.map((group) => {
          const items = APPLICATION_SHORTCUTS.filter((item) => group.includes(item.id));
          return (
            <section className={styles.group} key={group.id} aria-labelledby={`shortcut-group-${group.id}`}>
              <div className={styles.groupHeading}>
                <span className={styles.groupIcon}><AliIcon name={group.icon} size={16} /></span>
                <div>
                  <h3 id={`shortcut-group-${group.id}`}>{t(group.titleKey)}</h3>
                  <p>{t(group.descriptionKey)}</p>
                </div>
                <span className={styles.groupCount}>{items.length}</span>
              </div>
              <div className={styles.list}>
                {items.map((item) => {
                  const isRecording = recording === item.id;
                  const isChanged = Object.prototype.hasOwnProperty.call(overrides, item.id);
                  const formatted = formatShortcutBinding(bindings[item.id], mac);
                  const keys = formatted ? formatted.split("+") : [];
                  return (
                    <div data-settings-id={item.titleKey === "shortcuts.commandPalette" ? "shortcuts.palette" : item.titleKey === "commands.searchChats" ? "shortcuts.search" : undefined} className={styles.row} data-modified={isChanged || undefined} key={item.id}>
                      <div className={styles.copy}>
                        <strong>{t(item.titleKey)}{isChanged ? <span className={styles.modifiedDot} aria-label={t("shortcuts.modified")} /> : null}</strong>
                        <span>{t(item.descriptionKey)}</span>
                      </div>
                      <button
                        type="button"
                        className={styles.recorder}
                        data-recording={isRecording}
                        data-app-shortcuts="preserve"
                        aria-label={t("shortcuts.recordLabel", { command: t(item.titleKey) })}
                        onClick={() => { setRecording(item.id); setError(null); }}
                        onBlur={() => setRecording((current) => current === item.id ? null : current)}
                        onKeyDown={(event) => isRecording && capture(item.id, event)}
                      >
                        {isRecording ? <kbd className={styles.recordingKey}>{t("shortcuts.recording")}</kbd> : keys.length > 0 ? (
                          <span className={styles.keycaps}>{keys.map((key) => <kbd key={key}>{key}</kbd>)}</span>
                        ) : <span className={styles.unassigned}>{t("shortcuts.unassigned")}</span>}
                      </button>
                      <button
                        type="button"
                        className={styles.resetOne}
                        disabled={!isChanged}
                        aria-label={t("shortcuts.resetOneLabel", { command: t(item.titleKey) })}
                        title={t("shortcuts.resetOne")}
                        onClick={() => { resetBinding(item.id); setError(null); }}
                      >
                        <AliIcon name="reload" size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      <div className={`${styles.message} ${error ? styles.error : ""}`} role="status">
        <AliIcon name={error ? "alert" : "info"} size={15} />
        {error?.type === "conflict"
          ? t("shortcuts.conflict", { shortcut: formatShortcutBinding(bindings[error.conflict], mac), command: titleFor(error.conflict) })
          : error?.type === "reserved"
            ? t("shortcuts.reserved", { shortcut: formatShortcutBinding(error.binding, mac) })
            : t("shortcuts.recordHint")}
      </div>
      <p className={styles.note}><AliIcon name="info" size={14} />{t("shortcuts.nativeFindNote")}</p>
    </div>
  );
}
