import { retainSessionFileOwnership, type SessionFileOwnership } from "./session-file-ownership.ts";

// Shared across hot reloads. A file mutation must exclude new runtime work.
declare global {
  var __pioraSessionMutations: Set<string> | undefined;
  var __pioraSessionFileOperations: Map<string, Set<Promise<unknown>>> | undefined;
  var __pioraSessionShutdowns: Map<string, Set<Promise<unknown>>> | undefined;
}

/** Finish file creators admitted before a deletion lock before moving their files. */
export async function runSessionFileOperation<T>(id: string, work: (owner: SessionFileOwnership) => Promise<T>, root?: string): Promise<T> {
  assertSessionNotMutating(id);
  const owner = retainSessionFileOwnership(id, root);
  return trackSessionFileOperation(id, Promise.resolve().then(() => {
    owner.assertOwned();
    return work(owner);
  }).finally(() => owner.release()));
}

/** Shutdown remains a file writer even after its wrapper leaves the live registry. */
export async function trackSessionFileOperation<T>(id: string, task: Promise<T>): Promise<T> {
  const registry = globalThis.__pioraSessionFileOperations ??= new Map();
  const pending = registry.get(id) ?? new Set<Promise<unknown>>();
  registry.set(id, pending);
  pending.add(task);
  try { return await task; }
  finally {
    pending.delete(task);
    if (!pending.size && registry.get(id) === pending) registry.delete(id);
  }
}

export async function drainSessionFileOperations(ids: readonly string[]): Promise<void> {
  // Finishing a fork can enqueue shutdown after the first snapshot was taken.
  for (;;) {
    const pending = ids.flatMap((id) => [...(globalThis.__pioraSessionFileOperations?.get(id) ?? [])]);
    if (!pending.length) return;
    await Promise.allSettled(pending);
  }
}

/** A retired runtime can still write while its asynchronous shutdown finishes. */
export async function trackSessionShutdown(id: string, task: Promise<void>): Promise<void> {
  const registry = globalThis.__pioraSessionShutdowns ??= new Map();
  const pending = registry.get(id) ?? new Set<Promise<unknown>>();
  registry.set(id, pending); pending.add(task);
  try { await trackSessionFileOperation(id, task); }
  finally { pending.delete(task); if (!pending.size && registry.get(id) === pending) registry.delete(id); }
}

/** Safe inside an admitted file operation: never waits for that operation itself. */
export async function drainSessionShutdown(id: string): Promise<void> {
  for (;;) {
    const pending = [...(globalThis.__pioraSessionShutdowns?.get(id) ?? [])];
    if (!pending.length) return;
    await Promise.allSettled(pending);
  }
}

export function assertSessionNotMutating(id: string): void {
  if (globalThis.__pioraSessionMutations?.has(id)) {
    throw new Error("This conversation is being moved to the recycle bin. Try again after it finishes.");
  }
}

export type SessionMutationRelease = (() => void) & { assertOwned(): void };
export function acquireSessionMutation(ids: readonly string[], root?: string): SessionMutationRelease {
  const locks = globalThis.__pioraSessionMutations ??= new Set();
  const unique = [...new Set(ids)].sort();
  for (const id of unique) assertSessionNotMutating(id);
  const owners: SessionFileOwnership[] = [];
  try { for (const id of unique) owners.push(retainSessionFileOwnership(id, root)); }
  catch (error) { for (const owner of owners.reverse()) owner.release(); throw error; }
  for (const id of unique) locks.add(id);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const id of unique) locks.delete(id);
    for (const owner of owners.reverse()) owner.release();
  };
  return Object.assign(release, { assertOwned: () => {
    if (released) throw new Error("Session mutation has already finished");
    for (const owner of owners) owner.assertOwned();
  } });
}

export function collectSessionSubtree<T extends { id: string; parentSessionId?: string }>(sessions: T[], id: string): T[] {
  return collectSessionSubtrees(sessions, [id]);
}

export function collectSessionSubtrees<T extends { id: string; parentSessionId?: string }>(sessions: T[], ids: readonly string[]): T[] {
  const children = new Map<string, T[]>();
  const byId = new Map(sessions.map((session) => [session.id, session]));
  for (const session of sessions) {
    if (!session.parentSessionId) continue;
    const siblings = children.get(session.parentSessionId) ?? [];
    siblings.push(session);
    children.set(session.parentSessionId, siblings);
  }
  const queue = [...ids];
  const seen = new Set<string>();
  const result: T[] = [];
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    if (seen.has(current)) continue;
    seen.add(current);
    const session = byId.get(current);
    if (session) result.push(session);
    for (const child of children.get(current) ?? []) queue.push(child.id);
  }
  return result;
}
