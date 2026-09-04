export type CompanionActivityStatus = "idle" | "running" | "waiting" | "review" | "failed";

/**
 * "started"/"completed"/"failed" come from the Pi runtime. The remaining kinds
 * are a user-driven poke plus the renderer-local idle trick, and they
 * only ever select a one-shot reaction animation.
 */
export type CompanionActivityEventKind =
  | "started" | "completed" | "failed"
  | "poke" | "trick";

export interface CompanionActivityEvent {
  kind: CompanionActivityEventKind;
  key: string;
  occurredAt: number;
}

export interface CompanionActivity {
  status: CompanionActivityStatus;
  cause: string;
  sessionId?: string;
  runId?: number;
  event?: CompanionActivityEvent;
}

export interface CompanionActivityInput {
  error?: string | null;
  hasErrorNotice?: boolean;
  hasReviewRequest?: boolean;
  isBusy?: boolean;
  isCompacting?: boolean;
  phase?: "waiting_model" | "running_command" | "running_tools" | "stopping" | null;
}

const SPRITE_STATE_FALLBACKS: Record<CompanionActivityStatus, readonly string[]> = {
  idle: ["idle"],
  running: ["running", "running-right", "running-left", "jumping", "idle"],
  waiting: ["waiting", "look-directions-a", "idle"],
  review: ["review", "waving", "look-directions-b", "idle"],
  failed: ["failed", "idle"],
};

const TRANSIENT_SPRITE_STATE_FALLBACKS: Record<CompanionActivityEventKind, readonly string[]> = {
  started: ["waving", "wave", "jumping", "bounce", "running", "idle"],
  completed: ["jumping", "bounce", "waving", "wave", "idle"],
  failed: ["failed", "sad", "idle"],
  poke: ["jumping", "bounce", "look-directions-a", "waving", "idle"],
  trick: ["waving", "jumping", "look-directions-a", "look-directions-b", "idle"],
};

export interface CompanionAnimationTimeline {
  id: string;
  frameIndices?: readonly number[];
  durationsMs?: readonly number[];
  loopStart?: number | null;
  fallback?: string;
}

/**
 * Maps Pi runtime signals to a deliberately small presentation state. This is
 * display-only: it never creates or controls another agent.
 */
export function deriveCompanionActivityStatus(input: CompanionActivityInput): CompanionActivityStatus {
  if (input.error || input.hasErrorNotice) return "failed";
  if (input.hasReviewRequest) return "review";
  if (input.isBusy && input.phase === "waiting_model") return "waiting";
  if (input.isBusy || input.isCompacting) return "running";
  return "idle";
}

export function canSendCompanionPhrase(activity: CompanionActivityStatus, hasActiveChat: boolean): boolean {
  return hasActiveChat && activity === "idle";
}

export function selectCompanionSpriteState<T extends { id: string }>(
  states: readonly T[],
  activity: CompanionActivityStatus,
): T | null {
  for (const id of SPRITE_STATE_FALLBACKS[activity]) {
    const match = states.find((state) => state.id === id);
    if (match) return match;
  }
  return states[0] ?? null;
}

export function selectCompanionTransientSpriteState<T extends { id: string }>(
  states: readonly T[],
  event: CompanionActivityEventKind,
): T | null {
  for (const id of TRANSIENT_SPRITE_STATE_FALLBACKS[event]) {
    const match = states.find((state) => state.id === id);
    if (match) return match;
  }
  return states[0] ?? null;
}

function appendedIdleStart(
  animation: CompanionAnimationTimeline,
  idle: CompanionAnimationTimeline | null,
): number | null {
  if (!idle?.frameIndices?.length || !animation.frameIndices?.length) return null;
  if (!Number.isInteger(animation.loopStart) || (animation.loopStart ?? 0) <= 0) return null;
  const start = animation.loopStart as number;
  const tail = animation.frameIndices.slice(start);
  if (tail.length !== idle.frameIndices.length) return null;
  return tail.every((frame, index) => frame === idle.frameIndices?.[index]) ? start : null;
}

function shortestRepeatingPrefixLength(frames: readonly number[]): number {
  for (let length = 1; length <= frames.length; length += 1) {
    if (frames.length % length !== 0) continue;
    if (frames.every((frame, index) => frame === frames[index % length])) return length;
  }
  return frames.length;
}

/**
 * Adapts the older Codex-compatible "action x3, then idle forever" timeline
 * to Piora's persistent task states. Custom timelines without that exact idle
 * suffix keep their declared loop contract.
 */
