"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { MAX_WORKFLOW_TURN_BUDGET, type WorkflowActionName, type WorkflowRun, type WorkflowSnapshot } from "@/lib/workflow-types";
import { MarkdownBody } from "./MarkdownBody";
import { WorkflowModeIcon } from "./WorkflowModeIcon";
import styles from "./Workflow.module.css";

const knownReasons = new Set(["host_restarted", "mode_changed", "revision_requested", "user_exited", "user_paused", "user_cancelled", "user_stopped", "turn_budget_exhausted", "no_progress", "execution_finished", "planning_needs_input", "laboratory_disabled"]);

function WorkflowRunCard({ run, busy, running, onAction, historical = false, cwd, enabled }: {
  run: WorkflowRun; busy: boolean; running: boolean; historical?: boolean; cwd?: string; enabled: boolean;
  onAction: (action: WorkflowActionName, turnBudget?: number) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [budget, setBudget] = useState<string | null>(null);
  const budgetValue = budget ?? String(run.turnBudget);
  const budgetNumber = Number(budgetValue);
  const validBudget = Number.isSafeInteger(budgetNumber) && budgetNumber > 0 && budgetNumber <= MAX_WORKFLOW_TURN_BUDGET;
  const stopped = ["paused", "waiting", "failed", "budget_exhausted"].includes(run.status);
  const terminal = run.status === "completed" || run.status === "cancelled";
  const action = (name: WorkflowActionName) => { void onAction(name); };
  return <section className={styles.panel} data-testid={historical ? "workflow-history-entry" : "workflow-panel"}
    data-run-id={run.id} data-status={run.status} aria-label={t("workflow.current")}>
    <div className={styles.heading}>
      <strong>{t(`workflow.${run.kind}`)}{run.title ? ` · ${run.title}` : ""}</strong>
      <span className={styles.status} role={historical ? undefined : "status"}>{t(`workflow.status.${run.status}`)}</span>
    </div>
    <div className={styles.metadata}>{run.kind === "plan" ? t("workflow.version", { version: run.version }) : t("workflow.turns", { used: run.turnsUsed, budget: run.turnBudget })}</div>
    <details open={!historical && !terminal}>
      <summary>{run.objective || run.title || t("workflow.objective")}</summary>
      <div className={styles.body}>
        {run.kind === "plan" && run.markdown && <MarkdownBody cwd={cwd}>{run.markdown}</MarkdownBody>}
        {run.progress && <><h4>{t("workflow.progress")}</h4><p>{run.progress}</p></>}
        {run.kind === "goal" && <>
          <h4>{t("workflow.criteria")}</h4>
          <p className={styles.help}>{t("workflow.evidenceHelp")}</p>
          <ol>{run.criteria.map(criterion => <li key={criterion.id}>
            <span>{criterion.text}</span> <span className={styles.metadata}>{t(criterion.status === "verified" ? "workflow.verified" : "workflow.pending")}</span>
            <div className={styles.evidence}>{criterion.evidence || t("workflow.noEvidence")}</div>
          </li>)}</ol>
        </>}
      </div>
    </details>
    {run.reason && <div className={styles.reason}>{knownReasons.has(run.reason) ? t(`workflow.reason.${run.reason}`) : run.reason}</div>}
    {!historical && run.kind === "plan" && <div className={styles.actions}>
      {run.status === "awaiting_approval" && <>
        <button type="button" className={styles.primary} data-testid="workflow-plan-approve" disabled={!enabled || busy || running} onClick={() => action("approve")}>{t("workflow.approve")}</button>
        <button type="button" data-testid="workflow-plan-revise" disabled={!enabled || busy || running} onClick={() => action("revise")}>{t("workflow.revise")}</button>
      </>}
      {!terminal && run.status !== "running" && <button type="button" data-testid="workflow-plan-exit" disabled={busy || running} onClick={() => action("exit")}>{t("workflow.exit")}</button>}
      {enabled && ["planning", "waiting", "paused", "failed"].includes(run.status) && !running && <p className={styles.help}>{t("workflow.reviseHelp")}</p>}
    </div>}
    {!historical && run.kind === "goal" && !terminal && <>
      <div className={styles.actions}>
        {run.status === "running" && <button type="button" data-testid="workflow-goal-pause" disabled={busy} onClick={() => action("pause")}>{t("workflow.pause")}</button>}
        {stopped && <button type="button" className={styles.primary} data-testid="workflow-goal-resume" disabled={!enabled || busy || running || run.turnsUsed >= run.turnBudget} onClick={() => action("resume")}>{t("workflow.resume")}</button>}
        <button type="button" data-testid="workflow-goal-cancel" disabled={busy} onClick={() => action("cancel")}>{t("workflow.cancel")}</button>
        <label className={styles.budget}>{t("workflow.budget")}<input type="number" min={1} max={MAX_WORKFLOW_TURN_BUDGET} step={1}
          data-testid="workflow-run-budget-input" disabled={!enabled || busy || running} value={budgetValue} onChange={event => setBudget(event.target.value)} /></label>
        <button type="button" data-testid="workflow-goal-set-budget" disabled={!enabled || busy || running || !validBudget || budgetNumber === run.turnBudget}
          onClick={() => { void onAction("set_budget", budgetNumber).then(saved => { if (saved) setBudget(null); }); }}>{t("workflow.saveBudget")}</button>
      </div>
      <p className={styles.help}>{t("workflow.budgetHelp")}</p>
    </>}
  </section>;
}

type WorkflowPanelProps = {
  snapshot: WorkflowSnapshot | null; busy: boolean; running: boolean; error: string | null; cwd?: string;
  enabled?: boolean;
  settingsReady?: boolean;
  onAction: (action: WorkflowActionName, turnBudget?: number) => Promise<boolean>;
  onRefresh: () => Promise<void>;
};

function WorkflowPeek({ snapshot, busy, running, onAction, cwd, enabled = true, settingsReady = true }: WorkflowPanelProps) {
  const { t } = useI18n();
  const contentId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const expanded = !dismissed && (hovered || focused || pinned);
  useLayoutEffect(() => {
    const button = trigger.current;
    if (!expanded || !button) return;
    const content = document.getElementById(contentId);
    const surface = button.closest("[data-chat-surface]");
    const composer = button.closest("[data-chat-composer-area]");
    const resize = () => {
      const top = Math.max(0, surface?.getBoundingClientRect().top ?? 0);
      content?.style.setProperty("--workflow-preview-space", `${Math.max(0, button.getBoundingClientRect().top - top - 12)}px`);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(surface ?? document.documentElement);
    if (composer) observer.observe(composer);
    window.addEventListener("resize", resize);
    return () => { observer.disconnect(); window.removeEventListener("resize", resize); };
  }, [expanded, contentId]);
  const run = snapshot?.current;
  const title = run?.title || run?.objective || t("workflow.objective");
  return <section className={styles.dock} data-testid="workflow-peek" data-expanded={expanded} aria-label={t("workflow.current")}
    onPointerEnter={event => { if (event.pointerType !== "touch") { setHovered(true); setDismissed(false); } }}
    onPointerLeave={event => {
      setHovered(false);
      // Actions can replace the focused button (for example Continue → Pause)
      // without firing blur. Do not leave that preview latched open.
      if (!event.currentTarget.contains(document.activeElement)) setFocused(false);
    }}
    onFocusCapture={event => {
      // Mouse clicks on actions should not keep a hover preview open. Keyboard
      // navigation and text editing must keep it available until focus leaves.
      const retain = event.target.matches(":focus-visible, input, textarea, select");
      setFocused(retain);
      if (retain) setDismissed(false);
    }}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
    onKeyDown={event => {
      if (event.key !== "Escape" || !expanded) return;
      event.preventDefault(); event.stopPropagation();
      trigger.current?.focus();
      setPinned(false); setFocused(false); setDismissed(true);
    }}>
    <div className={styles.peekSurface}>
      <button ref={trigger} type="button" className={styles.peekTrigger} data-testid="workflow-peek-toggle"
        aria-expanded={expanded} aria-controls={contentId} title={t(pinned ? "workflow.collapse" : "workflow.peekHelp")}
        onClick={() => {
          if (pinned) { setPinned(false); setFocused(false); setDismissed(true); }
          else { setPinned(true); setDismissed(false); }
        }}>
        <WorkflowModeIcon mode={run?.kind ?? "plan"} />
        <span className={styles.peekMode}>{run ? t(`workflow.short.${run.kind}`) : t("workflow.current")}</span>
        <span className={styles.peekTitle}>{run ? title : t("workflow.history", { count: snapshot?.history.length ?? 0 })}</span>
        {run && <span className={styles.peekStatus} role="status" data-status={run.status}>
          <span className={styles.statusDot} aria-hidden="true" />{t(`workflow.status.${run.status}`)}
        </span>}
        {run?.kind === "goal" && <span className={styles.peekBudget}>{run.turnsUsed}/{run.turnBudget}</span>}
        <svg className={styles.peekChevron} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg>
      </button>
      <div id={contentId} className={styles.peekContent} data-testid="workflow-peek-content" hidden={!expanded}>
        {settingsReady && !enabled && run && <p className={styles.help} role="status" data-testid="workflow-laboratory-disabled">{t("workflow.laboratoryDisabled")}</p>}
        {run && <WorkflowRunCard key={run.id} run={run} busy={busy} running={running} enabled={enabled} onAction={onAction} cwd={cwd} />}
        {Boolean(snapshot?.history.length) && <details className={styles.history} data-testid="workflow-history">
          <summary>{t("workflow.history", { count: snapshot!.history.length })}</summary>
          {[...snapshot!.history].reverse().map((entry, index) => <WorkflowRunCard key={`${entry.id}:${entry.version}:${index}`} run={entry} busy={false} running={false} historical enabled={enabled} onAction={onAction} cwd={cwd} />)}
        </details>}
      </div>
    </div>
  </section>;
}

export function WorkflowPanel(props: WorkflowPanelProps) {
  const { snapshot, error, onRefresh } = props;
  const { t } = useI18n();
  return <>
    {error && <div className={styles.error} role="alert">{error}<button type="button" className={styles.retry} onClick={() => { void onRefresh(); }}>{t("workflow.refresh")}</button></div>}
    {(snapshot?.current || Boolean(snapshot?.history.length)) && <WorkflowPeek key={snapshot?.sessionId} {...props} />}
  </>;
}
