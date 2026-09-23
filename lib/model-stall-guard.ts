/**
 * Model request stall watchdog.
 *
 * A provider request can die silently (half-open socket after sleep or a network
 * switch, a proxy that swallows the stream). Transport timeouts alone cannot
 * detect every stalled provider stream. This guard uses the session's effective
 * request/idle deadlines so its behavior agrees with the settings UI.
 *
 * This guard wraps `ModelRuntime.streamSimple` per services instance:
 * - no first event within `firstEventTimeoutMs` → fail with a retryable timeout,
 * - no stream event for `idleTimeoutMs` after data started → same.
 *
 * The synthetic failure deliberately says "timed out" so pi's auto-retry and
 * Piora's model fallback classify it as a provider availability failure and
 * recover automatically instead of hanging.
 */
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";

export const DEFAULT_MODEL_STALL_FIRST_EVENT_TIMEOUT_MS = 180_000;
export const DEFAULT_MODEL_STALL_IDLE_TIMEOUT_MS = 120_000;

export interface ModelStallConfig {
  /** Bound on receiving any first stream event (request start through headers). */
  firstEventTimeoutMs: number;
  /** Bound on the gap between two consecutive stream events once data flows. */
  idleTimeoutMs: number;
}

export interface ModelStallSettings {
  getProviderRetrySettings(): { timeoutMs?: number };
  getHttpIdleTimeoutMs(): number;
}

const MAX_TIMER_MS = 2_147_483_647;

function readTimeoutMs(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw?.trim());
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(parsed) && parsed >= 0
    ? Math.min(Math.floor(parsed), MAX_TIMER_MS)
    : fallback;
}

export function readModelStallConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  settings?: ModelStallSettings,
  requestTimeoutMs?: number,
): ModelStallConfig {
  // Normal sessions use the same effective settings as the SDK. Environment
  // values are fallbacks for runtimes without a SettingsManager.
  const idleTimeoutMs = settings?.getHttpIdleTimeoutMs()
    ?? readTimeoutMs(env.PIORA_MODEL_STALL_IDLE_TIMEOUT_MS, DEFAULT_MODEL_STALL_IDLE_TIMEOUT_MS);
  const providerTimeoutMs = settings?.getProviderRetrySettings().timeoutMs;
  let firstEventTimeoutMs = requestTimeoutMs ?? providerTimeoutMs
    ?? (settings ? idleTimeoutMs : readTimeoutMs(env.PIORA_MODEL_STALL_FIRST_EVENT_TIMEOUT_MS, DEFAULT_MODEL_STALL_FIRST_EVENT_TIMEOUT_MS));
  // The SDK maps an unlimited timeout to int32 max for provider SDKs that
  // interpret 0 as an immediate failure. Restore its unlimited meaning here.
  if (firstEventTimeoutMs === MAX_TIMER_MS && idleTimeoutMs === 0 && providerTimeoutMs === undefined) firstEventTimeoutMs = 0;
  return {
    firstEventTimeoutMs: readTimeoutMs(String(firstEventTimeoutMs), DEFAULT_MODEL_STALL_FIRST_EVENT_TIMEOUT_MS),
    idleTimeoutMs: readTimeoutMs(String(idleTimeoutMs), DEFAULT_MODEL_STALL_IDLE_TIMEOUT_MS),
  };
}

export function modelStallTimeoutMessage(kind: "first-event" | "idle", timeoutMs: number): string {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  return kind === "first-event"
    ? `Model request timed out: the provider sent no response data within ${seconds} seconds. The connection or provider may be stalled; the request can be retried.`
    : `Model request timed out: the response stream stopped sending data for ${seconds} seconds. The connection may have died silently; the request can be retried.`;
}

interface StreamOptionsLike {
  signal?: AbortSignal;
  timeoutMs?: number;
  [key: string]: unknown;
}

type StreamSimpleFn = (model: unknown, context: unknown, options?: StreamOptionsLike) => AssistantMessageEventStream;