export function prepareCompanionPersistentAnimation<T extends CompanionAnimationTimeline>(
  animation: T,
  idle: CompanionAnimationTimeline | null,
  activity: CompanionActivityStatus,
): T {
  if (activity === "failed" && idle) {
    // Failure is announced by a transient sad animation; keep the persistent
    // state calm while the status color and error copy remain visible.
    return { ...animation, ...idle };
  }

  const idleStart = appendedIdleStart(animation, idle);
  if (idleStart === null) return animation;

  if (activity === "running" || activity === "waiting") {
    const actionFrames = animation.frameIndices?.slice(0, idleStart) ?? [];
    const cycleLength = shortestRepeatingPrefixLength(actionFrames);
    return {
      ...animation,
      frameIndices: actionFrames.slice(0, cycleLength),
      durationsMs: animation.durationsMs?.slice(0, cycleLength),
      loopStart: 0,
    };
  }

  if (activity === "review") {
    // Replay the full action-plus-rest sequence as a low-frequency reminder.
    return { ...animation, loopStart: 0 };
  }

  return animation;
}

/** Builds a single short action cycle before returning to the persistent state. */
export function prepareCompanionTransientAnimation<T extends CompanionAnimationTimeline>(
  animation: T,
  idle: CompanionAnimationTimeline | null,
  fallback: string,
): T {
  const idleStart = appendedIdleStart(animation, idle);
  const actionFrames = idleStart === null
    ? [...(animation.frameIndices ?? [])]
    : animation.frameIndices?.slice(0, idleStart) ?? [];
  const cycleLength = shortestRepeatingPrefixLength(actionFrames);
  return {
    ...animation,
    frameIndices: actionFrames.slice(0, cycleLength),
    durationsMs: animation.durationsMs?.slice(0, cycleLength),
    loopStart: null,
    fallback,
  };
}

export function getCompanionFramePosition(
  columns: number,
  rows: number,
  frame: number,
  row: number,
): { xPercent: number; yPercent: number } {
  const safeColumns = Math.max(1, Math.floor(columns));
  const safeRows = Math.max(1, Math.floor(rows));
  const safeFrame = Math.min(safeColumns - 1, Math.max(0, Math.floor(frame)));
  const safeRow = Math.min(safeRows - 1, Math.max(0, Math.floor(row)));
  return {
    xPercent: safeColumns > 1 ? (safeFrame / (safeColumns - 1)) * 100 : 0,
    yPercent: safeRows > 1 ? (safeRow / (safeRows - 1)) * 100 : 0,
  };
}

export function getCompanionAtlasFramePosition(
  columns: number,
  rows: number,
  absoluteIndex: number,
): { xPercent: number; yPercent: number; column: number; row: number } {
  const safeColumns = Math.max(1, Math.floor(columns));
  const safeRows = Math.max(1, Math.floor(rows));
  const frameCount = safeColumns * safeRows;
  const safeIndex = Math.min(frameCount - 1, Math.max(0, Math.floor(absoluteIndex)));
  const column = safeIndex % safeColumns;
  const row = Math.floor(safeIndex / safeColumns);
  return { ...getCompanionFramePosition(safeColumns, safeRows, column, row), column, row };
}

export function getCompanionAnimationFrameIndices(
  state: { frameIndices?: readonly number[]; row?: number | null; frames?: number } | null,
  columns: number,
  frameCount: number,
): number[] {
  if (!state) return [];
  const safeFrameCount = Math.max(0, Math.floor(frameCount));
  if (Array.isArray(state.frameIndices) && state.frameIndices.length > 0) {
    return state.frameIndices.filter((index) => (
      Number.isInteger(index) && index >= 0 && index < safeFrameCount
    ));
  }
  if (!Number.isInteger(state.row) || (state.row ?? -1) < 0) return [];
  const safeColumns = Math.max(1, Math.floor(columns));
  const count = Math.min(safeColumns, Math.max(0, Math.floor(state.frames ?? 0)));
  const start = Math.floor(state.row as number) * safeColumns;
  return Array.from({ length: count }, (_, offset) => start + offset)
    .filter((index) => index < safeFrameCount);
}

/** Returns null when a non-looping animation has completed. */
export function advanceCompanionAnimation(
  frameOffset: number,
  frameLength: number,
  loopStart: number | null | undefined,
): number | null {
  const safeLength = Math.max(0, Math.floor(frameLength));
  if (safeLength === 0) return null;
  const next = Math.max(0, Math.floor(frameOffset)) + 1;
  if (next < safeLength) return next;
  if (Number.isInteger(loopStart) && (loopStart as number) >= 0 && (loopStart as number) < safeLength) {
    return loopStart as number;
  }
  return null;
}
