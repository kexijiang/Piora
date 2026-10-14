"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useRunStatusPhrasePreference } from "@/hooks/useRunStatusPhrasePreference";
import { formatElapsed } from "@/lib/format-elapsed";
import {
  buildRunStatusPhraseRequest,
  createRunStatusPhraseScheduler,
  encodeRunStatusPhraseRequest,
  parseRunStatusPhraseRequestKey,
  requestRunStatusPhrase,
  resolveDisplayedRunStatusPhrase,
  type RunStatusPhraseScheduler,
} from "@/lib/run-status-phrase";
import {
  runStatusPhraseKey,
  settleRunElapsedView,
  type RunElapsedMemory,
} from "@/lib/run-status-phrases";

const EMPTY_MEMORY: RunElapsedMemory = { view: null, previousPhraseId: null };

/**
 * Total elapsed line for the agent turn currently on screen.
 * The fixed phrase is chosen once per turn and shown immediately. When model
 * lines are enabled, at most one generation is claimed for that turn and may
 * replace the fixed line; the following turn is prefetched after this one
 * starts or ends. Failures leave the fixed line in place.
 */
export function RunElapsedStatus({
  running,
  runStartedAt,
  model,
  cwd,
}: {
  running: boolean;
  runStartedAt: number | null;
  model?: { provider: string; modelId: string } | null;
  cwd?: string;
}) {
  const { locale, t } = useI18n();
  const { preference } = useRunStatusPhrasePreference();
  const [memory, setMemory] = useState<RunElapsedMemory>(EMPTY_MEMORY);
  const [tick, setTick] = useState(0);
  const [overlay, setOverlay] = useState<{ turnId: string; phrase: string } | null>(null);
  const wasRunningRef = useRef(false);
  const schedulerRef = useRef<RunStatusPhraseScheduler | null>(null);

  const requestKey = useMemo(() => {
    if (!preference.enabled || !model?.provider || !model.modelId) return null;
    const request = buildRunStatusPhraseRequest({
      provider: model.provider,
      modelId: model.modelId,
      cwd,
      locale,
      style: preference.style,
      customPrompt: preference.customPrompt,
    });
    return request ? encodeRunStatusPhraseRequest(request) : null;
  }, [cwd, locale, model?.modelId, model?.provider, preference.customPrompt, preference.enabled, preference.style]);

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

  const view = memory.view;
  const liveTurnId = running && view && view.elapsedMs === null ? view.turnId : null;

  useEffect(() => {
    if (schedulerRef.current === null) {
      schedulerRef.current = createRunStatusPhraseScheduler((key) => {
        const parsed = parseRunStatusPhraseRequestKey(key);
        return parsed ? requestRunStatusPhrase(parsed) : Promise.resolve(null);
      });
    }
    const scheduler = schedulerRef.current;
    if (!scheduler) return;
    if (liveTurnId) {
      wasRunningRef.current = true;
      let active = true;
      const promise = scheduler.claimTurn(liveTurnId, requestKey);
      if (!promise) return () => { active = false; };
      void promise.then((phrase) => {
        if (!active || !phrase) return;
        setOverlay({ turnId: liveTurnId, phrase });
      });
      return () => { active = false; };
    }
    if (wasRunningRef.current && !running) scheduler.prefetchNext(requestKey);
    else scheduler.noteIdleKey(requestKey);
    wasRunningRef.current = false;
  }, [liveTurnId, requestKey, running]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setTick(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);

  if (!view) return null;
  const elapsedMs = view.elapsedMs ?? Math.max(0, tick - view.startedAt);
  const duration = formatElapsed(elapsedMs);
  const live = view.elapsedMs === null;
  const fixedPhrase = t(runStatusPhraseKey(view.phraseId));
  const phrase = resolveDisplayedRunStatusPhrase({
    enabled: preference.enabled,
    fixedPhrase,
    generated: overlay?.turnId === view.turnId ? overlay.phrase : null,
    locale,
  });
  const text = live
    ? t("runStatus.live", { phrase, duration })
    : t("runStatus.done", { duration });

  return (
    <div
      className="run-elapsed-status"
      data-state={live ? "running" : "done"}
      data-phrase-id={live ? view.phraseId : undefined}
      data-phrase-source={live && phrase !== fixedPhrase ? "model" : "fixed"}
    >
      <span className="run-elapsed-status-mark" aria-hidden="true" />
      <span className="sr-only" role="status" aria-live="polite">{live ? phrase : text}</span>
      <span className="run-elapsed-status-text" aria-hidden="true" title={text}>{text}</span>
    </div>
  );
}
