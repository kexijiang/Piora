"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type SetStateAction } from "react";
import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import type { NormalizedCompanionHitRegion } from "@/lib/companion-hit-region";
import { useI18n } from "@/hooks/useI18n";
import type { CompanionPet as CompanionPetMetadata } from "@/lib/companion-pets";
import {
  advanceCompanionAnimation,
  getCompanionAnimationFrameIndices,
  getCompanionAtlasFramePosition,
  prepareCompanionPersistentAnimation,
  prepareCompanionTransientAnimation,
  selectCompanionSpriteState,
  selectCompanionTransientSpriteState,
  type CompanionActivity,
  type CompanionActivityEvent,
} from "@/lib/companion";
import {
  isCompanionInteractionKind,
  pickCompanionIdleTrickStateId,
  pickCompanionInteractionStateId,
} from "@/lib/companion-behavior";
import type { CompanionPreferences } from "@/lib/companion-store";
import { STATUS_PRESENTATION, type TaskStatusPresentationKey } from "@/lib/task-status";
import styles from "./CompanionPet.module.css";
import { AliIcon } from "./AliIcon";
import { CompanionDataManager } from "./CompanionDataManager";

const ModelPet = dynamic(() => import("./CompanionModelPet"), { ssr: false });

export function PetRenderer(props: ComponentProps<typeof SpritePet> & {
  dragging?: boolean;
  onHitRegionChange?: (region: NormalizedCompanionHitRegion) => void;
}) {
  return props.pet.model3d
    ? <ModelPet key={props.pet.sourceKey} {...props} model={props.pet.model3d} />
    : <SpritePet {...props} />;
}

type RenderableAnimationState = {
  id: string;
  frameIndices?: readonly number[];
  durationsMs?: readonly number[];
  loopStart?: number | null;
  fallback?: string;
  frames?: number;
  row?: number | null;
};

type RenderablePet = Omit<CompanionPetMetadata, "states"> & {
  frame?: { width: number; height: number; columns: number; rows: number };
  states: RenderableAnimationState[];
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activity: CompanionActivity;
  canSendPhrase: boolean;
  onSendPhrase: (text: string) => boolean;
  preferences: CompanionPreferences;
  setPreferences: Dispatch<SetStateAction<CompanionPreferences>>;
  activePet: CompanionPetMetadata | null;
  onRequestSpeech?: () => Promise<string>;
}

const COMPANION_STATUS_KEYS: Record<CompanionActivity["status"], TaskStatusPresentationKey> = {
  idle: "unread",
  running: "running",
  waiting: "needs_input",
  review: "needs_approval",
  failed: "failed",
};

export const COMPANION_ACTIVITY_COLORS: Record<CompanionActivity["status"], string> = Object.fromEntries(
  Object.entries(COMPANION_STATUS_KEYS).map(([activity, key]) => [
    activity,
    `var(${STATUS_PRESENTATION[key].colorVar})`,
  ]),
) as Record<CompanionActivity["status"], string>;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

export function BuiltinPet({ status }: { status: CompanionActivity["status"] }) {
  return (
    <div className={styles.builtinPet} data-status={status} aria-hidden="true">
      <div className={styles.builtinPetMotion}>
        <span className={styles.builtinPetArt} />
      </div>
    </div>
  );
}

const MIN_TRICK_DELAY_MS = 18_000;
const MAX_TRICK_EXTRA_DELAY_MS = 24_000;

