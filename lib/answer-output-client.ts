/** Optional answer modules register durable writes without coupling chat to their runtime. */
const writers = new Map<string, { sessionId: string; flush: () => Promise<void> }>();
let enabled = true;

/** Suspending an optional capability retains its recovery drafts without blocking ordinary chat. */
export function setAnswerStateEnabled(value: boolean): void { enabled = value; }
export function isAnswerStateEnabled(): boolean { return enabled; }

export function registerAnswerStateWriter(key: string, sessionId: string, flush: () => Promise<void>): () => void {
  const writer = { sessionId, flush };
  writers.set(key, writer);
  return () => { if (writers.get(key) === writer) writers.delete(key); };
}

/** A failed save blocks dependent sends so the model never receives a stale state silently. */
export async function flushPendingAnswerState(sessionId?: string): Promise<void> {
  if (!enabled) return;
  await Promise.all([...writers.values()].filter(writer => !sessionId || writer.sessionId === sessionId).map(writer => writer.flush()));
}
