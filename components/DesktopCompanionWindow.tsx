/*
 * MODIFIED MIT ADAPTATION NOTICE
 *
 * The transient task bubble and reserved message-area behavior in this
 * component are adapted from OpenPets/OpenPetsKit concepts. The implementation
 * is rewritten for Piora's Electron/React companion window and Pi task state.
 * See third_party/openpets/SOURCE.md and LICENSE.
 */

"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useCompanionPets } from "@/hooks/useCompanionPets";
import { useCompanionHitRegions } from "@/hooks/useCompanionHitRegions";
import { useCompanionPreferences } from "@/hooks/useCompanionPreferences";
import { useI18n } from "@/hooks/useI18n";
import { useRunningTaskSnapshots } from "@/hooks/useTaskStatus";
import type { CompanionActivity, CompanionActivityEvent } from "@/lib/companion";
import {
  deriveCompanionTaskPresentation,
} from "@/lib/companion-behavior";
import {
  buildCompanionInteractionContext,
  createCompanionWorkRhythm,
  getTaskProgress,
  type CompanionSessionContext,
  type CompanionWorkRhythm,
} from "@/lib/companion-interaction";
import {
  COMPANION_RUNTIME_POLL_INTERVAL_MS,
  createCompanionRuntimeChannel,
  fetchCompanionRuntimeState,
  publishCompanionRuntimeState,
} from "@/lib/companion-runtime-client";
import type { CompanionAutonomyLevel, CompanionFocusTimer, CompanionRuntimeState } from "@/lib/companion-runtime";
import { planCompanionWander } from "@/lib/companion-wander";
import type { TaskRuntimeSnapshot } from "@/lib/task-status";
import { BuiltinPet, COMPANION_ACTIVITY_COLORS, SpritePet } from "./CompanionPet";
import styles from "./DesktopCompanionWindow.module.css";

const DEFAULT_ACTIVITY: CompanionActivity = { status: "idle", cause: "" };
const PET_DRAG_THRESHOLD_PX = 5;
const DEFAULT_PET_HIT_REGION = { left: 0.15, top: 0.19, width: 0.7, height: 0.79 };

const AGENT_ACTIVITY_LABELS = {
  idle: "companion.agent.idle",
  failed: "companion.agent.failed",
  review: "companion.agent.review",
  prompt: "companion.agent.prompt",
  thinking: "companion.agent.thinking",
  assistant: "companion.agent.responding",
  tool: "companion.agent.tool",
  command: "companion.agent.command",
  compacting: "companion.agent.compacting",
  approval: "companion.agent.review",
  retry: "companion.agent.retry",
} as const;

