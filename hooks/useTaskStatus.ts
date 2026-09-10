"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  deriveTaskStatus,
  type RunningSessionsPayload,
  type Runtime,
  type TaskRuntimeSnapshot,
  type TaskStatus,
} from "@/lib/task-status";

interface UseTaskStatusOptions {
  sessionId: string;
  archived?: boolean;
  isViewing?: boolean;
  hasUnreadResult?: boolean;
  fallbackRuntime?: Runtime;
}

const runtimeBySession = new Map<string, TaskRuntimeSnapshot>();
const snapshotSignatures = new Map<string, string>();
const sessionListeners = new Map<string, Set<() => void>>();
const storeListeners = new Set<() => void>();
let runtimeStoreState: { ready: boolean; snapshots: TaskRuntimeSnapshot[] } = { ready: false, snapshots: [] };
let pollController: AbortController | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let visibilityBound = false;

function listenerCount(): number {
  let count = storeListeners.size;
  for (const listeners of sessionListeners.values()) count += listeners.size;
  return count;
}

function emitChange(changedSessionIds: Set<string>): void {
  for (const sessionId of changedSessionIds) {
    for (const listener of sessionListeners.get(sessionId) ?? []) listener();
  }
  for (const listener of storeListeners) listener();
}

function applyPayload(payload: Partial<RunningSessionsPayload>): void {
  const incoming = new Map<string, TaskRuntimeSnapshot>();
  if (Array.isArray(payload.runningSessions)) {
    for (const session of payload.runningSessions) {
      if (!session || typeof session.id !== "string") continue;
      incoming.set(session.id, session);
    }
  } else {
    for (const id of payload.runningSessionIds ?? []) {
      incoming.set(id, {
        id,
        runtime: "running",
        pendingApproval: false,
        lastPromptFailed: false,
      });
    }
  }

  const changedSessionIds = new Set<string>();
  const next = new Map<string, TaskRuntimeSnapshot>();
  const nextSignatures = new Map<string, string>();
  for (const [id, snapshot] of incoming) {
    const signature = JSON.stringify(snapshot);
    nextSignatures.set(id, signature);
    if (snapshotSignatures.get(id) === signature) {
      next.set(id, runtimeBySession.get(id) ?? snapshot);
    } else {
      next.set(id, snapshot);
      changedSessionIds.add(id);
    }
  }
  for (const id of runtimeBySession.keys()) {
    if (!next.has(id)) changedSessionIds.add(id);
  }
  if (runtimeStoreState.ready && changedSessionIds.size === 0) return;

  runtimeBySession.clear();
  for (const [id, session] of next) runtimeBySession.set(id, session);
  snapshotSignatures.clear();
  for (const [id, signature] of nextSignatures) snapshotSignatures.set(id, signature);
  runtimeStoreState = {
    ready: true,
    snapshots: [...runtimeBySession.values()].sort((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0)),
  };
  emitChange(changedSessionIds);
}

async function pollSnapshot(): Promise<void> {
  if (pollController || listenerCount() === 0 || document.visibilityState !== "visible") return;
  const controller = new AbortController();
  pollController = controller;
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch("/api/agent/running", { cache: "no-store", signal: controller.signal });
    if (response.ok) {
      const payload = await response.json() as RunningSessionsPayload;
      if (!controller.signal.aborted) applyPayload(payload);
    }
  } catch {
    // The next visible poll retries transient failures.
  } finally {
    clearTimeout(timeout);
    if (pollController === controller) {
      pollController = null;
      schedulePoll();
    }
  }
}

function schedulePoll(): void {
  if (pollTimer !== null || listenerCount() === 0 || document.visibilityState !== "visible") return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void pollSnapshot();
  }, 2_500);
}

function stopPolling(): void {
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = null;
  pollController?.abort();
  pollController = null;
}

function connect(): void {
  if (typeof window === "undefined" || listenerCount() === 0) return;
  // Reserve persistent HTTP/1 connections for actual chat/shell output. Each
  // desktop window otherwise holds a status SSE slot even while idle.
  if (!visibilityBound) {
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("online", handleVisibilityChange);
    visibilityBound = true;
    void pollSnapshot();
  }
}

function disconnect(): void {
  if (listenerCount() > 0) return;
  stopPolling();
  if (visibilityBound) {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("online", handleVisibilityChange);
    visibilityBound = false;
  }
}

function handleVisibilityChange(): void {
  stopPolling();
  if (document.visibilityState === "visible") void pollSnapshot();
}

function subscribeStore(listener: () => void): () => void {
  storeListeners.add(listener);
  connect();
  return () => {
    storeListeners.delete(listener);
    disconnect();
  };
}

function subscribeSession(sessionId: string, listener: () => void): () => void {
  const listeners = sessionListeners.get(sessionId) ?? new Set<() => void>();
  listeners.add(listener);
  sessionListeners.set(sessionId, listeners);
  connect();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) sessionListeners.delete(sessionId);
    disconnect();
  };
}

function getRuntimeStoreState(): typeof runtimeStoreState {
  return runtimeStoreState;
}

export function useRunningTaskSnapshots(): TaskRuntimeSnapshot[] {
  return useSyncExternalStore(subscribeStore, getRuntimeStoreState, getRuntimeStoreState).snapshots;
}

export function useRunningTaskRuntimeState(): typeof runtimeStoreState {
  return useSyncExternalStore(subscribeStore, getRuntimeStoreState, getRuntimeStoreState);
}

export function useTaskStatus({
  sessionId,
  archived = false,
  isViewing = false,
  hasUnreadResult = false,
  fallbackRuntime = "idle",
}: UseTaskStatusOptions): TaskStatus {
  const subscribe = useCallback(
    (listener: () => void) => subscribeSession(sessionId, listener),
    [sessionId],
  );
  const getSnapshot = useCallback(() => runtimeBySession.get(sessionId) ?? null, [sessionId]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => null);
  const runtime = snapshot?.runtime ?? fallbackRuntime;
  const runningIds = runtime === "running" || runtime === "stopping" ? new Set([sessionId]) : new Set<string>();
  const compactingIds = runtime === "compacting" ? new Set([sessionId]) : new Set<string>();
  const pendingApprovalIds = snapshot?.pendingApproval ? new Set([sessionId]) : new Set<string>();

  const status = deriveTaskStatus({
    sessionId,
    runningIds,
    compactingIds,
    pendingApprovalIds,
    lastPromptFailed: snapshot?.lastPromptFailed ?? false,
    hasUnreadResult,
    archived,
    isViewing,
    taskRun: snapshot?.taskRun,
  });
  const statusWithStartedAt = {
    ...status,
    ...(snapshot?.startedAt !== undefined ? { startedAt: snapshot.startedAt } : {}),
  };
  return runtime === "stopping" ? { ...statusWithStartedAt, runtime: "stopping" } : statusWithStartedAt;
}
