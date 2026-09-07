"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
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
  const [decision, setDecision] = useState<CompanionDecision | null>(null);
  const [decisionVisible, setDecisionVisible] = useState(false);
  const [focusTimer, setFocusTimer] = useState<CompanionFocusTimer | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const latestUpdatedAtRef = useRef(Number.NEGATIVE_INFINITY);

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
  const visible = decisionVisible || focus !== null;

  return (
    <main className={`${styles.surface}${visible ? ` ${styles.visible}` : ""}`}>
      {focus && !(decisionVisible && decision?.event === "todo.reminder") ? (
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
