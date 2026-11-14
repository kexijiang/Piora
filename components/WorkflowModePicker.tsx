"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { DEFAULT_WORKFLOW_TURN_BUDGET, MAX_WORKFLOW_TURN_BUDGET, type WorkflowMode, type WorkflowPromptOptions } from "@/lib/workflow-types";
import { AliIcon } from "./AliIcon";
import { WorkflowModeIcon } from "./WorkflowModeIcon";
import styles from "./WorkflowModePicker.module.css";

const MODES = ["agent", "plan", "goal"] as const;
const SELECTION_FEEDBACK_MS = 520;

export function WorkflowModePicker({ value, onChange, disabled }: {
  value: WorkflowPromptOptions;
  onChange: (value: WorkflowPromptOptions) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const helpId = useId();
  const [expanded, setExpanded] = useState(false);
  const [focusedMode, setFocusedMode] = useState<WorkflowMode>(value.mode);
  const slotRef = useRef<HTMLDivElement>(null);
  const choicesRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Partial<Record<WorkflowMode, HTMLButtonElement | null>>>({});
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openFocusRef = useRef<WorkflowMode>(value.mode);
  const returnFocusRef = useRef(false);
  const isExpanded = expanded && !disabled;

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const close = useCallback((returnFocus = false) => {
    clearCloseTimer();
    // Pointer and Tab dismissal keep the user's destination. Only restore focus
    // when a disappearing option still owns it (selection feedback or Escape).
    returnFocusRef.current = returnFocus && Boolean(choicesRef.current?.contains(document.activeElement));
    setExpanded(false);
  }, [clearCloseTimer]);

  const open = (mode: WorkflowMode = value.mode) => {
    if (disabled) return;
    clearCloseTimer();
    returnFocusRef.current = false;
    openFocusRef.current = mode;
    setFocusedMode(mode);
    setExpanded(true);
  };

  useLayoutEffect(() => {
    if (isExpanded) optionRefs.current[openFocusRef.current]?.focus({ preventScroll: true });
    else if (returnFocusRef.current && !disabled) toggleRef.current?.focus({ preventScroll: true });
    returnFocusRef.current = false;
  }, [isExpanded, disabled]);

  useEffect(() => {
    if (disabled) close();
  }, [disabled, close]);

  useEffect(() => clearCloseTimer, [clearCloseTimer]);

  useEffect(() => {
    if (!isExpanded) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!slotRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [isExpanded, close]);

  const select = (mode: WorkflowMode) => {
    if (disabled) return;
    clearCloseTimer();
    onChange({ ...value, mode });
    closeTimerRef.current = setTimeout(() => close(true), SELECTION_FEEDBACK_MS);
  };

  return <div className={styles.picker}>
    <div ref={slotRef} className={styles.modeSlot} role="group" aria-label={t("workflow.mode")}
      data-testid="workflow-mode-select" data-expanded={isExpanded ? "true" : "false"}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
      }}
      onKeyDown={event => {
        if (event.key === "Escape" && isExpanded) {
          event.preventDefault();
          event.stopPropagation();
          close(true);
        }
      }}>
      <button ref={toggleRef} type="button" className={styles.toggle} data-testid="workflow-mode-toggle"
        aria-label={`${t("workflow.mode")}: ${t(`workflow.${value.mode}`)}`}
        aria-expanded={isExpanded} aria-controls={`${helpId}-choices`}
        aria-hidden={isExpanded} tabIndex={isExpanded ? -1 : 0} inert={isExpanded}
        title={t(`workflow.help.${value.mode}`)} disabled={disabled}
        onClick={() => open()} onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          open(event.key === "Home" ? "agent" : event.key === "End" || event.key === "ArrowUp" ? "goal" : value.mode);
        }}>
        <WorkflowModeIcon mode={value.mode} size="1.15em" />
        <span>{t(`workflow.short.${value.mode}`)}</span>
        <AliIcon name="chevron-right" size="1em" aria-hidden="true" />
      </button>
      <div ref={choicesRef} id={`${helpId}-choices`} className={styles.modes} aria-hidden={!isExpanded} inert={!isExpanded}>
        {MODES.map(mode => <button key={mode} type="button" ref={element => { optionRefs.current[mode] = element; }}
          data-testid={`workflow-mode-${mode}`} className={styles.mode} aria-pressed={value.mode === mode}
          aria-label={t(`workflow.${mode}`)} aria-describedby={`${helpId}-${mode}`}
          title={t(`workflow.help.${mode}`)} disabled={disabled} tabIndex={isExpanded && focusedMode === mode ? 0 : -1}
          onFocus={() => setFocusedMode(mode)} onClick={() => select(mode)} onKeyDown={event => {
            if (!["ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const index = MODES.indexOf(mode);
            const next = event.key === "Home" ? 0 : event.key === "End" ? MODES.length - 1
              : (index + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + MODES.length) % MODES.length;
            optionRefs.current[MODES[next]]?.focus({ preventScroll: true });
          }}>
          <WorkflowModeIcon mode={mode} size="1.15em" />
          <span>{t(`workflow.short.${mode}`)}</span>
          <span id={`${helpId}-${mode}`} hidden>{t(`workflow.help.${mode}`)}</span>
        </button>)}
      </div>
    </div>
    {value.mode === "goal" && <label className={styles.budget}>{t("workflow.budget")}
      <input data-testid="workflow-budget-input" type="number" min={1} max={MAX_WORKFLOW_TURN_BUDGET} step={1}
        disabled={disabled} value={value.turnBudget ?? DEFAULT_WORKFLOW_TURN_BUDGET} title={t("workflow.budgetHelp")}
        onChange={event => { const number = event.currentTarget.valueAsNumber; if (Number.isSafeInteger(number) && number > 0 && number <= MAX_WORKFLOW_TURN_BUDGET) onChange({ ...value, turnBudget: number }); }} />
    </label>}
  </div>;
}
