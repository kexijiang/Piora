"use client";

import { createPortal } from "react-dom";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { useI18n } from "@/hooks/useI18n";
import type {
  SessionSystemPromptBinding,
  SystemPromptSelection,
} from "@/lib/system-prompt-types";
import { getSystemPromptCatalog, getServerSystemPromptCatalog, subscribeSystemPromptCatalog } from "@/lib/system-prompt-client";
import { AliIcon } from "./AliIcon";
import styles from "./SystemPromptSelector.module.css";

interface Props {
  selection: SystemPromptSelection;
  binding?: SessionSystemPromptBinding | null;
  disabled?: boolean;
  onChange: (selection: SystemPromptSelection) => void | Promise<void>;
}

interface PopupPosition {
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
}

const DEFAULT_VALUE = "__default__";

function selectionValue(selection: SystemPromptSelection): string {
  return selection.mode === "template" ? selection.templateId : DEFAULT_VALUE;
}

export function SystemPromptSelector({ selection, binding, disabled = false, onChange }: Props) {
  const { t } = useI18n();
  const popupId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const catalog = useSyncExternalStore(subscribeSystemPromptCatalog, getSystemPromptCatalog, getServerSystemPromptCatalog);
  const loading = catalog === null;
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PopupPosition | null>(null);

  useEffect(() => {
    if (catalog?.selectorVisible === false) setOpen(false);
  }, [catalog?.selectorVisible]);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportMargin = 8;
    const availableWidth = Math.max(240, window.innerWidth - viewportMargin * 2);
    const width = Math.min(380, Math.max(300, rect.width), availableWidth);
    const left = Math.min(
      Math.max(viewportMargin, rect.left),
      Math.max(viewportMargin, window.innerWidth - width - viewportMargin),
    );
    const spaceBelow = window.innerHeight - rect.bottom - viewportMargin;
    const spaceAbove = rect.top - viewportMargin;
    const useAbove = spaceBelow < 260 && spaceAbove > spaceBelow;
    const availableHeight = useAbove ? spaceAbove - 6 : spaceBelow - 6;
    setPosition({
      left,
      ...(useAbove
        ? { bottom: window.innerHeight - rect.top + 6 }
        : { top: rect.bottom + 6 }),
      width,
      maxHeight: Math.max(120, Math.min(360, availableHeight)),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    updatePosition();
    const reposition = () => updatePosition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !popupRef.current?.contains(target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !position) return;
    popupRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }, [open, position]);

  const defaultTemplate = catalog?.templates.find((template) => template.id === catalog.defaultTemplateId);
  const selectedTemplateExists = selection.mode === "template"
    && Boolean(catalog?.templates.some((template) => template.id === selection.templateId));
  const label = selection.mode === "template"
    ? catalog?.templates.find((template) => template.id === selection.templateId)?.name
      ?? binding?.templateName
      ?? t("system.snapshot")
    : defaultTemplate?.name ?? t("system.piDefault");
  const selectedValue = selectionValue(selection);
  const unavailableSnapshot = selection.mode === "template" && !selectedTemplateExists;
  const isDisabled = disabled || loading;

  const select = (next: SystemPromptSelection) => {
    setOpen(false);
    void onChange(next);
    triggerRef.current?.focus();
  };

  if (!catalog || !catalog.selectorVisible) return null;

  const popupStyle: CSSProperties | undefined = position ? {
    left: position.left,
    top: position.top,
    bottom: position.bottom,
    width: position.width,
    maxHeight: position.maxHeight,
  } : undefined;

  const popup = open && position && typeof document !== "undefined" ? createPortal(
    <div
      ref={popupRef}
      className={styles.popup}
      style={popupStyle}
    >
      <div className={styles.popupHeader}>
        <span>
          <strong>{t("system.selectorTitle")}</strong>
          <small>{t("system.selectorSubtitle")}</small>
        </span>
        <button type="button" aria-label={t("chat.close")} onClick={() => setOpen(false)}>
          <AliIcon name="close" size={14} />
        </button>
      </div>
      <div
        id={popupId}
        className={styles.optionList}
        role="listbox"
        aria-label={t("system.selectTemplate")}
        onKeyDown={(event) => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          const options = Array.from(popupRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
          if (!options.length) return;
          event.preventDefault();
          const currentIndex = Math.max(0, options.indexOf(document.activeElement as HTMLElement));
          const nextIndex = event.key === "Home"
            ? 0
            : event.key === "End"
              ? options.length - 1
              : event.key === "ArrowDown"
                ? (currentIndex + 1) % options.length
                : (currentIndex - 1 + options.length) % options.length;
          options[nextIndex]?.focus();
        }}
      >
        <button
          type="button"
          role="option"
          aria-selected={selectedValue === DEFAULT_VALUE}
          onClick={() => select({ mode: "default" })}
        >
          <span className={styles.optionIcon}><AliIcon name="setting" size={15} /></span>
          <span className={styles.optionCopy}>
            <strong>{t("system.defaultOption", { name: defaultTemplate?.name ?? t("system.piDefault") })}</strong>
            <small>{defaultTemplate?.prompt || t("system.piDefaultDescription")}</small>
          </span>
          {selectedValue === DEFAULT_VALUE ? <AliIcon name="check" size={15} /> : null}
        </button>
        {catalog?.templates.map((template) => (
          <button
            key={template.id}
            type="button"
            role="option"
            aria-selected={selectedValue === template.id}
            onClick={() => select({ mode: "template", templateId: template.id })}
          >
            <span className={styles.optionIcon}><AliIcon name="file" size={15} /></span>
            <span className={styles.optionCopy}>
              <strong>{template.name}</strong>
              <small>{template.prompt || t("system.emptyTemplate")}</small>
            </span>
            {selectedValue === template.id ? <AliIcon name="check" size={15} /> : null}
          </button>
        ))}
        {unavailableSnapshot ? (
          <button type="button" role="option" aria-selected="true" onClick={() => setOpen(false)}>
            <span className={styles.optionIcon}><AliIcon name="archive" size={15} /></span>
            <span className={styles.optionCopy}>
              <strong>{binding?.templateName ?? t("system.snapshot")}</strong>
              <small>{binding?.prompt || t("system.emptyTemplate")}</small>
            </span>
            <AliIcon name="check" size={15} />
          </button>
        ) : null}
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={styles.control}
        title={t("system.selectorDescription")}
        disabled={isDisabled}
        aria-label={t("system.selectTemplate")}
        aria-haspopup="listbox"
        aria-controls={open ? popupId : undefined}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        <AliIcon name="file" size={13} />
        <span className={styles.visualLabel}>{label}</span>
        <span className={styles.caret} data-open={open || undefined}>
          <AliIcon name="chevron-right" size={11} />
        </span>
      </button>
      {popup}
    </>
  );
}
