"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useI18n } from "@/hooks/useI18n";
import type {
  SessionCapabilitiesState,
  SessionCapabilityKind,
  SessionCapabilityItem,
  SessionCapabilitySelection,
} from "@/lib/session-capabilities";
import { AliIcon, type AliIconName } from "./AliIcon";

const styles = {
  root: "session-tools-root",
  trigger: "session-tools-trigger",
  popover: "session-tools-popover",
  header: "session-tools-header",
  close: "session-tools-close",
  sectionLabel: "session-tools-section-label",
  list: "session-tools-list",
  row: "session-tools-row",
  icon: "session-tools-icon",
  copy: "session-tools-copy",
  switch: "session-tools-switch",
  footer: "session-tools-footer",
} as const;

interface Props {
  capabilities: SessionCapabilitiesState;
  busy: boolean;
  saving: boolean;
  onChange: (selection: SessionCapabilitySelection) => void | Promise<void>;
  onOpenGlobalSettings?: () => void;
}

const GROUPS: SessionCapabilityKind[] = [
  "workspace",
  "browser",
  "interaction",
  "automation",
  "collaboration",
  "device",
  "extension",
];

const TOOL_LABEL_KEYS: Record<string, string> = {
  bash: "sessionTools.tool.bash",
  read: "sessionTools.tool.read",
  edit: "sessionTools.tool.edit",
  write: "sessionTools.tool.write",
  grep: "sessionTools.tool.grep",
  find: "sessionTools.tool.find",
  ls: "sessionTools.tool.ls",
  browser: "sessionTools.tool.browser",
  piora_request_user_input: "sessionTools.tool.askUser",
  piora_automation: "sessionTools.tool.automation",
  piora_room: "sessionTools.tool.room",
};

function iconFor(item: SessionCapabilityItem): AliIconName {
  switch (item.kind) {
    case "workspace": return "code";
    case "browser": return "earth";
    case "device": return "mobile";
    case "interaction": return "comment";
    case "automation": return "calendar";
    case "collaboration": return "branches";
    default: return "build";
  }
}

export function SessionToolsControl({ capabilities, busy, saving, onChange, onOpenGlobalSettings }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<{ side: "above" | "below"; maxHeight: number }>({
    side: "above",
    maxHeight: 520,
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const disabled = busy || saving;
  const availableCount = capabilities.items.filter((item) => item.available).length;

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const topSafeArea = 48;
      const bottomSafeArea = 12;
      const gap = 9;
      const above = Math.max(0, rect.top - topSafeArea - gap);
      const below = Math.max(0, window.innerHeight - rect.bottom - bottomSafeArea - gap);
      const side = above >= 420 || above >= below ? "above" : "below";
      setPlacement({ side, maxHeight: Math.max(220, Math.floor(side === "above" ? above : below)) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  const toggleCapability = (item: SessionCapabilityItem) => {
    if (disabled || !item.available) return;
    const enabled = new Set(capabilities.policy.enabledCapabilityIds);
    if (enabled.has(item.id)) enabled.delete(item.id);
    else enabled.add(item.id);
    void onChange({ preset: "custom", enabledCapabilityIds: [...enabled] });
  };

  const useCodingDefaults = () => {
    if (disabled) return;
    void onChange({ preset: "coding" });
  };

  return <div ref={rootRef} className={styles.root}>
    <button
      type="button"
      className={styles.trigger}
      aria-label={t("sessionTools.title")}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => setOpen((value) => !value)}
    >
      <AliIcon name="build" size={14} />
      <span>{t("sessionTools.trigger", { count: capabilities.enabledCount, total: availableCount })}</span>
    </button>
    {open ? <div
      className={styles.popover}
      role="dialog"
      aria-label={t("sessionTools.title")}
      data-placement={placement.side}
      style={{ maxHeight: placement.maxHeight }}
    >
      <div className={styles.header}>
        <div>
          <strong>{t("sessionTools.title")}</strong>
          <small>{t("sessionTools.summary", { count: capabilities.enabledCount, total: availableCount })}</small>
        </div>
        <button type="button" className={styles.close} aria-label={t("sessionTools.close")} onClick={() => setOpen(false)}><AliIcon name="close" size={14} /></button>
      </div>
      {GROUPS.map((kind) => {
        const items = capabilities.items.filter((item) => item.kind === kind);
        if (items.length === 0) return null;
        return <section key={kind}>
          <div className={styles.sectionLabel}>{t(`sessionTools.group.${kind}`)}</div>
          <div className={styles.list}>
            {items.map((item) => {
              const toolName = item.toolNames[0];
              const labelKey = TOOL_LABEL_KEYS[toolName];
              const label = labelKey ? t(labelKey) : item.label;
              return <label key={item.id} className={styles.row} data-unavailable={!item.available ? "true" : undefined}>
                <span className={styles.icon}><AliIcon name={iconFor(item)} size={14} /></span>
                <span className={styles.copy}>
                  <strong>{label}</strong>
                  <small>{item.available ? toolName : t("sessionTools.profileRestricted")}</small>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  className={styles.switch}
                  checked={item.enabled && item.available}
                  disabled={disabled || !item.available}
                  aria-label={label}
                  onChange={() => toggleCapability(item)}
                />
              </label>;
            })}
          </div>
        </section>;
      })}
      <div className={styles.footer}>
        <span>{saving ? t("sessionTools.saving") : busy ? t("sessionTools.busy") : t("sessionTools.defaultOn")}</span>
        <div>
          <button type="button" disabled={disabled || capabilities.policy.preset === "coding"} onClick={useCodingDefaults}>{t("sessionTools.useCodingDefaults")}</button>
          {onOpenGlobalSettings ? <button type="button" onClick={() => { setOpen(false); onOpenGlobalSettings(); }}>{t("sessionTools.globalSettings")}<AliIcon name="external-link" size={12} /></button> : null}
        </div>
      </div>
    </div> : null}
  </div>;
}
