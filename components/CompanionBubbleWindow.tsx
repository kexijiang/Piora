"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useRunningTaskSnapshots } from "@/hooks/useTaskStatus";
import { deriveCompanionTaskPresentation } from "@/lib/companion-behavior";
import { getTaskProgress } from "@/lib/companion-interaction";
import {
  formatCompanionFocusCountdown,
  getCompanionFocusPetPresentation,
} from "@/lib/companion-focus-timer";
import {
  createCompanionRuntimeChannel,
  fetchCompanionRuntimeState,
} from "@/lib/companion-runtime-client";
import type { CompanionDecision, CompanionFocusTimer, CompanionRuntimeState } from "@/lib/companion-runtime";
import styles from "./CompanionBubbleWindow.module.css";

export function CompanionBubbleWindow() {
  const { t } = useI18n();
  const runningTasks = useRunningTaskSnapshots();
  const [taskIndex, setTaskIndex] = useState(0);
  const [decision, setDecision] = useState<CompanionDecision | null>(null);
  const [decisionVisible, setDecisionVisible] = useState(false);
  const [focusTimer, setFocusTimer] = useState<CompanionFocusTimer | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const latestUpdatedAtRef = useRef(Number.NEGATIVE_INFINITY);

  // The native bubble is only 300 × 128 and ignores mouse input. Rotate tasks
  // instead of putting them in a clipped, unscrollable list.
  const taskIds = JSON.stringify(runningTasks.map((task) => task.id));
  useEffect(() => {
    setTaskIndex(0);
    if (runningTasks.length < 2) return;
    const timer = window.setInterval(() => setTaskIndex((index) => (index + 1) % runningTasks.length), 5_000);
    return () => window.clearInterval(timer);
  }, [taskIds, runningTasks.length]);

  useEffect(() => {
    const controller = new AbortController();
    const applyDecision = (next: CompanionDecision | null) => {
      setDecision(next);
      setDecisionVisible(Boolean(next?.speech && Date.now() - next.createdAt < 18_000));
    };
    const applyState = (state: CompanionRuntimeState) => {
      if (state.updatedAt < latestUpdatedAtRef.current) return;
      latestUpdatedAtRef.current = state.updatedAt;
      setFocusTimer(state.focusTimer);
      applyDecision(state.mind.lastDecision);
    };
    const channel = createCompanionRuntimeChannel(applyState);
    void fetchCompanionRuntimeState({ signal: controller.signal })
      .then(applyState)
      .catch(() => undefined);
    return () => {
      controller.abort();
      channel?.close();
    };
  }, []);

  useEffect(() => {
    if (!decisionVisible) return;
    const timer = window.setTimeout(() => setDecisionVisible(false), 18_000);
    return () => window.clearTimeout(timer);
  }, [decision?.id, decisionVisible]);

  useEffect(() => {
    if (focusTimer?.status !== "running") return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [focusTimer?.endsAt, focusTimer?.status]);

  const focus = focusTimer ? getCompanionFocusPetPresentation(focusTimer, clock) : null;
  const task = runningTasks[taskIndex % Math.max(1, runningTasks.length)];
  const presentation = task ? deriveCompanionTaskPresentation(task) : null;
  const progress = task ? getTaskProgress(task) : null;
  const activityKind = presentation?.activityKind;
  const activityLabel = activityKind
    ? t(`companion.agent.${activityKind === "assistant" ? "responding" : activityKind === "approval" ? "review" : activityKind}`)
    : "";
  const reminderVisible = decisionVisible && decision?.event === "todo.reminder";
  const visible = decisionVisible || focus !== null || Boolean(task);

  return (
    <main className={`${styles.surface}${visible ? ` ${styles.visible}` : ""}`}>
      {task && presentation && !reminderVisible ? (
        <div
          className={`${styles.bubble} ${styles.taskBubble}`}
          data-testid="companion-activity-bubble"
          data-session-id={task.id}
          data-status={presentation.status}
          role="status"
        >
          <div className={styles.taskHeading}>
            <strong>{task.title || task.id.slice(0, 8)}</strong>
            {runningTasks.length > 1 ? <small>{taskIndex % runningTasks.length + 1} / {runningTasks.length}</small> : null}
          </div>
          <small className={styles.taskActivity}>{activityLabel}{progress?.label ? ` · ${progress.label}` : ""}</small>
          <span className={styles.taskMessage}>{task.activity?.message || task.errorSummary || t(`companion.activity.${presentation.status}Cause`)}</span>
        </div>
      ) : focus && !reminderVisible ? (
        <div
          className={`${styles.bubble} ${styles.timerBubble}`}
          data-testid="companion-focus-timer-bubble"
          data-phase={focus.phase}
          data-status={focus.status}
          aria-label={`${t(`companion.focusTimer.${focus.phase}`)} ${formatCompanionFocusCountdown(focus.remainingSeconds)}`}
        >
          <span className={styles.timerPhase}>{t(`companion.focusTimer.${focus.phase}`)}</span>
          <strong>{formatCompanionFocusCountdown(focus.remainingSeconds)}</strong>
          <small>{t(focus.status === "running" ? "companion.focusTimer.running" : "companion.focusTimer.paused")}</small>
        </div>
      ) : decisionVisible && decision?.speech ? <div className={styles.bubble} role="status">{decision.speech}</div> : null}
    </main>
  );
}