export interface ModelRuntimeLike {
  streamSimple: StreamSimpleFn;
}

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Build the timeout failure as a normal assistant error message. */
export function modelStallTimeoutEvent(
  kind: "first-event" | "idle",
  timeoutMs: number,
  context: { model?: unknown; partial?: AssistantMessage },
): AssistantMessageEvent {
  const partial = context.partial;
  const model = context.model as { api?: unknown; provider?: unknown; id?: unknown } | undefined;
  const message = {
    role: "assistant",
    content: [],
    api: partial?.api ?? model?.api,
    provider: partial?.provider ?? model?.provider,
    model: partial?.model ?? model?.id,
    usage: partial?.usage ?? emptyUsage(),
    stopReason: "error",
    errorMessage: modelStallTimeoutMessage(kind, timeoutMs),
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
  return { type: "error", reason: "error", error: message };
}

function abortedEvent(model?: unknown, partial?: AssistantMessage): AssistantMessageEvent {
  const identity = model as { api?: unknown; provider?: unknown; id?: unknown } | undefined;
  const message = {
    role: "assistant",
    api: partial?.api ?? identity?.api,
    provider: partial?.provider ?? identity?.provider,
    model: partial?.model ?? identity?.id,
    content: partial?.content ?? [],
    usage: partial?.usage ?? emptyUsage(),
    stopReason: "aborted",
    errorMessage: "Request stopped before completion.",
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
  return { type: "error", reason: "aborted", error: message };
}

function thrownErrorEvent(error: unknown): AssistantMessageEvent {
  const message = {
    role: "assistant",
    content: [],
    usage: emptyUsage(),
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
  return { type: "error", reason: "error", error: message };
}

function isTerminal(event: AssistantMessageEvent): boolean {
  return event.type === "done" || event.type === "error";
}

export interface StallGuardOptions {
  model?: unknown;
  controller: AbortController;
  userSignal?: AbortSignal;
  firstEventTimeoutMs: number;
  idleTimeoutMs: number;
}

/**
 * Forward a source stream through a watchdog. On stall the underlying request is
 * aborted and consumers receive a retryable "timed out" error event instead of
 * the abort error the provider layer would otherwise surface.
 */
export function guardAssistantStream(
  source: AssistantMessageEventStream,
  options: StallGuardOptions,
): AssistantMessageEventStream {
  const guarded = createAssistantMessageEventStream();
  const { controller, userSignal, firstEventTimeoutMs, idleTimeoutMs } = options;
  let settled = false;
  let partial: AssistantMessage | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopReading: (() => void) | undefined;

  const clear = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const settleWith = (event: AssistantMessageEvent): void => {
    if (settled) return;
    settled = true;
    clear();
    userSignal?.removeEventListener("abort", onAbort);
    guarded.push(event);
    guarded.end();
    stopReading?.();
    stopReading = undefined;
  };

  function onAbort(): void {
    if (settled) return;
    settleWith(abortedEvent(options.model, partial));
    controller.abort();
  }

  const fire = (kind: "first-event" | "idle"): void => {
    if (settled) return;
    if (userSignal?.aborted) { onAbort(); return; }
    settleWith(modelStallTimeoutEvent(kind, kind === "first-event" ? firstEventTimeoutMs : idleTimeoutMs, { model: options.model, partial }));
    try {
      controller.abort();
    } catch {
      // The request teardown is best-effort; the timeout event is what matters.
    }
  };

  const arm = (kind: "first-event" | "idle", ms: number): void => {
    clear();
    if (settled || ms <= 0) return;
    timer = setTimeout(() => fire(kind), ms);
  };

  userSignal?.addEventListener("abort", onAbort, { once: true });
  if (userSignal?.aborted) { onAbort(); return guarded; }
  arm("first-event", firstEventTimeoutMs);

  void (async () => {
    const iterator = source[Symbol.asyncIterator]();
    try {
      while (!settled) {
        // Keep only the current read's resolver. Racing every event against one
        // shared pending promise would retain a reaction for every stream delta.
        const next = await new Promise<IteratorResult<AssistantMessageEvent>>((resolve, reject) => {
          stopReading = () => resolve({ done: true, value: undefined });
          Promise.resolve(iterator.next()).then(resolve, reject);
        });
        stopReading = undefined;
        if (settled) return;
        if (next.done) break;
        const event = next.value;
        if ("partial" in event && event.partial) partial = event.partial;
        if (isTerminal(event)) {
          settleWith(event);
          return;
        }
        guarded.push(event);
        arm("idle", idleTimeoutMs);
      }
      // A well-behaved provider always terminates with done/error. If the stream
      // object ends silently, fail loudly rather than leaving result() pending.
      settleWith(modelStallTimeoutEvent("idle", idleTimeoutMs, { model: options.model, partial }));
    } catch (error) {
      if (settled) return;
      if (userSignal?.aborted) {
        onAbort();
      } else {
        settleWith(thrownErrorEvent(error));
      }
    } finally {
      // A provider may ignore abort and leave next() pending. Do not keep our
      // forwarding task waiting on that provider's cleanup.
      try { void iterator.return?.().catch(() => undefined); } catch { /* Best-effort cleanup. */ }
    }
  })();

  return guarded;
}

const installed = new WeakSet<object>();

/**
 * Wrap `runtime.streamSimple` with the stall watchdog. Idempotent per runtime
 * instance; returns whether the wrapper was installed.
 */
export function installModelStallGuard(
  runtime: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
  settings?: ModelStallSettings,
): boolean {
  if (!runtime || typeof runtime !== "object") return false;
  if (installed.has(runtime)) return false;
  const holder = runtime as { streamSimple?: unknown };
  const original = holder.streamSimple;
  if (typeof original !== "function") return false;
  installed.add(runtime);
  const bound = (original as StreamSimpleFn).bind(runtime) as StreamSimpleFn;
  holder.streamSimple = ((model: unknown, context: unknown, options?: StreamOptionsLike) => {
    const config = readModelStallConfig(env, settings, options?.timeoutMs);
    const userSignal = options?.signal;
    if (userSignal?.aborted) {
      const cancelled = createAssistantMessageEventStream();
      cancelled.push(abortedEvent(model));
      cancelled.end();
      return cancelled;
    }
    const controller = new AbortController();
    const signal = userSignal ? AbortSignal.any([userSignal, controller.signal]) : controller.signal;
    const source = bound(model, context, { ...options, signal });
    return guardAssistantStream(source, {
      model,
      controller,
      userSignal,
      firstEventTimeoutMs: config.firstEventTimeoutMs,
      idleTimeoutMs: config.idleTimeoutMs,
    });
  }) as StreamSimpleFn;
  return true;
}
