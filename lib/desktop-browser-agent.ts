import { randomUUID } from "node:crypto";

export const DESKTOP_AGENT_BRIDGE_UNAVAILABLE = "Desktop browser bridge unavailable.";
export const DESKTOP_EVALUATE_DISABLED = "evaluate is disabled on the desktop browser and needs user confirmation.";
const SERVER_TIMEOUT_MS = 45_000;

export class DesktopAgentBridgeUnavailable extends Error {
  constructor(message = DESKTOP_AGENT_BRIDGE_UNAVAILABLE) {
    super(message);
    this.name = "DesktopAgentBridgeUnavailable";
  }
}

export function isDesktopBridgeUnavailable(error: unknown): boolean {
  return error instanceof DesktopAgentBridgeUnavailable
    || (error instanceof Error && error.message === DESKTOP_AGENT_BRIDGE_UNAVAILABLE);
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abort: () => void;
};

type BridgeState = {
  pending: Map<string, Pending>;
  reported: "desktop" | "playwright" | null;
};

const state = globalThis as typeof globalThis & { __pioraDesktopAgentBrowser?: BridgeState };

export function hasDesktopAgentBridge(): boolean {
  return process.env.PIORA_DESKTOP_NETWORK_IPC === "1"
    && typeof process.send === "function"
    && process.connected === true;
}

function bridgeState(): BridgeState {
  if (!state.__pioraDesktopAgentBrowser) {
    const bucket: BridgeState = { pending: new Map(), reported: null };
    state.__pioraDesktopAgentBrowser = bucket;
    process.on("message", (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const response = message as { type?: unknown; requestId?: unknown; ok?: unknown; value?: unknown; error?: unknown };
      if (response.type !== "pi-desktop:browser-agent-response" || typeof response.requestId !== "string") return;
      const pending = bucket.pending.get(response.requestId);
      if (!pending) return;
      bucket.pending.delete(response.requestId);
      clearTimeout(pending.timer);
      if (response.ok === true) pending.resolve(response.value);
      else {
        const error = typeof response.error === "string" ? response.error : "Desktop browser request failed";
        pending.reject(isDesktopBridgeUnavailable(new Error(error)) ? new DesktopAgentBridgeUnavailable(error) : new Error(error));
      }
    });
  }
  return state.__pioraDesktopAgentBrowser;
}

export interface DesktopAgentCall {
  sessionId: string;
  action: string;
  signal?: AbortSignal;
  tabId?: string;
  url?: string;
  selector?: string;
  ref?: string;
  text?: string;
  key?: string;
  submit?: boolean;
  deltaX?: number;
  deltaY?: number;
  x?: number;
  y?: number;
  tabIndex?: number;
  fullPage?: boolean;
  reason?: string;
  confirmed?: boolean;
}

/** The server sets confirmed only after the user accepts this call. */
export function desktopEvaluateRequest(input: { hasUI: boolean; userConfirmed: boolean }): { confirmed: true } | { error: string } {
  if (input.hasUI === true && input.userConfirmed === true) return { confirmed: true };
  return { error: DESKTOP_EVALUATE_DISABLED };
}

export async function runBrowserBackend<T>(input: {
  desktop: boolean;
  runDesktop: () => Promise<T>;
  runPlaywright: () => Promise<T>;
  onBackend?: (backend: "desktop" | "playwright") => void;
}): Promise<{ backend: "desktop" | "playwright"; value: T }> {
  if (input.desktop) {
    try {
      const value = await input.runDesktop();
      input.onBackend?.("desktop");
      return { backend: "desktop", value };
    } catch (error) {
      if (!isDesktopBridgeUnavailable(error)) throw error;
    }
  }
  input.onBackend?.("playwright");
  return { backend: "playwright", value: await input.runPlaywright() };
}

export function callDesktopAgentBrowser(input: DesktopAgentCall): Promise<unknown> {
  if (!hasDesktopAgentBridge()) return Promise.reject(new DesktopAgentBridgeUnavailable());
  const pendingRequests = bridgeState().pending;
  const requestId = randomUUID();
  const payload: Record<string, unknown> = {
    type: "pi-desktop:browser-agent-request",
    requestId,
    sessionId: input.sessionId,
    action: input.action,
  };
  for (const key of ["tabId", "url", "selector", "ref", "text", "key", "submit", "deltaX", "deltaY", "x", "y", "tabIndex", "fullPage", "reason", "confirmed"] as const) {
    const value = input[key];
    if (value !== undefined) payload[key] = value;
  }
  return new Promise((resolve, reject) => {
    if (input.signal?.aborted) {
      notifyIdleAfterAbort(input);
      reject(new Error("Browser action aborted"));
      return;
    }
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      const pending = pendingRequests.get(requestId);
      pendingRequests.delete(requestId);
      if (pending) clearTimeout(pending.timer);
      input.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => {
      try { process.send?.({ type: "pi-desktop:browser-agent-cancel", requestId }); } catch { /* The bridge is already gone. */ }
      notifyIdleAfterAbort(input);
      finish(new Error("Browser action aborted"));
    };
    const timer = setTimeout(() => {
      try { process.send?.({ type: "pi-desktop:browser-agent-cancel", requestId }); } catch { /* The bridge is already gone. */ }
      finish(new Error("Desktop browser agent request timed out"));
    }, SERVER_TIMEOUT_MS);
    timer.unref?.();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    pendingRequests.set(requestId, { resolve: (value) => finish(undefined, value), reject: (error) => finish(error), timer, abort: onAbort });
    const sent = process.send?.(payload, (error: Error | null) => {
      if (!error) return;
      finish(isDesktopBridgeUnavailable(error) ? error : new DesktopAgentBridgeUnavailable(error.message || DESKTOP_AGENT_BRIDGE_UNAVAILABLE));
    });
    if (sent === false) finish(new DesktopAgentBridgeUnavailable());
  });
}

export function notifyDesktopAgentBackend(backend: "desktop" | "playwright"): void {
  if (!hasDesktopAgentBridge()) return;
  const bucket = bridgeState();
  if (bucket.reported === backend) return;
  bucket.reported = backend;
  try { process.send?.({ type: "pi-desktop:browser-agent-backend", backend }); } catch { /* The bridge is already gone. */ }
}

export function notifyDesktopAgentSessionClosed(sessionId: string): void {
  if (!hasDesktopAgentBridge() || !sessionId.trim()) return;
  void callDesktopAgentBrowser({ sessionId, action: "session_closed" }).catch(() => undefined);
}

export function notifyDesktopAgentIdle(sessionId: string): void {
  if (!hasDesktopAgentBridge() || !sessionId.trim()) return;
  void callDesktopAgentBrowser({ sessionId, action: "idle" }).catch(() => undefined);
}

function notifyIdleAfterAbort(input: { sessionId: string; action: string }): void {
  // wait_begin must finish wait_end before idle, or the main process rejects idle while still waiting.
  if (input.action === "idle" || input.action === "session_closed" || input.action === "wait_begin" || input.action === "wait_end") return;
  notifyDesktopAgentIdle(input.sessionId);
}
