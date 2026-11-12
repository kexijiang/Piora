"use client";

import { useId } from "react";
import { useI18n } from "@/hooks/useI18n";
import { DEFAULT_WORKFLOW_TURN_BUDGET, MAX_WORKFLOW_TURN_BUDGET, type WorkflowPromptOptions } from "@/lib/workflow-types";
import { WorkflowModeIcon } from "./WorkflowModeIcon";
import styles from "./WorkflowModePicker.module.css";

export function WorkflowModePicker({ value, onChange, disabled }: {
  value: WorkflowPromptOptions;
  onChange: (value: WorkflowPromptOptions) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const helpId = useId();
  return <div className={styles.picker}>
    <div className={styles.modes} role="group" aria-label={t("workflow.mode")} data-testid="workflow-mode-select">
      {(["agent", "plan", "goal"] as const).map(mode => <button key={mode} type="button"
        data-testid={`workflow-mode-${mode}`} className={styles.mode} aria-pressed={value.mode === mode}
        aria-label={t(`workflow.${mode}`)} aria-describedby={`${helpId}-${mode}`}
        title={t(`workflow.help.${mode}`)} disabled={disabled} onClick={() => onChange({ ...value, mode })}>
        <WorkflowModeIcon mode={mode} />
        <span>{t(`workflow.short.${mode}`)}</span>
        <span id={`${helpId}-${mode}`} hidden>{t(`workflow.help.${mode}`)}</span>
      </button>)}
    </div>
    {value.mode === "goal" && <label className={styles.budget}>{t("workflow.budget")}
      <input data-testid="workflow-budget-input" type="number" min={1} max={MAX_WORKFLOW_TURN_BUDGET} step={1}
        disabled={disabled} value={value.turnBudget ?? DEFAULT_WORKFLOW_TURN_BUDGET} title={t("workflow.budgetHelp")}
        onChange={event => { const number = event.currentTarget.valueAsNumber; if (Number.isSafeInteger(number) && number > 0 && number <= MAX_WORKFLOW_TURN_BUDGET) onChange({ ...value, turnBudget: number }); }} />
    </label>}
  </div>;
}
