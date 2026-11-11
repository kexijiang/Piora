import type { SessionInfo } from "./types";

const PREFETCH_TTL_MS = 30_000;
const MAX_PREFETCH_CACHE_BYTES = 16 * 1024 * 1024;

interface PrefetchEntry {
  sessionId: string;
  modified: string;
  createdAt: number;
  lastAccessedAt: number;
  byteLength: number;
  settled: boolean;
  cancelOnLeave: boolean;
  controller: AbortController;
  promise: Promise<unknown | null>;
  data?: unknown | null;
}

const prefetchedSessions = new Map<string, PrefetchEntry>();
let activePrefetch: PrefetchEntry | null = null;
let cachedPrefetchBytes = 0;

function removePrefetch(entry: PrefetchEntry, abort = false): void {
  if (prefetchedSessions.get(entry.sessionId) !== entry) return;
  prefetchedSessions.delete(entry.sessionId);
  cachedPrefetchBytes = Math.max(0, cachedPrefetchBytes - entry.byteLength);
  if (abort && !entry.settled) entry.controller.abort();
  if (activePrefetch === entry) activePrefetch = null;
}

function prunePrefetchedSessions(now = Date.now()): void {
  for (const entry of prefetchedSessions.values()) {
    if (now - entry.createdAt >= PREFETCH_TTL_MS) removePrefetch(entry, true);
  }
  while (cachedPrefetchBytes > MAX_PREFETCH_CACHE_BYTES) {
    let oldest: PrefetchEntry | null = null;
    for (const candidate of prefetchedSessions) {
      const entry = candidate[1];
      if (!entry.settled || entry.byteLength === 0) continue;
      if (!oldest || entry.lastAccessedAt < oldest.lastAccessedAt) oldest = entry;
    }
    if (!oldest) break;
    removePrefetch(oldest);
  }
}

function createPrefetch(
  session: Pick<SessionInfo, "id" | "modified">,
  cancelOnLeave: boolean,
): PrefetchEntry {
  if (activePrefetch && activePrefetch.sessionId !== session.id) {
    removePrefetch(activePrefetch, true);
  }
  const createdAt = Date.now();
  const controller = new AbortController();
  const entry: PrefetchEntry = {
    sessionId: session.id,
    modified: session.modified,
    createdAt,
    lastAccessedAt: createdAt,
    byteLength: 0,
    settled: false,
    cancelOnLeave,
    controller,
    promise: Promise.resolve(null),
  };
  entry.promise = fetch(`/api/sessions/${encodeURIComponent(session.id)}?deferThinking=1&deferMedia=1`, {
    signal: controller.signal,
  })
      .then(async (response) => {
        if (!response.ok) return null;
        const raw = await response.text();
        if (controller.signal.aborted) return null;
        entry.byteLength = new Blob([raw]).size;
        cachedPrefetchBytes += entry.byteLength;
        const data = JSON.parse(raw) as { info?: { modified?: unknown } };
        entry.data = data;
        // Preserve the exact version returned by the server. If a task appended
        // after the sidebar snapshot, the fresher payload is safe to display but
        // will no longer match that stale sidebar version on a later switch.
        if (typeof data.info?.modified === "string") entry.modified = data.info.modified;
        return data;
      })
      .catch(() => null)
      .finally(() => {
        entry.settled = true;
        if (activePrefetch === entry) activePrefetch = null;
        prunePrefetchedSessions();
      });
  prunePrefetchedSessions(createdAt);
  prefetchedSessions.set(session.id, entry);
  activePrefetch = entry;
  void entry.promise.then((data) => {
    if (!data) removePrefetch(entry);
  });
  window.setTimeout(() => {
    removePrefetch(entry, true);
  }, PREFETCH_TTL_MS);
  return entry;
}

export function prefetchSession(
  session: Pick<SessionInfo, "id" | "modified">,
  options: { keepOnMouseLeave?: boolean } = {},
): void {
  prunePrefetchedSessions();
  if (
    activePrefetch
    && activePrefetch.sessionId !== session.id
    && !activePrefetch.cancelOnLeave
    && !options.keepOnMouseLeave
  ) {
    return;
  }
  const existing = prefetchedSessions.get(session.id);
  if (existing && existing.modified === session.modified && Date.now() - existing.createdAt < PREFETCH_TTL_MS) {
    existing.lastAccessedAt = Date.now();
    if (options.keepOnMouseLeave) existing.cancelOnLeave = false;
    return;
  }
  if (existing) removePrefetch(existing, true);
  void createPrefetch(session, !options.keepOnMouseLeave).promise;
}

export function cancelSessionPrefetch(sessionId: string): void {
  const entry = prefetchedSessions.get(sessionId);
  if (entry?.cancelOnLeave) removePrefetch(entry, true);
}

export function takePrefetchedSession(
  session: Pick<SessionInfo, "id" | "modified">,
): Promise<unknown | null> | null {
  prunePrefetchedSessions();
  const entry = prefetchedSessions.get(session.id);
  if (!entry || entry.modified !== session.modified || Date.now() - entry.createdAt >= PREFETCH_TTL_MS) {
    if (entry) removePrefetch(entry, true);
    return createPrefetch(session, false).promise;
  }
  entry.lastAccessedAt = Date.now();
  entry.cancelOnLeave = false;
  return entry.promise;
}

/** Prepare both history and runtime before replacing the visible chat. */
export async function prepareSessionSwitch(session: Pick<SessionInfo, "id" | "modified">): Promise<unknown | null> {
  const cached = Boolean(peekPrefetchedSession(session));
  const state = fetch(`/api/sessions/${encodeURIComponent(session.id)}/state`, { signal: AbortSignal.timeout(10_000), cache: "no-store" })
    .then(response => response.ok ? response.json() as Promise<{ running: boolean; state?: unknown }> : null).catch(() => null);
  const [preparedSnapshot, initialAgentState] = await Promise.all([takePrefetchedSession(session), state]);
  let snapshot = preparedSnapshot;
  // A background task may have started since a hover snapshot was captured.
  // Never mount that running conversation using its earlier idle history.
  if (cached && initialAgentState?.running) {
    invalidatePrefetchedSession(session.id);
    snapshot = await takePrefetchedSession(session);
  }
  if (snapshot && typeof snapshot === "object" && initialAgentState) Object.assign(snapshot, { initialAgentState });
  return snapshot;
}

/**
 * Returns a completed, version-matched switch snapshot without scheduling any
 * asynchronous work. This lets the newly mounted chat render its first frame
 * from the pointer/hover prefetch instead of flashing a full loading screen.
 */
export function peekPrefetchedSession(
  session: Pick<SessionInfo, "id" | "modified">,
): unknown | null {
  prunePrefetchedSessions();
  const entry = prefetchedSessions.get(session.id);
  if (
    !entry
    || !entry.settled
    || !entry.data
    || entry.modified !== session.modified
    || Date.now() - entry.createdAt >= PREFETCH_TTL_MS
  ) {
    return null;
  }
  entry.lastAccessedAt = Date.now();
  entry.cancelOnLeave = false;
  return entry.data;
}

export function invalidatePrefetchedSession(sessionId: string): void {
  const entry = prefetchedSessions.get(sessionId);
  if (entry) removePrefetch(entry, true);
}
