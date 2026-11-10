/** Server-side waits for a person to finish a browser step. Not an IPC call. */

import type { BrowserWaitPurpose } from "./browser-wait-policy";

export type BrowserUserWaitStatus = "continued" | "cancelled" | "timeout" | "aborted";

export const BROWSER_USER_WAIT_TIMEOUT_MS = 15 * 60 * 1000;

export const BROWSER_USER_WAIT_TEXT: Record<BrowserUserWaitStatus, string> = {
  continued: "Browser step completed. Take a new snapshot before continuing.",
  cancelled: "The user cancelled and did not complete the requested step. Do not assume the user is signed in or that the page is ready.",
  timeout: "The wait timed out and the user did not complete the requested step. Do not assume the user is signed in or that the page is ready.",
  aborted: "The wait was aborted because the session stopped. The user did not complete the requested step. Do not assume the user is signed in.",
};

/** Playwright (and a desktop bridge that falls back to it) cannot hand the page to the user. */
export const BROWSER_USER_WAIT_UNSUPPORTED_TEXT = "The user cannot take over the browser in this mode. Do not assume the user is signed in. Explain the situation to the user in chat.";

export interface BrowserUserWaitSnapshot {
  sessionId: string;
  toolCallId: string;
  reason: string;
  startedAt: number;
  backend: "desktop" | "playwright";
  purpose?: BrowserWaitPurpose;
}

interface WaitEntry extends BrowserUserWaitSnapshot {
  resolve: (status: BrowserUserWaitStatus) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort: () => void;
  checkTimer?: ReturnType<typeof setTimeout>;
}

interface WaitState {
  waits: Map<string, WaitEntry>;
  outcomes?: Map<string, { toolCallId: string; status: BrowserUserWaitStatus; endedAt: number; purpose?: BrowserWaitPurpose }>;
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
  const outcomes = state().outcomes ??= new Map();
  outcomes.delete(entry.sessionId);
  outcomes.set(entry.sessionId, { toolCallId: entry.toolCallId, status, endedAt: Date.now(), ...(entry.purpose ? { purpose: entry.purpose } : {}) });
  while (outcomes.size > 500) outcomes.delete(outcomes.keys().next().value!);
  clearTimeout(entry.timer);
  clearTimeout(entry.checkTimer);
  entry.signal?.removeEventListener("abort", entry.onAbort);
  entry.resolve(status);
}

export function readBrowserUserWaitOutcome(sessionId: string) {
  return state().outcomes?.get(sessionId) ?? null;
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
    ...(entry.purpose ? { purpose: entry.purpose } : {}),
  };
}

export function noteBrowserUserWaitBackend(sessionId: string, backend: "desktop" | "playwright"): void {
  const entry = state().waits.get(sessionId);
  if (entry) entry.backend = backend;
}

export function resolveBrowserUserWait(sessionId: string, decision: "continue" | "cancel", toolCallId: string): boolean {
  const entry = state().waits.get(sessionId);
  if (!entry || entry.toolCallId !== toolCallId) return false;
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
  purpose?: BrowserWaitPurpose;
  checkCompletion?: () => Promise<boolean>;
  checkIntervalMs?: number;
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
      ...(input.purpose ? { purpose: input.purpose } : {}),
      resolve,
      timer: setTimeout(() => settle(entry, "timeout"), timeoutMs),
      onAbort: () => settle(entry, "aborted"),
      ...(input.signal ? { signal: input.signal } : {}),
    };
    // node:test treats an unref'd timer as an empty event loop and cancels the
    // wait. Production still must not keep the process alive for this timer.
    if (!process.env.NODE_TEST_CONTEXT) entry.timer.unref?.();
    state().waits.set(input.sessionId, entry);
    input.signal?.addEventListener("abort", entry.onAbort, { once: true });
    // Only one read-only check at a time. Late checks cannot settle a replacement wait.
    if (input.purpose === "login" && input.checkCompletion) {
      const check = async () => {
        if (state().waits.get(entry.sessionId) !== entry) return;
        let completed = false;
        try { completed = await input.checkCompletion!(); } catch { /* Navigation can temporarily destroy the document. */ }
        if (state().waits.get(entry.sessionId) !== entry) return;
        if (completed) { settle(entry, "continued"); return; }
        entry.checkTimer = setTimeout(() => void check(), input.checkIntervalMs ?? 1000);
        if (!process.env.NODE_TEST_CONTEXT) entry.checkTimer.unref?.();
      };
      void check();
    }
  });
}
