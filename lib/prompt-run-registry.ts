import { randomUUID } from "node:crypto";
import type { SessionMessageSourceKind, SessionRoomContext } from "./session-message-types";

export type PromptRunFinishReason = "idle" | "error" | "abort" | "destroy" | "fork";

export interface PromptRunIdentity {
  sessionId: string;
  runId: string;
  source?: SessionMessageSourceKind;
  roomContext?: SessionRoomContext;
}

export interface PromptToolIdentity extends PromptRunIdentity {
  toolCallId: string;
}

type PromptRunCleanup = (reason: PromptRunFinishReason) => void | Promise<void>;

interface PromptRunRecord extends PromptRunIdentity {
  startedAt: number;
  cleanups: Set<PromptRunCleanup>;
}

declare global {
  var __pioraPromptRuns: Map<string, PromptRunRecord> | undefined;
  var __pioraDesktopUpdateLease: { token: string; expiresAt: number } | undefined;
}

/** Synchronous admission fence between the final idle check and desktop shutdown. */
export function acquireDesktopUpdateLease(): string | undefined {
  if (getRuns().size > 0 || (globalThis.__pioraDesktopUpdateLease?.expiresAt ?? 0) > Date.now()) return undefined;
  const token = randomUUID();
  globalThis.__pioraDesktopUpdateLease = { token, expiresAt: Date.now() + 120_000 };
  return token;
}
export function releaseDesktopUpdateLease(token: string): void {
  if (globalThis.__pioraDesktopUpdateLease?.token === token) globalThis.__pioraDesktopUpdateLease = undefined;
}

function getRuns(): Map<string, PromptRunRecord> {
  return globalThis.__pioraPromptRuns ??= new Map();
}

export function beginPromptRun(
  sessionId: string,
  context: { source?: SessionMessageSourceKind; roomContext?: SessionRoomContext } = {},
): PromptRunIdentity {
  if ((globalThis.__pioraDesktopUpdateLease?.expiresAt ?? 0) > Date.now()) {
    throw new Error("Piora is installing an update. Retry after the application reopens.");
  }
  if (!sessionId) throw new Error("Cannot begin a prompt run without a session id.");
  const runs = getRuns();
  if (runs.has(sessionId)) {
    throw new Error(`Session ${sessionId} already has an active prompt run.`);
  }
  const record: PromptRunRecord = {
    sessionId,
    runId: randomUUID(),
    ...(context.source ? { source: context.source } : {}),
    ...(context.roomContext ? { roomContext: context.roomContext } : {}),
    startedAt: Date.now(),
    cleanups: new Set(),
  };
  runs.set(sessionId, record);
  return {
    sessionId,
    runId: record.runId,
    ...(record.source ? { source: record.source } : {}),
    ...(record.roomContext ? { roomContext: record.roomContext } : {}),
  };
}

export function getActivePromptRun(sessionId: string): PromptRunIdentity | undefined {
  const record = getRuns().get(sessionId);
  return record ? {
    sessionId: record.sessionId,
    runId: record.runId,
    ...(record.source ? { source: record.source } : {}),
    ...(record.roomContext ? { roomContext: record.roomContext } : {}),
  } : undefined;
}

export function getActivePromptRunStartedAt(sessionId: string): number | undefined {
  return getRuns().get(sessionId)?.startedAt;
}

export function requirePromptToolIdentity(sessionId: string, toolCallId: string): PromptToolIdentity {
  if (!toolCallId) throw new Error("Harmony tool execution is missing its tool-call identity.");
  const run = getRuns().get(sessionId);
  if (!run) {
    throw new Error(`Harmony tool execution is not attached to an active prompt run for session ${sessionId}.`);
  }
  return { sessionId, runId: run.runId, toolCallId };
}

export function registerPromptRunCleanup(
  identity: PromptRunIdentity,
  cleanup: PromptRunCleanup,
): () => void {
  const run = getRuns().get(identity.sessionId);
  if (!run || run.runId !== identity.runId) {
    throw new Error(`Prompt run ${identity.runId} is no longer active.`);
  }
  run.cleanups.add(cleanup);
  return () => { run.cleanups.delete(cleanup); };
}

export async function finishPromptRun(
  identity: PromptRunIdentity | undefined,
  reason: PromptRunFinishReason,
): Promise<void> {
  if (!identity) return;
  const runs = getRuns();
  const record = runs.get(identity.sessionId);
  if (!record || record.runId !== identity.runId) return;

  // Delete before cleanup so no late tool call can renew or acquire a lease
  // while the run is being torn down.
  runs.delete(identity.sessionId);
  const failures: unknown[] = [];
  for (const cleanup of record.cleanups) {
    try {
      await cleanup(reason);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    console.error(`[pi-web] ${failures.length} prompt-run cleanup operation(s) failed for ${identity.runId}.`);
  }
}

export function resetPromptRunRegistryForTests(): void {
  getRuns().clear();
  globalThis.__pioraDesktopUpdateLease = undefined;
}