export function DesktopCompanionWindow() {
  const { t, locale } = useI18n();
  const { preferences, hydrated: preferencesHydrated } = useCompanionPreferences();
  const pets = useCompanionPets(true);
  const runningTasks = useRunningTaskSnapshots();
  const [activity, setActivity] = useState<CompanionActivity>(DEFAULT_ACTIVITY);
  const [runtimeEvent, setRuntimeEvent] = useState<CompanionActivity["event"]>();
  const [sessionContext, setSessionContext] = useState<CompanionSessionContext | null>(null);
  const [workRhythm, setWorkRhythm] = useState<CompanionWorkRhythm>(() => createCompanionWorkRhythm());
  const [bubblesCollapsed, setBubblesCollapsed] = useState(false);
  const previousBubbleCountRef = useRef(0);
  const previousTasksRef = useRef(new Map<string, TaskRuntimeSnapshot>());
  const runtimeEventSequenceRef = useRef(0);
  const activePet = useMemo(
    () => pets.catalog?.installed.find((pet) => pet.id === preferences.selectedPetId) ?? null,
    [pets.catalog?.installed, preferences.selectedPetId],
  );
  const [visibleFrameIndex, setVisibleFrameIndex] = useState(0);
  const hitRegions = useCompanionHitRegions(activePet?.atlasUrl
    ? {
        url: activePet.atlasUrl,
        frameWidth: activePet.frame.width,
        frameHeight: activePet.frame.height,
        columns: activePet.frame.columns,
        rows: activePet.frame.rows,
      }
    : { url: "/companion-pets/piora-bot.webp" });
  const hitRegion = hitRegions?.[visibleFrameIndex] ?? hitRegions?.[0] ?? DEFAULT_PET_HIT_REGION;
  const hitRegionStyle = {
    left: `${hitRegion.left * 100}%`,
    top: `${hitRegion.top * 100}%`,
    width: `${hitRegion.width * 100}%`,
    height: `${hitRegion.height * 100}%`,
  } satisfies CSSProperties;

  useEffect(() => setVisibleFrameIndex(0), [activePet?.sourceKey]);

  // --- Pet interaction state: one-shot model-driven reactions. ---
  const [overlayEvent, setOverlayEvent] = useState<CompanionActivityEvent | null>(null);
  const overlaySequenceRef = useRef(0);
  const speechRequestRef = useRef(0);
  const clickTimerRef = useRef<number | null>(null);
  const startupDecisionRef = useRef(false);
  const [motionDirection, setMotionDirection] = useState<"left" | "right" | null>(null);
  const [nextWakeAt, setNextWakeAt] = useState<number | null>(null);
  const [focusTimerEndsAt, setFocusTimerEndsAt] = useState<number | null>(null);
  const [focusTimer, setFocusTimer] = useState<CompanionFocusTimer | null>(null);
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [movementSettings, setMovementSettings] = useState<{
    allowMovement: boolean;
    autonomyPaused: boolean;
    autonomyLevel: CompanionAutonomyLevel;
  }>({ allowMovement: true, autonomyPaused: false, autonomyLevel: "balanced" });
  const movementAllowedRef = useRef(true);
  const pointerOverPetRef = useRef(false);
  const lastTimerCompletionRequestRef = useRef<number | null>(null);
  const lastDecisionIdRef = useRef<string | null>(null);
  const pointerDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);

  useEffect(() => () => {
    if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
  }, []);

  const react = useCallback(async (kind: string) => {
    overlaySequenceRef.current += 1;
    setOverlayEvent({ kind: "poke", key: `${kind}:${overlaySequenceRef.current}`, occurredAt: Date.now() });
    speechRequestRef.current += 1;
    const requestId = speechRequestRef.current;
    try {
      const context = buildCompanionInteractionContext({
        rhythm: workRhythm,
        session: sessionContext,
        runningTasks,
        personalTasks: preferences.todos,
        includeWorkContext: preferences.shareWorkContext,
      });
      const response = await fetch("/api/companion/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: kind === "double-click" ? "pet.double-click" : kind === "poke" ? "pet.click" : kind, cwd: sessionContext?.cwd, locale, context }),
      });
      const payload = await response.json().catch(() => null) as { decision?: { speech?: string; actions?: Array<{ kind?: string; direction?: "left" | "right"; distance?: number }> }; error?: string } | null;
      if (!response.ok || !payload?.decision) throw new Error(payload?.error || `HTTP ${response.status}`);
      if (requestId !== speechRequestRef.current) return;
      for (const action of payload.decision.actions ?? []) {
        if (action.kind === "walk" && movementAllowedRef.current && !pointerOverPetRef.current) {
          const wander = planCompanionWander({
            autonomyLevel: movementSettings.autonomyLevel,
            hasRunningTasks: runningTasks.length > 0,
          });
          const followsModelDirection = action.direction === "left" || action.direction === "right";
          void window.piDesktop?.moveCompanionWindow?.({
            kind: "walk",
            direction: action.direction ?? wander.direction,
            pattern: followsModelDirection ? "line" : wander.pattern,
            angleRadians: followsModelDirection
              ? action.direction === "left" ? Math.PI : 0
              : wander.angleRadians,
            curvature: wander.curvature,
            clockwise: wander.clockwise,
            distance: action.distance ?? wander.distance,
            durationMs: wander.durationMs,
          });
        }
        if (action.kind === "open-panel") void window.piDesktop?.companionAction?.("open-panel");
      }
    } catch {
      // The pet keeps its current animation when the model is unavailable; the
      // independent bubble surface must never be replaced by stale canned text.
    }
  }, [locale, movementSettings.autonomyLevel, preferences.shareWorkContext, preferences.todos, runningTasks, sessionContext, workRhythm]);

  useEffect(() => {
    const controller = new AbortController();
    const channel = createCompanionRuntimeChannel();
    let refreshPending = false;
    const applyState = (runtime: CompanionRuntimeState | null) => {
      if (runtime) publishCompanionRuntimeState(channel, runtime);
      setNextWakeAt(typeof runtime?.mind?.nextWakeAt === "number" ? runtime.mind.nextWakeAt : null);
      if (runtime?.settings) {
        const nextMovementSettings = {
          allowMovement: runtime.settings.allowMovement,
          autonomyPaused: runtime.settings.autonomyPaused,
          autonomyLevel: runtime.settings.autonomyLevel,
        };
        movementAllowedRef.current = nextMovementSettings.allowMovement;
        setMovementSettings((current) => (
          current.allowMovement === nextMovementSettings.allowMovement
          && current.autonomyPaused === nextMovementSettings.autonomyPaused
          && current.autonomyLevel === nextMovementSettings.autonomyLevel
            ? current
            : nextMovementSettings
        ));
      }
      const timer = runtime?.focusTimer;
      setFocusTimer(timer ?? null);
      setFocusTimerEndsAt(timer?.status === "running" && typeof timer.endsAt === "number" ? timer.endsAt : null);
      const decision = runtime?.mind?.lastDecision;
      if (!decision || decision.id === lastDecisionIdRef.current) return;
      lastDecisionIdRef.current = decision.id;
      if ((!decision.event.startsWith("timer.") && decision.event !== "todo.reminder") || Date.now() - decision.createdAt > 30_000) return;
      overlaySequenceRef.current += 1;
      setOverlayEvent({ kind: "poke", key: `timer:${overlaySequenceRef.current}`, occurredAt: decision.createdAt });
    };
    const refreshIfVisible = async () => {
      if (document.visibilityState === "hidden" || refreshPending) return;
      refreshPending = true;
      try { applyState(await fetchCompanionRuntimeState({ signal: controller.signal })); }
      catch { /* transient polling failures are retried on the next interval */ }
      finally { refreshPending = false; }
    };
    void refreshIfVisible();
    const pollTimer = window.setInterval(() => void refreshIfVisible(), COMPANION_RUNTIME_POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      controller.abort();
      window.clearInterval(pollTimer);
      document.removeEventListener("visibilitychange", refreshIfVisible);
      channel?.close();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const tick = async () => {
      if (pending) return;
      pending = true;
      try {
        await fetch("/api/companion/todos/remind", { method: "POST", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
      } catch { /* Retry on the next tick; reminders do not require an interaction model. */ }
      finally { pending = false; }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 30_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!runtimeReady || focusTimerEndsAt === null) return;
    let timeoutId: number | null = null;
    let cancelled = false;
    const requestCompletion = async () => {
      if (cancelled || lastTimerCompletionRequestRef.current === focusTimerEndsAt) return;
      lastTimerCompletionRequestRef.current = focusTimerEndsAt;
      try {
        const response = await fetch("/api/companion/focus-timer/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } catch {
        if (cancelled) return;
        lastTimerCompletionRequestRef.current = null;
        timeoutId = window.setTimeout(() => void requestCompletion(), 2_000);
      }
    };
    timeoutId = window.setTimeout(
      () => void requestCompletion(),
      Math.max(0, Math.min(2_147_000_000, focusTimerEndsAt - Date.now())),
    );
    return () => {
      cancelled = true;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [focusTimerEndsAt, runtimeReady]);

  useEffect(() => {
    if (!runtimeReady || !nextWakeAt) return;
    const delay = Math.max(1_000, Math.min(2_147_000_000, nextWakeAt - Date.now()));
    const timer = window.setTimeout(() => void react("scheduler.wake"), delay);
    return () => window.clearTimeout(timer);
  }, [nextWakeAt, react, runtimeReady]);

  useEffect(() => {
    if (!runtimeReady || startupDecisionRef.current) return;
    startupDecisionRef.current = true;
    void react("scheduler.startup");
  }, [react, runtimeReady]);

  useEffect(() => {
    if (!preferencesHydrated) return;
    const controller = new AbortController();
    void fetch("/api/companion/state", { cache: "no-store", signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((runtime: { migratedFromLocalStorage?: boolean } | null) => {
        if (!runtime) return;
        if (runtime.migratedFromLocalStorage) {
          setRuntimeReady(true);
          return;
        }
        return fetch("/api/companion/state", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ legacyPreferences: preferences }),
          signal: controller.signal,
        }).then((response) => { if (response.ok) setRuntimeReady(true); });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [preferences, preferencesHydrated]);

  useEffect(() => {
    document.documentElement.classList.add("desktop-pet-document");
    document.body.classList.add("desktop-pet-document");
    return () => {
      document.documentElement.classList.remove("desktop-pet-document");
      document.body.classList.remove("desktop-pet-document");
    };
  }, []);

  useEffect(() => {
    const update = () => {
      const pet = document.querySelector<HTMLElement>("[data-testid='companion-pet-viewport']");
      const rect = pet?.getBoundingClientRect();
      const region = rect && rect.width > 0 && rect.height > 0 && document.visibilityState === "visible"
        ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
      void window.piDesktop?.setCompanionHitTest?.(region).catch(() => {});
    };
    // Publish fresh local geometry even when the sprite moves under a stationary
    // cursor. The main process owns hit testing and expires stalled renderers.
    update();
    const timer = window.setInterval(update, 250);
    window.addEventListener("resize", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", update);
      document.removeEventListener("visibilitychange", update);
      void window.piDesktop?.setCompanionHitTest?.(null).catch(() => {});
    };
  }, []);

  useEffect(() => window.piDesktop?.onCompanionMotion?.((state) => {
    setMotionDirection(state.moving ? state.direction : null);
  }), []);

  useEffect(() => {
    const channel = new BroadcastChannel("pi-companion-runtime-v1");
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (!event.data || typeof event.data !== "object") return;
      const message = event.data as { type?: unknown; activity?: unknown; session?: unknown; rhythm?: unknown };
      if ((message.type !== "activity" && message.type !== "context") || !message.activity || typeof message.activity !== "object") return;
      const candidate = message.activity as CompanionActivity;
      if (["idle", "running", "waiting", "review", "failed"].includes(candidate.status)) setActivity(candidate);
      if (message.type === "context" && message.session && typeof message.session === "object") setSessionContext(message.session as CompanionSessionContext);
      if (message.type === "context" && message.rhythm && typeof message.rhythm === "object") setWorkRhythm(message.rhythm as CompanionWorkRhythm);
    };
    channel.postMessage({ type: "ready" });
    return () => channel.close();
  }, []);

  const taskBubbles = useMemo(() => runningTasks.map((snapshot) => {
    const presentation = deriveCompanionTaskPresentation(snapshot);
    const status = presentation.status;
    const progress = getTaskProgress(snapshot);
    return {
      id: snapshot.id,
      status,
      title: snapshot.title || snapshot.id.slice(0, 8),
      startedAt: snapshot.startedAt ?? 0,
      activityLabel: progress.label
        ? `${t(AGENT_ACTIVITY_LABELS[presentation.activityKind])} · ${progress.label}`
        : t(AGENT_ACTIVITY_LABELS[presentation.activityKind]),
      cause: snapshot.activity?.message
        || snapshot.errorSummary
        || t(`companion.activity.${status}Cause`),
    };
  }), [runningTasks, t]);

  useEffect(() => {
    const previous = previousTasksRef.current;
    const current = new Map(runningTasks.map((snapshot) => [snapshot.id, snapshot]));
    const failed = runningTasks.find((snapshot) => (
      snapshot.lastPromptFailed && !previous.get(snapshot.id)?.lastPromptFailed
    ));
    const completed = [...previous.values()].find((snapshot) => (
      snapshot.runtime !== "idle" && !current.has(snapshot.id)
    ));
    const started = runningTasks.find((snapshot) => (
      snapshot.runtime !== "idle" && !previous.has(snapshot.id)
    ));
    const kind = failed ? "failed" : completed ? "completed" : started ? "started" : null;
    const subject = failed ?? completed ?? started;

    previousTasksRef.current = current;
    if (!kind || !subject) return;
    runtimeEventSequenceRef.current += 1;
    const occurredAt = Date.now();
    setRuntimeEvent({
      kind,
      occurredAt,
      key: `${subject.id}:${runtimeEventSequenceRef.current}:${kind}:${occurredAt}`,
    });
    if (runtimeReady) void react(`task.${kind}`);
  }, [react, runningTasks, runtimeReady]);

  const runtimeEventKey = runtimeEvent?.key;
  const runtimeEventKind = runtimeEvent?.kind;

  const displayActivity = useMemo<CompanionActivity>(() => {
    const event = (activity.event?.occurredAt ?? 0) >= (runtimeEvent?.occurredAt ?? 0)
      ? activity.event
      : runtimeEvent;
    if (taskBubbles.length === 0 && (focusTimer?.status === "running" || focusTimer?.status === "paused")) {
      return {
        status: focusTimer.status === "running" ? "running" : "waiting",
        cause: t(`companion.focusTimer.${focusTimer.phase}`),
        ...(event ? { event } : {}),
      };
    }
    if (taskBubbles.length === 0) return { ...activity, ...(event ? { event } : {}) };

    const active = taskBubbles.find((item) => item.status === "review")
      ?? taskBubbles.find((item) => item.status === "failed")
      ?? taskBubbles.find((item) => item.id === activity.sessionId)
      ?? [...taskBubbles].sort((left, right) => right.startedAt - left.startedAt)[0];
    return {
      status: active?.status ?? "running",
      cause: active?.cause ?? t("companion.activity.runningCause"),
      ...(active ? { sessionId: active.id } : {}),
      ...(event ? { event } : {}),
    };
  }, [activity, focusTimer?.phase, focusTimer?.status, runtimeEvent, taskBubbles, t]);
  const statusLabel = t(`companion.activity.${displayActivity.status}`);
  const cause = displayActivity.cause || t(`companion.activity.${displayActivity.status}Cause`);
  const petLabel = activePet?.displayName ?? t("companion.builtinPet");
  const personalTaskBubbles = useMemo(() => preferences.todos
    .filter((task) => !task.completed)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 4)
    .map((task) => ({
      id: `personal:${task.id}`,
      status: "idle" as const,
      title: task.text,
      activityLabel: t("companion.personalTaskProgress", { progress: task.progress }),
      cause: task.project || t("companion.personalTaskCause"),
    })), [preferences.todos, t]);
  const bubbleItems = useMemo(() => {
    if (taskBubbles.length > 0) return taskBubbles;
    if (focusTimer?.status === "running" || focusTimer?.status === "paused") return [{
      id: "focus-timer",
      status: displayActivity.status,
      title: t(`companion.focusTimer.${focusTimer.phase}`),
      activityLabel: statusLabel,
      cause,
    }];
    if (personalTaskBubbles.length > 0) return personalTaskBubbles;
    if (displayActivity.status === "idle") return [];
    return [{
      id: "companion-status",
      status: displayActivity.status,
      title: statusLabel,
      activityLabel: statusLabel,
      cause,
    }];
  }, [cause, displayActivity.status, focusTimer?.phase, focusTimer?.status, personalTaskBubbles, statusLabel, taskBubbles, t]);
  const runningTaskCount = bubbleItems.length;
  const bubblesExpanded = bubbleItems.length > 0 && !bubblesCollapsed;

  const idleTricksEnabled = preferences.idleTricks !== false;

  useEffect(() => {
    if (bubbleItems.length === 0 || previousBubbleCountRef.current === 0) {
      setBubblesCollapsed(false);
    }
    previousBubbleCountRef.current = bubbleItems.length;
  }, [bubbleItems.length]);

  useEffect(() => {
    void window.piDesktop?.setCompanionWindowExpanded?.(bubblesExpanded);
  }, [bubblesExpanded]);

  useEffect(() => {
    const bridge = window.piDesktop?.moveCompanionWindow;
    if (!bridge || !runtimeEventKey) return;
    if (!movementSettings.allowMovement) {
      void bridge({ kind: "stop" });
      return;
    }
    if ((runtimeEventKind === "started" || runtimeEventKind === "completed") && !pointerOverPetRef.current) {
      const wander = planCompanionWander({
        autonomyLevel: movementSettings.autonomyLevel,
        hasRunningTasks: runtimeEventKind === "started",
      });
      void bridge({
        kind: "walk",
        direction: wander.direction,
        pattern: wander.pattern,
        angleRadians: wander.angleRadians,
        curvature: wander.curvature,
        clockwise: wander.clockwise,
        distance: runtimeEventKind === "started" ? Math.min(90, wander.distance) : Math.max(80, wander.distance),
        durationMs: wander.durationMs,
      });
    } else if (runtimeEventKind === "failed") {
      void bridge({ kind: "stop" });
    }
  }, [movementSettings.allowMovement, movementSettings.autonomyLevel, runtimeEventKey, runtimeEventKind]);

  useEffect(() => {
    const bridge = window.piDesktop?.moveCompanionWindow;
    if (!bridge) return;
    const movementBlocked = !runtimeReady
      || !movementSettings.allowMovement
      || movementSettings.autonomyPaused
      || displayActivity.status === "review"
      || displayActivity.status === "failed"
      || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (movementBlocked) {
      void bridge({ kind: "stop" });
      return;
    }

    let cancelled = false;
    let timer: number | null = null;
    const schedule = () => {
      const wander = planCompanionWander({
        autonomyLevel: movementSettings.autonomyLevel,
        hasRunningTasks: runningTasks.length > 0,
      });
      timer = window.setTimeout(() => {
        if (cancelled) return;
        if (wander.shouldMove && pointerDragRef.current === null && !pointerOverPetRef.current) {
          void bridge({
            kind: "walk",
            direction: wander.direction,
            pattern: wander.pattern,
            angleRadians: wander.angleRadians,
            curvature: wander.curvature,
            clockwise: wander.clockwise,
            distance: wander.distance,
            durationMs: wander.durationMs,
          });
        }
        schedule();
      }, wander.delayMs);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [
    displayActivity.status,
    movementSettings.allowMovement,
    movementSettings.autonomyLevel,
    movementSettings.autonomyPaused,
    runningTasks.length,
    runtimeReady,
  ]);

  useEffect(() => {
    if (displayActivity.status === "review" || displayActivity.status === "failed") {
      void window.piDesktop?.moveCompanionWindow?.({ kind: "stop" });
    }
  }, [displayActivity.status]);

  const endPointerDrag = useCallback((event: ReactPointerEvent<HTMLButtonElement>, cancelled: boolean) => {
    const drag = pointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    pointerDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    void window.piDesktop?.moveCompanionWindow?.({ kind: "drag-end" });
    if (!cancelled && !drag.moved) {
      if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = window.setTimeout(() => {
        clickTimerRef.current = null;
        void react("poke");
      }, 220);
    }
  }, [react]);

  const handlePetPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    pointerDragRef.current = {
      pointerId: event.pointerId,
      startX: event.screenX,
      startY: event.screenY,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    void window.piDesktop?.moveCompanionWindow?.({ kind: "drag-start" });
  }, []);

  const handlePetPointerEnter = useCallback(() => {
    pointerOverPetRef.current = true;
    void window.piDesktop?.moveCompanionWindow?.({ kind: "stop" });
  }, []);

  const handlePetPointerLeave = useCallback(() => {
    pointerOverPetRef.current = false;
  }, []);

  const handlePetPointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = pointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.screenX - drag.startX, event.screenY - drag.startY);
    if (!drag.moved && distance < PET_DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    void window.piDesktop?.moveCompanionWindow?.({ kind: "drag-move" });
  }, []);

  return (
    <main className={styles.window} aria-label={t("companion.desktopMode")} data-testid="desktop-companion-window">
      <div
        className={styles.dragSurface}
      >
        <div className={styles.activityBubbles} aria-live="polite" data-has-active-tasks={taskBubbles.length > 0}>
          {bubblesExpanded && bubbleItems.map((item) => (
            <div
              key={item.id}
              className={styles.activityBubble}
              data-testid="companion-activity-bubble"
              data-visible="true"
              data-kind={item.id === "companion-status" ? "status" : item.id.startsWith("personal:") ? "personal" : "task"}
              data-status={item.status}
              role="status"
            >
              <span className={styles.activityCopy}>
                <span className={styles.activityHeading}>
                  <strong>{item.title}</strong>
                  <small>{item.activityLabel}</small>
                </span>
                <span>{item.cause}</span>
              </span>
              <span
                className={styles.bubbleIndicator}
                aria-hidden="true"
                style={{ "--pet-status": COMPANION_ACTIVITY_COLORS[item.status] } as CSSProperties}
              />
            </div>
          ))}
        </div>
        <div className={styles.petStage} data-moving={motionDirection ?? undefined}>
          <div className={styles.petVisual} data-testid="companion-pet-visual" aria-hidden="true">
            {activePet
              ? <SpritePet
                  pet={activePet}
                  status={displayActivity.status}
                  event={displayActivity.event}
                  overlayEvent={overlayEvent ?? undefined}
                  idleTricks={idleTricksEnabled}
                  motionDirection={motionDirection}
                  onFrameChange={setVisibleFrameIndex}
                />
              : <BuiltinPet status={motionDirection ? "running" : displayActivity.status} />}
          </div>
          <button
            className={styles.pet}
            style={hitRegionStyle}
            type="button"
            data-testid="companion-pet-viewport"
            aria-label={`${petLabel} · ${statusLabel} · ${t("companion.pokeHint")}`}
            onPointerEnter={handlePetPointerEnter}
            onPointerLeave={handlePetPointerLeave}
            onPointerDown={handlePetPointerDown}
            onPointerMove={handlePetPointerMove}
            onPointerUp={(event) => endPointerDrag(event, false)}
            onPointerCancel={(event) => endPointerDrag(event, true)}
            onLostPointerCapture={(event) => endPointerDrag(event, true)}
            onDoubleClick={() => {
              if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
              clickTimerRef.current = null;
              void window.piDesktop?.companionAction?.("open-panel");
              void react("double-click");
            }}
          />
        </div>
        {bubbleItems.length > 0 ? (
          <button
            className={styles.bubbleToggle}
            type="button"
            onClick={() => setBubblesCollapsed(bubblesExpanded)}
            title={t(bubblesExpanded ? "i18n.collapse" : "i18n.expand")}
            aria-label={`${t(bubblesExpanded ? "i18n.collapse" : "i18n.expand")} · ${runningTaskCount}`}
            aria-expanded={bubblesExpanded}
          >
            {bubblesExpanded ? <span className={styles.chevron} aria-hidden="true" /> : runningTaskCount}
          </button>
        ) : null}
      </div>
    </main>
  );
}