export function SpritePet({
  pet,
  status,
  event,
  overlayEvent,
  idleTricks = false,
  motionDirection = null,
  onFrameChange,
}: {
  pet: CompanionPetMetadata;
  status: CompanionActivity["status"];
  event?: CompanionActivityEvent;
  /** One-shot user-driven poke reaction; wins over runtime events. */
  overlayEvent?: CompanionActivityEvent;
  /** Play a random trick every now and then while the pet is idle. */
  idleTricks?: boolean;
  /** Physical desktop-window movement takes priority over in-place activity. */
  motionDirection?: "left" | "right" | null;
  /** Lets the desktop surface align its hit target to the visible sprite frame. */
  onFrameChange?: (frameIndex: number) => void;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const renderablePet = pet as unknown as RenderablePet;
  const grid = renderablePet.frame ?? {
    width: pet.frameWidth,
    height: pet.frameHeight,
    columns: pet.columns,
    rows: pet.rows,
  };
  const selectedBaseAnimation = useMemo(
    () => {
      if (motionDirection) {
        const directionalIds = motionDirection === "right"
          ? ["move_right", "running-right"]
          : ["move_left", "running-left"];
        const directional = directionalIds
          .map((id) => renderablePet.states.find((state) => state.id === id))
          .find(Boolean);
        if (directional) return directional;
      }
      return selectCompanionSpriteState(renderablePet.states, status);
    },
    [motionDirection, renderablePet.states, status],
  );
  const idleAnimation = useMemo(
    () => renderablePet.states.find((state) => state.id === "idle") ?? null,
    [renderablePet.states],
  );
  const baseAnimation = useMemo(
    () => selectedBaseAnimation
      ? prepareCompanionPersistentAnimation(
          selectedBaseAnimation,
          idleAnimation,
          motionDirection ? "running" : status,
        )
      : null,
    [idleAnimation, motionDirection, selectedBaseAnimation, status],
  );
  const eventKey = event?.key;
  const eventKind = event?.kind;
  const selectedTransientAnimation = useMemo(
    () => eventKind ? selectCompanionTransientSpriteState(renderablePet.states, eventKind) : null,
    [eventKind, renderablePet.states],
  );
  const transientAnimation = useMemo(() => {
    if (reducedMotion || !eventKey || !selectedTransientAnimation || !baseAnimation) return null;
    return {
      ...prepareCompanionTransientAnimation(selectedTransientAnimation, idleAnimation, baseAnimation.id),
      id: `${selectedTransientAnimation.id}::${eventKey}`,
    };
  }, [baseAnimation, eventKey, idleAnimation, reducedMotion, selectedTransientAnimation]);
  const [completedEventKey, setCompletedEventKey] = useState<string | null>(null);
  const pendingTransientAnimation = eventKey !== completedEventKey ? transientAnimation : null;

  const overlayKey = overlayEvent?.key;
  const overlayKind = isCompanionInteractionKind(overlayEvent?.kind) ? overlayEvent?.kind : null;
  const stateIds = useMemo(() => renderablePet.states.map((state) => state.id), [renderablePet.states]);
  const lastReactionStateIdRef = useRef<string | null>(null);
  const lastTrickStateIdRef = useRef<string | null>(null);
  const trickSequenceRef = useRef(0);
  const selectedOverlayAnimationState = useMemo(() => {
    if (!overlayKind) return null;
    const picked = pickCompanionInteractionStateId(stateIds, overlayKind, lastReactionStateIdRef.current);
    lastReactionStateIdRef.current = picked;
    return picked;
    // Re-runs once per interaction key; the picked state must follow the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlayKey, overlayKind, stateIds]);
  const overlayAnimation = useMemo(() => {
    if (reducedMotion || !overlayKey || !selectedOverlayAnimationState || !baseAnimation) return null;
    const state = renderablePet.states.find((entry) => entry.id === selectedOverlayAnimationState);
    if (!state) return null;
    return {
      ...prepareCompanionTransientAnimation(state, idleAnimation, baseAnimation.id),
      id: `${state.id}::${overlayKey}`,
    };
  }, [baseAnimation, idleAnimation, overlayKey, reducedMotion, renderablePet.states, selectedOverlayAnimationState]);
  const [completedOverlayKey, setCompletedOverlayKey] = useState<string | null>(null);
  const pendingOverlayAnimation = overlayKey && overlayKey !== completedOverlayKey ? overlayAnimation : null;

  // Idle tricks keep the pet lively while nothing is happening. They lose to
  // runtime events and user interactions and are dropped when those arrive.
  const [trick, setTrick] = useState<{ key: string; stateId: string } | null>(null);
  const [completedTrickKey, setCompletedTrickKey] = useState<string | null>(null);
  const pendingTrickAnimation = useMemo(() => {
    if (reducedMotion || !trick || trick.key === completedTrickKey || !baseAnimation) return null;
    const state = renderablePet.states.find((entry) => entry.id === trick.stateId);
    if (!state) return null;
    return {
      ...prepareCompanionTransientAnimation(state, idleAnimation, baseAnimation.id),
      id: `${state.id}::${trick.key}`,
    };
  }, [baseAnimation, completedTrickKey, idleAnimation, reducedMotion, renderablePet.states, trick]);

  const requestedAnimation = pendingOverlayAnimation ?? pendingTransientAnimation ?? pendingTrickAnimation ?? baseAnimation;
  const [animation, setAnimation] = useState<RenderableAnimationState | null>(requestedAnimation);
  const [frameOffset, setFrameOffset] = useState(0);
  const [failed, setFailed] = useState(false);
  const frameCount = Math.max(1, grid.columns * grid.rows);
  const frameIndices = getCompanionAnimationFrameIndices(animation, grid.columns, frameCount);

  useEffect(() => {
    setAnimation(requestedAnimation);
    setFrameOffset(0);
  }, [pet.atlasUrl, reducedMotion, requestedAnimation]);

  useEffect(() => {
    setFailed(false);
  }, [pet.atlasUrl]);

  useEffect(() => {
    if (reducedMotion || !animation || frameIndices.length === 0) return;
    const durations = animation.durationsMs;
    const timeout = window.setTimeout(() => {
      // Older Piora imports predate explicit loop metadata and were all
      // looping row animations. The normalized contract always supplies
      // loopStart (number or null), so undefined is the legacy-only case.
      const loopStart = animation.loopStart === undefined ? 0 : animation.loopStart;
      const next = advanceCompanionAnimation(frameOffset, frameIndices.length, loopStart);
      if (next !== null) {
        setFrameOffset(next);
        return;
      }
      if (pendingOverlayAnimation && animation.id === pendingOverlayAnimation.id && overlayKey) {
        setCompletedOverlayKey(overlayKey);
        setAnimation(baseAnimation);
        setFrameOffset(0);
        return;
      }
      if (pendingTransientAnimation && animation.id === pendingTransientAnimation.id && eventKey) {
        setCompletedEventKey(eventKey);
        setAnimation(baseAnimation);
        setFrameOffset(0);
        return;
      }
      if (pendingTrickAnimation && animation.id === pendingTrickAnimation.id && trick) {
        setCompletedTrickKey(trick.key);
        setAnimation(baseAnimation);
        setFrameOffset(0);
        return;
      }
      const fallback = renderablePet.states.find((state) => state.id === animation.fallback);
      if (fallback && fallback.id !== animation.id) {
        setAnimation(fallback.id === baseAnimation?.id ? baseAnimation : fallback);
        setFrameOffset(0);
      }
    }, Math.max(60, durations?.[frameOffset] ?? 150));
    return () => window.clearTimeout(timeout);
  }, [animation, baseAnimation, eventKey, frameIndices.length, frameOffset, overlayKey, pendingOverlayAnimation, pendingTransientAnimation, pendingTrickAnimation, reducedMotion, renderablePet.states, trick]);

  const idleTrickCapable = useMemo(
    () => pickCompanionIdleTrickStateId(stateIds) !== null,
    [stateIds],
  );

  // A higher-priority one-shot (runtime event or user interaction) cancels any
  // trick that is mid-flight so the pet never resumes a stale joke.
  useEffect(() => {
    if (pendingOverlayAnimation || pendingTransientAnimation) setTrick(null);
  }, [pendingOverlayAnimation, pendingTransientAnimation]);

  useEffect(() => {
    if (!idleTricks || reducedMotion || status !== "idle" || !idleTrickCapable) return;
    if (pendingOverlayAnimation || pendingTransientAnimation || pendingTrickAnimation) return;
    const delay = MIN_TRICK_DELAY_MS + Math.random() * MAX_TRICK_EXTRA_DELAY_MS;
    const timer = window.setTimeout(() => {
      const stateId = pickCompanionIdleTrickStateId(stateIds, lastTrickStateIdRef.current);
      if (!stateId) return;
      lastTrickStateIdRef.current = stateId;
      trickSequenceRef.current += 1;
      setTrick({ key: `trick:${trickSequenceRef.current}`, stateId });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [idleTrickCapable, idleTricks, pendingOverlayAnimation, pendingTransientAnimation, pendingTrickAnimation, reducedMotion, stateIds, status]);

  const absoluteFrame = frameIndices.length > 0
    ? frameIndices[reducedMotion ? 0 : Math.min(frameOffset, frameIndices.length - 1)]
    : 0;
  useEffect(() => {
    if (pet.atlasUrl && animation && frameIndices.length > 0 && !failed) onFrameChange?.(absoluteFrame);
  }, [absoluteFrame, animation, failed, frameIndices.length, onFrameChange, pet.atlasUrl]);

  if (!pet.atlasUrl || !animation || frameIndices.length === 0 || failed) return <BuiltinPet status={status} />;
  const framePosition = getCompanionAtlasFramePosition(grid.columns, grid.rows, absoluteFrame);
  const frameRatio = Math.max(0.01, grid.width / grid.height);
  const viewportRatio = 82 / 89;
  const fittedSize = frameRatio >= viewportRatio
    ? { width: "100%", height: `${(viewportRatio / frameRatio) * 100}%` }
    : { width: `${(frameRatio / viewportRatio) * 100}%`, height: "100%" };
  return (
    <>
      {/* A hidden probe gives us a reliable broken-asset fallback. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={pet.atlasUrl} alt="" hidden onError={() => setFailed(true)} />
      <div
        className={styles.sprite}
        data-testid="companion-sprite-frame"
        aria-hidden="true"
        style={{
          ...fittedSize,
          backgroundImage: `url(${JSON.stringify(pet.atlasUrl).slice(1, -1)})`,
          backgroundSize: `${grid.columns * 100}% ${grid.rows * 100}%`,
          backgroundPosition: `${framePosition.xPercent}% ${framePosition.yPercent}%`,
        }}
      />
    </>
  );
}

export function CompanionPet({
  open,
  onOpenChange,
  activity,
  canSendPhrase,
  onSendPhrase,
  preferences,
  setPreferences,
  activePet,
  onRequestSpeech,
}: Props) {
  const { t } = useI18n();
  const [helpOpen, setHelpOpen] = useState(false);
  const [pokeEvent, setPokeEvent] = useState<CompanionActivityEvent | null>(null);
  const [petSpeech, setPetSpeech] = useState("");
  const petSpeechTimerRef = useRef<number | null>(null);
  const pokeSequenceRef = useRef(0);
  const speechRequestRef = useRef(0);

  useEffect(() => () => {
    if (petSpeechTimerRef.current !== null) window.clearTimeout(petSpeechTimerRef.current);
  }, []);

  const pokePet = async () => {
    pokeSequenceRef.current += 1;
    setPokeEvent({ kind: "poke", key: `poke:${pokeSequenceRef.current}`, occurredAt: Date.now() });
    speechRequestRef.current += 1;
    const requestId = speechRequestRef.current;
    setPetSpeech(onRequestSpeech ? t("companion.speech.generating") : t("companion.speech.modelRequired"));
    if (!onRequestSpeech) return;
    try {
      const line = await onRequestSpeech();
      if (requestId !== speechRequestRef.current) return;
      setPetSpeech(line || t("companion.speech.empty"));
    } catch {
      if (requestId !== speechRequestRef.current) return;
      setPetSpeech(t("companion.speech.failed"));
    }
    if (petSpeechTimerRef.current !== null) window.clearTimeout(petSpeechTimerRef.current);
    petSpeechTimerRef.current = window.setTimeout(() => setPetSpeech(""), 7_000);
  };
  const statusLabel = t(`companion.activity.${activity.status}`);

  if (!open) return null;

  return (
    <aside className={styles.dock} aria-label={t("companion.title")} data-testid="companion-dock">
      <div className={styles.header}>
        <button
          className={styles.petViewport}
          type="button"
          data-testid="companion-dock-pet"
          onClick={() => { void pokePet(); }}
          title={t("companion.pokeHint")}
          aria-label={t("companion.pokeHint")}
        >
          {activePet
            ? <PetRenderer
                pet={activePet}
                status={activity.status}
                event={activity.event}
                overlayEvent={pokeEvent ?? undefined}
                idleTricks={preferences.idleTricks !== false}
              />
            : <BuiltinPet status={activity.status} />}
        </button>
        <div className={styles.activityCopy} aria-live="polite">
          <div className={styles.activityRow}>
            <span className={styles.activityDot} style={{ "--activity-color": COMPANION_ACTIVITY_COLORS[activity.status] } as CSSProperties} />
            <span>{statusLabel}</span>
          </div>
          {petSpeech || (activity.status !== "idle" && activity.cause)
            ? <div className={styles.activityCause}>{petSpeech || activity.cause}</div>
            : null}
        </div>
        <div className={styles.headerActions}>
          <button className={styles.iconButton} type="button" onClick={() => setHelpOpen((open) => !open)} title={t("companion.howToUse")} aria-label={t("companion.howToUse")} aria-expanded={helpOpen}>
            <AliIcon name="info" size={15} />
          </button>
          <button className={styles.iconButton} type="button" onClick={() => onOpenChange(false)} title={t("companion.close")} aria-label={t("companion.close")}>
            <AliIcon name="close" size={15} />
          </button>
        </div>
      </div>

      {helpOpen && (
        <div className={styles.helpPanel} role="note">
          <div className={styles.helpTitle}>{t("companion.howToUse")}</div>
          <ul>
            <li>{t("companion.helpStatus")}</li>
            <li>{t("companion.helpTodos")}</li>
            <li>{t("companion.helpPhrases")}</li>
          </ul>
        </div>
      )}

      <div className={styles.workspace}>
        <CompanionDataManager
          compact
          preferences={preferences}
          setPreferences={setPreferences}
          canSendPhrase={canSendPhrase}
          onSendPhrase={onSendPhrase}
        />
      </div>

    </aside>
  );
}
