"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { formatElapsed } from "@/lib/format-elapsed";
import {
  runStatusPhraseKey,
  settleRunElapsedView,
  type RunElapsedMemory,
} from "@/lib/run-status-phrases";

const EMPTY_MEMORY: RunElapsedMemory = { view: null, previousPhraseId: null };

/**
 * Total elapsed line for the agent turn currently on screen.
 * The phrase is chosen once per turn. The 1s tick only updates the clock.
 */
export function RunElapsedStatus({
  running,
  runStartedAt,
}: {
  running: boolean;
  runStartedAt: number | null;
}) {
  const { t } = useI18n();
  const [memory, setMemory] = useState<RunElapsedMemory>(EMPTY_MEMORY);
  const [tick, setTick] = useState(0);

  useLayoutEffect(() => {
    const now = Date.now();
    if (running) setTick(now);
    setMemory((current) => {
      const settled = settleRunElapsedView({
        running,
        runStartedAt,
        now,
        view: current.view,
        previousPhraseId: current.previousPhraseId,
      });
      if (settled.view === current.view && settled.previousPhraseId === current.previousPhraseId) return current;
      return settled;
    });
  }, [running, runStartedAt]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setTick(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);

  const view = memory.view;
  if (!view) return null;
  const elapsedMs = view.elapsedMs ?? Math.max(0, tick - view.startedAt);
  const duration = formatElapsed(elapsedMs);
  const live = view.elapsedMs === null;
  const phrase = t(runStatusPhraseKey(view.phraseId));
  const text = live
    ? t("runStatus.live", { phrase, duration })
    : t("runStatus.done", { duration });

  return (
    <div
      className="run-elapsed-status"
      data-state={live ? "running" : "done"}
      data-phrase-id={live ? view.phraseId : undefined}
    >
      <span className="run-elapsed-status-mark" aria-hidden="true" />
      <span className="sr-only" role="status" aria-live="polite">{live ? phrase : text}</span>
      <span className="run-elapsed-status-text" aria-hidden="true" title={text}>{text}</span>
    </div>
  );
}
