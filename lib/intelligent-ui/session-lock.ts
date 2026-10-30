import { join } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { assertSessionNotMutating, runSessionFileOperation, trackSessionFileOperation } from "../session-mutation";
import { acquireExclusiveFileLease, SessionOwnershipError, type ExclusiveFileLease } from "../session-file-ownership";

export function uiSessionLockPath(sessionId: string, root = getAgentDir()): string {
  return join(root, "piora", "intelligent-ui", `session-${createHash("sha256").update(sessionId).digest("hex")}.lock`);
}
export async function withUiFileLock<T>(path: string, work: (assertOwned: () => void) => T | Promise<T>): Promise<T> {
  let lease: ExclusiveFileLease;
  for (let attempt = 0; ; attempt++) {
    try { lease = acquireExclusiveFileLease(path); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
      if (attempt >= 40) throw new SessionOwnershipError("UI state is busy in another operation. Retry after it finishes.");
      await delay(Math.min(5 * 2 ** attempt, 100));
    }
  }
  try {
    lease.assertOwned();
    const value = await work(lease.assertOwned);
    lease.assertOwned();
    return value;
  } finally { lease.release(); }
}
/**
 * Required order: process ownership -> session -> legacy state -> journal.
 * Register the whole operation so deletion drains it before moving any files.
 */
export function withUiSessionLock<T>(sessionId: string, root: string, work: (assertOwned: () => void) => T | Promise<T>): Promise<T> {
  return runSessionFileOperation(sessionId, owner => withUiFileLock(uiSessionLockPath(sessionId, root), assertLockOwned => {
    assertSessionNotMutating(sessionId);
    const assertOwned = () => { owner.assertOwned(); assertLockOwned(); };
    assertOwned();
    return work(assertOwned);
  }), root);
}

/** Read snapshots share the operation mutex without taking a writer lease. */
export async function withUiSessionReadLock<T>(sessionId: string, root: string, work: (assertOwned: () => void) => T | Promise<T>): Promise<T> {
  assertSessionNotMutating(sessionId);
  return trackSessionFileOperation(sessionId, withUiFileLock(uiSessionLockPath(sessionId, root), assertOwned => {
    assertSessionNotMutating(sessionId);
    return work(assertOwned);
  }));
}

/** A host mutation already owns admission and has drained old runtime writers. */
export function withUiSessionMutationLock<T>(sessionId: string, root: string, owner: { assertOwned(): void }, work: (assertOwned: () => void) => T | Promise<T>): Promise<T> {
  owner.assertOwned();
  return trackSessionFileOperation(sessionId, withUiFileLock(uiSessionLockPath(sessionId, root), assertLockOwned => {
    const assertOwned = () => { owner.assertOwned(); assertLockOwned(); };
    assertOwned(); return work(assertOwned);
  }));
}
