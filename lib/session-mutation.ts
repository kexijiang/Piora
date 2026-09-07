// Shared across hot reloads. A file mutation must exclude new runtime work.
declare global {
  var __pioraSessionMutations: Set<string> | undefined;
  var __pioraSessionFileOperations: Map<string, Set<Promise<unknown>>> | undefined;
}

/** Finish file creators admitted before a deletion lock before moving their files. */
export async function runSessionFileOperation<T>(id: string, work: () => Promise<T>): Promise<T> {
  assertSessionNotMutating(id);
  return trackSessionFileOperation(id, Promise.resolve().then(work));
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

export function assertSessionNotMutating(id: string): void {
  if (globalThis.__pioraSessionMutations?.has(id)) {
    throw new Error("This conversation is being moved to the recycle bin. Try again after it finishes.");
  }
}

export function acquireSessionMutation(ids: readonly string[]): () => void {
  const locks = globalThis.__pioraSessionMutations ??= new Set();
  for (const id of ids) assertSessionNotMutating(id);
  for (const id of ids) locks.add(id);
  return () => { for (const id of ids) locks.delete(id); };
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
