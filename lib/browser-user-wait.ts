/** Server-side waits for a person to finish a browser step. Not an IPC call. */

export type BrowserUserWaitStatus = "continued" | "cancelled" | "timeout" | "aborted";

export const BROWSER_USER_WAIT_TIMEOUT_MS = 15 * 60 * 1000;

export const BROWSER_USER_WAIT_TEXT: Record<BrowserUserWaitStatus, string> = {
  continued: "User reported done. Take a new snapshot before continuing.",
  cancelled: "The user cancelled and did not complete the requested step. Do not assume the user is signed in or that the page is ready.",
  timeout: "The wait timed out and the user did not complete the requested step. Do not assume the user is signed in or that the page is ready.",
  aborted: "The wait was aborted because the session stopped. The user did not complete the requested step. Do not assume the user is signed in.",
};

export interface BrowserUserWaitSnapshot {
  sessionId: string;
  toolCallId: string;
  reason: string;
  startedAt: number;
  backend: "desktop" | "playwright";
}

interface WaitEntry extends BrowserUserWaitSnapshot {
  resolve: (status: BrowserUserWaitStatus) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort: () => void;
}

interface WaitState {
  waits: Map<string, WaitEntry>;
}

const root = globalThis as typeof globalThis & { __pioraBrowserUserWait?: WaitState };

function state(): WaitState {
  if (!root.__pioraBrowserUserWait) root.__pioraBrowserUserWait = { waits: new Map() };
  return root.__pioraBrowserUserWait;
}

function settle(entry: WaitEntry, status: BrowserUserWaitStatus): void {
  const current = state().waits.get(entry.sessionId);
  if (current !== entry) return;
  state().waits.delete(entry.sessionId);
  clearTimeout(entry.timer);
  entry.signal?.removeEventListener("abort", entry.onAbort);
  entry.resolve(status);
}

export function readBrowserUserWait(sessionId: string): BrowserUserWaitSnapshot | null {
  const entry = state().waits.get(sessionId);
  if (!entry) return null;
  return {
    sessionId: entry.sessionId,
    toolCallId: entry.toolCallId,
    reason: entry.reason,
    startedAt: entry.startedAt,
    backend: entry.backend,
  };
}

export function noteBrowserUserWaitBackend(sessionId: string, backend: "desktop" | "playwright"): void {
  const entry = state().waits.get(sessionId);
  if (entry) entry.backend = backend;
}

export function resolveBrowserUserWait(sessionId: string, decision: "continue" | "cancel"): boolean {
  const entry = state().waits.get(sessionId);
  if (!entry) return false;
  settle(entry, decision === "continue" ? "continued" : "cancelled");
  return true;
}

export function waitForUser(input: {
  sessionId: string;
  toolCallId: string;
  reason: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  backend?: "desktop" | "playwright";
}): Promise<BrowserUserWaitStatus> {
  if (input.signal?.aborted) return Promise.resolve("aborted");
  const previous = state().waits.get(input.sessionId);
  if (previous) settle(previous, "cancelled");
  const timeoutMs = input.timeoutMs ?? BROWSER_USER_WAIT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const entry: WaitEntry = {
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      reason: input.reason,
      startedAt: Date.now(),
      backend: input.backend ?? "playwright",
      resolve,
      timer: setTimeout(() => settle(entry, "timeout"), timeoutMs),
      onAbort: () => settle(entry, "aborted"),
      ...(input.signal ? { signal: input.signal } : {}),
    };
    entry.timer.unref?.();
    state().waits.set(input.sessionId, entry);
    input.signal?.addEventListener("abort", entry.onAbort, { once: true });
  });
}
