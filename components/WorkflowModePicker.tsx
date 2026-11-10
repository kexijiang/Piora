"use client";

import { useId } from "react";
import { useI18n } from "@/hooks/useI18n";
import { DEFAULT_WORKFLOW_TURN_BUDGET, MAX_WORKFLOW_TURN_BUDGET, type WorkflowPromptOptions } from "@/lib/workflow-types";
import styles from "./Workflow.module.css";

export function WorkflowModePicker({ value, onChange, disabled }: {
  value: WorkflowPromptOptions;
  onChange: (value: WorkflowPromptOptions) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const helpId = useId();
  return <div className={styles.picker}>
    <div className={styles.controls}>
      <select data-testid="workflow-mode-select" aria-label={t("workflow.mode")} aria-describedby={helpId}
        disabled={disabled} value={value.mode} onChange={event => onChange({ ...value, mode: event.target.value as WorkflowPromptOptions["mode"] })}>
        {(["agent", "plan", "goal"] as const).map(mode => <option key={mode} value={mode}>{t(`workflow.${mode}`)}</option>)}
      </select>
      {value.mode === "goal" && <label className={styles.budget}>{t("workflow.budget")}
        <input data-testid="workflow-budget-input" type="number" min={1} max={MAX_WORKFLOW_TURN_BUDGET} step={1}
          disabled={disabled} value={value.turnBudget ?? DEFAULT_WORKFLOW_TURN_BUDGET} title={t("workflow.budgetHelp")}
          onChange={event => { const number = event.currentTarget.valueAsNumber; if (Number.isSafeInteger(number) && number > 0 && number <= MAX_WORKFLOW_TURN_BUDGET) onChange({ ...value, turnBudget: number }); }} />
      </label>}
    </div>
    {value.mode !== "agent" && <p id={helpId} className={styles.help}>{t(`workflow.help.${value.mode}`)}</p>}
  </div>;
}
