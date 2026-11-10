import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import lockfile from "proper-lockfile";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export class SessionOwnershipError extends Error {
  readonly code = "SESSION_IN_USE";
  constructor(message = "This conversation is open for writing in another Piora process. Close it there and retry.") {
    super(message); this.name = "SessionOwnershipError";
  }
}
/** Works across Jiti/native module instances, where instanceof is unreliable. */
export function isSessionOwnershipError(error: unknown): error is Error & { code: "SESSION_IN_USE" } {
  return typeof error === "object" && error !== null
    && "name" in error && error.name === "SessionOwnershipError"
    && "code" in error && error.code === "SESSION_IN_USE";
}
interface Record {
  references: number; compromised: boolean; release(): void;
  assertLease(): void;
  listeners: Set<() => void>;
}
const STALE_MS = 120_000;

function revoke(owner: Record): void {
  if (owner.compromised) return;
  owner.compromised = true;
  for (const listener of owner.listeners) { try { listener(); } catch { /* Ownership remains revoked. */ } }
}

function release(owner: Record): void {
  try { owner.release(); }
  catch (error) {
    if (!["ERELEASED", "ENOTACQUIRED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

/**
 * proper-lockfile's timer detects lost leases eventually. Synchronous writers
 * must also check immediately before writing, including after a paused process
 * resumes. Guard the library's heartbeat/unlink operations so an obsolete owner
 * cannot renew or remove a replacement directory before that timer runs.
 */
function guardedLockFs(path: string, owner: Record, staleMs: number): typeof fs {
  let identity: fs.BigIntStats | undefined;
  let renewedAt = performance.now();
  const check = () => {
    try {
      if (!identity || owner.compromised) throw new Error("Inactive lease");
      const current = fs.statSync(path, { bigint: true });
      if (current.dev !== identity.dev || current.ino !== identity.ino
        || current.birthtimeNs !== identity.birthtimeNs || current.mtimeNs !== identity.mtimeNs
        || Date.now() - Number(current.mtimeMs) > staleMs
        || performance.now() - renewedAt > staleMs) throw new Error("Changed or expired lease");
    } catch {
      revoke(owner);
      throw new SessionOwnershipError("Session write ownership was lost. Reopen this conversation before changing it.");
    }
  };
  owner.assertLease = check;
  // lockSync adapts these synchronous methods to callbacks, including for its
  // later heartbeat. A missing-lock error makes it stop that heartbeat at once.
  const libraryCheck = () => {
    try { check(); }
    catch { throw Object.assign(new Error("Session ownership is no longer active"), { code: "ENOENT" }); }
  };
  return {
    ...fs,
    mkdirSync: (file: string) => {
      fs.mkdirSync(file);
      if (file === path) {
        identity = fs.statSync(path, { bigint: true });
        renewedAt = performance.now();
      }
    },
    statSync: (file: string) => {
      if (file === path && identity) libraryCheck();
      return fs.statSync(file);
    },
    utimesSync: (file: string, atime: fs.TimeLike, mtime: fs.TimeLike) => {
      if (file === path && identity) libraryCheck();
      fs.utimesSync(file, atime, mtime);
      if (file === path && identity) {
        identity = fs.statSync(path, { bigint: true });
        renewedAt = performance.now();
      }
    },
    rmdirSync: (file: string) => {
      // Before our mkdir succeeds the library may remove a stale foreign lock.
      // Afterwards, including process-exit cleanup, remove only our live lease.
      if (file === path && identity) {
        try { check(); } catch { return; }
      }
      fs.rmdirSync(file);
    },
  } as typeof fs;
}
interface FileLeaseOptions { staleMs?: number; updateMs?: number }
export interface ExclusiveFileLease {
  /** Revalidate immediately before a synchronous operation, never across await. */
  assertOwned(): void;
  onCompromised(listener: () => void): () => void;
  release(): void;
}

function createExclusiveLeaseRecord(path: string, options: FileLeaseOptions): Record {
  const stale = options.staleMs ?? 10_000;
  const update = options.updateMs ?? stale / 2;
  if (!Number.isFinite(stale) || stale < 2_000 || !Number.isFinite(update) || update < 1_000 || update > stale / 2) {
    throw new RangeError("Invalid file lease heartbeat or expiry interval");
  }
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const owned: Record = { references: 0, compromised: false, release: () => {}, assertLease: () => {}, listeners: new Set() };
  // Each acquisition needs its own library key. Reusing a target lets an old
  // same-process release cancel the replacement's timer through its registry.
  owned.release = lockfile.lockSync(`${path}.${randomUUID()}.target`, {
    realpath: false, lockfilePath: path, stale, update, retries: 0,
    fs: guardedLockFs(path, owned, stale), onCompromised: () => revoke(owned),
  });
  try { owned.assertLease(); }
  catch (error) { release(owned); throw error; }
  return owned;
}

/**
 * Exclusive even within one process. ELOCKED means a caller may retry later.
 * The directory path stays compatible with existing proper-lockfile mutexes.
 * Like process ownership, this is a cooperative lease, not atomic OS fencing.
 */
export function acquireExclusiveFileLease(path: string, options: FileLeaseOptions = {}): ExclusiveFileLease {
  const owned = createExclusiveLeaseRecord(resolve(path), options);
  let released = false;
  return {
    assertOwned: () => {
      if (released) throw new SessionOwnershipError("File write ownership is no longer active.");
      owned.assertLease();
    },
    onCompromised: listener => {
      if (released) throw new SessionOwnershipError("File write ownership is no longer active.");
      owned.listeners.add(listener);
      if (owned.compromised) listener();
      return () => { owned.listeners.delete(listener); };
    },
    release: () => {
      if (released) return;
      released = true;
      owned.listeners.clear();
      release(owned);
    },
  };
}
declare global { var __pioraSessionFileOwners: Map<string, Record> | undefined }
export interface SessionFileOwnership {
  readonly sessionId: string;
  /** Call immediately before each synchronous write, with no intervening await. */
  assertOwned(): void;
  onCompromised(listener: () => void): () => void;
  release(): void;
}

export function sessionOwnershipPath(sessionId: string, root = getAgentDir()): string {
  return join(resolve(root), "piora", "session-owners", `${createHash("sha256").update(sessionId).digest("hex")}.lock`);
}

/**
 * One Piora process may own a session writer. Local runtime, sidecar and mutation
 * users retain the same owner; references release only after their writers end.
 * This is process ownership, not a replacement for per-operation state CAS.
 * It is a cooperative lease, not an OS fencing primitive: validation and the
 * subsequent file operation are separate syscalls. A caller must not retain a
 * successful assertion across asynchronous work or a long synchronous write.
 */
export function retainSessionFileOwnership(sessionId: string, root = getAgentDir()): SessionFileOwnership {
  if (!sessionId) throw new Error("Session ownership requires a session id");
  const path = sessionOwnershipPath(sessionId, root);
  const key = process.platform === "win32" ? path.toLowerCase() : path;
  const owners = globalThis.__pioraSessionFileOwners ??= new Map();
  let record = owners.get(key);
  if (!record) {
    try {
      record = createExclusiveLeaseRecord(path, { staleMs: STALE_MS, updateMs: 10_000 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw new SessionOwnershipError();
      throw error;
    }
    owners.set(key, record);
  }
  try { record.assertLease(); }
  catch (error) {
    if (record.references === 0) {
      if (owners.get(key) === record) owners.delete(key);
      release(record);
    }
    throw error;
  }
  record.references++;
  const shared = record, subscriptions = new Set<() => void>();
  let released = false;
  return {
    sessionId,
    assertOwned: () => {
      if (released || shared.compromised || owners.get(key) !== shared) throw new SessionOwnershipError("Session write ownership is no longer active.");
      shared.assertLease();
    },
    onCompromised: listener => {
      if (released) throw new SessionOwnershipError("Session write ownership is no longer active.");
      shared.listeners.add(listener); subscriptions.add(listener);
      if (shared.compromised) listener();
      return () => { shared.listeners.delete(listener); subscriptions.delete(listener); };
    },
    release: () => {
      if (released) return;
      released = true;
      for (const listener of subscriptions) shared.listeners.delete(listener);
      subscriptions.clear();
      if (--shared.references !== 0) return;
      if (owners.get(key) === shared) owners.delete(key);
      // Also stop the library timer after assertOwned discovered a lost lease.
      // The guarded rmdir never removes the replacement owner's directory.
      release(shared);
    },
  };
}

export async function withSessionFileOwnership<T>(sessionId: string, work: (owner: SessionFileOwnership) => T | Promise<T>, root = getAgentDir()): Promise<T> {
  const owner = retainSessionFileOwnership(sessionId, root);
  try { owner.assertOwned(); return await work(owner); }
  finally { owner.release(); }
}
