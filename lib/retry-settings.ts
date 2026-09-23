/**
 * Model request retry/timeout settings.
 *
 * These live in pi's global `settings.json` (`retry.*`, `httpIdleTimeoutMs`) and
 * are normally only hand-editable. Piora exposes them so users on flaky networks
 * can shrink the failure window instead of waiting out the layered defaults.
 */

export interface ModelRetrySettings {
  /** pi-level auto-retry after a failed assistant response. */
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
  provider: {
    /** Time to first response data. `null` follows the SDK default (HTTP idle timeout). */
    timeoutMs: number | null;
    /** Transport-level retries inside one request. `null` follows the SDK default. */
    maxRetries: number | null;
    maxRetryDelayMs: number;
  };
  /** Idle bound on the provider connection. 0 disables the idle watchdog. */
  httpIdleTimeoutMs: number;
}

export interface RetrySettingsReader {
  getRetryEnabled(): boolean;
  getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number };
  getProviderRetrySettings(): { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs: number };
  getHttpIdleTimeoutMs(): number;
}

export interface RetrySettingsWriteError {
  scope: "global" | "project";
  error: Error;
}

/**
 * SettingsManager has public setters only for `retry.enabled` and
 * `httpIdleTimeoutMs`; the remaining fields use the same internal bookkeeping
 * those setters use (`globalSettings` + `markModified` + `save`) so writes keep
 * going through pi's scoped persistence and file lock.
 */
interface SettingsManagerInternals {
  globalSettings: {
    retry?: {
      enabled?: boolean;
      maxRetries?: number;
      baseDelayMs?: number;
      provider?: { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs?: number };
    };
    httpIdleTimeoutMs?: number;
  };
  markModified(field: string, nestedKey?: string): void;
  save(): void;
  flush(): Promise<void>;
  drainErrors(): RetrySettingsWriteError[];
  setRetryEnabled(enabled: boolean): void;
  setHttpIdleTimeoutMs(timeoutMs: number): void;
}

/** Safe during a run: getters change, but no session, tools, or stream is restarted. */
export async function reloadModelRetrySettings(managers: Iterable<{
  reload(): Promise<void>;
  drainErrors(): RetrySettingsWriteError[];
}>): Promise<void> {
  const results = await Promise.allSettled([...new Set(managers)].map(async (manager) => {
    await manager.reload();
    const errors = manager.drainErrors();
    if (errors.length) throw errors[0].error;
  }));
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length) throw new Error(`Settings saved, but ${failures.length} session settings reload(s) failed: ${String(failures[0].reason)}`);
}

const LIMITS = {
  maxRetries: [0, 10],
  baseDelayMs: [100, 60_000],
  providerTimeoutMs: [1_000, 3_600_000],
  providerMaxRetries: [0, 5],
  providerMaxRetryDelayMs: [0, 300_000],
  httpIdleTimeoutMs: [0, 3_600_000],
} as const;

function requireInt(value: unknown, field: string, range: readonly [number, number]): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) throw new TypeError(`${field} must be an integer`);
  if (numeric < range[0] || numeric > range[1]) throw new TypeError(`${field} must be between ${range[0]} and ${range[1]}`);
  return numeric;
}

function optionalInt(value: unknown, field: string, range: readonly [number, number]): number | null {
  if (value === null || value === undefined || value === "") return null;
  return requireInt(value, field, range);
}

/** Validate a full settings submission from the UI. Throws TypeError on bad input. */
export function parseModelRetrySettings(input: unknown): ModelRetrySettings {
  const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const provider = (body.provider && typeof body.provider === "object" ? body.provider : {}) as Record<string, unknown>;
  if (typeof body.enabled !== "boolean") throw new TypeError("enabled must be a boolean");
  return {
    enabled: body.enabled,
    maxRetries: requireInt(body.maxRetries, "maxRetries", LIMITS.maxRetries),
    baseDelayMs: requireInt(body.baseDelayMs, "baseDelayMs", LIMITS.baseDelayMs),
    provider: {
      timeoutMs: optionalInt(provider.timeoutMs, "provider.timeoutMs", LIMITS.providerTimeoutMs),
      maxRetries: optionalInt(provider.maxRetries, "provider.maxRetries", LIMITS.providerMaxRetries),
      maxRetryDelayMs: requireInt(provider.maxRetryDelayMs, "provider.maxRetryDelayMs", LIMITS.providerMaxRetryDelayMs),
    },
    httpIdleTimeoutMs: requireInt(body.httpIdleTimeoutMs, "httpIdleTimeoutMs", LIMITS.httpIdleTimeoutMs),
  };
}

export function readModelRetrySettings(manager: RetrySettingsReader): ModelRetrySettings {
  const retry = manager.getRetrySettings();
  const provider = manager.getProviderRetrySettings();
  return {
    enabled: retry.enabled,
    maxRetries: retry.maxRetries,
    baseDelayMs: retry.baseDelayMs,
    provider: {
      timeoutMs: provider.timeoutMs ?? null,
      maxRetries: provider.maxRetries ?? null,
      maxRetryDelayMs: provider.maxRetryDelayMs,
    },
    httpIdleTimeoutMs: manager.getHttpIdleTimeoutMs(),
  };
}

export async function applyModelRetrySettings(manager: unknown, settings: ModelRetrySettings): Promise<ModelRetrySettings> {
  const writer = manager as SettingsManagerInternals & RetrySettingsReader;
  writer.setRetryEnabled(settings.enabled);
  writer.setHttpIdleTimeoutMs(settings.httpIdleTimeoutMs);
  const retry = writer.globalSettings.retry ?? (writer.globalSettings.retry = {});
  if (retry.maxRetries !== settings.maxRetries) {
    retry.maxRetries = settings.maxRetries;
    writer.markModified("retry", "maxRetries");
  }
  if (retry.baseDelayMs !== settings.baseDelayMs) {
    retry.baseDelayMs = settings.baseDelayMs;
    writer.markModified("retry", "baseDelayMs");
  }
  const provider = retry.provider ?? (retry.provider = {});
  if (provider.timeoutMs !== (settings.provider.timeoutMs ?? undefined)) {
    if (settings.provider.timeoutMs === null) delete provider.timeoutMs;
    else provider.timeoutMs = settings.provider.timeoutMs;
    writer.markModified("retry", "provider");
  }
  if (provider.maxRetries !== (settings.provider.maxRetries ?? undefined)) {
    if (settings.provider.maxRetries === null) delete provider.maxRetries;
    else provider.maxRetries = settings.provider.maxRetries;
    writer.markModified("retry", "provider");
  }
  if (provider.maxRetryDelayMs !== settings.provider.maxRetryDelayMs) {
    provider.maxRetryDelayMs = settings.provider.maxRetryDelayMs;
    writer.markModified("retry", "provider");
  }
  if (Object.keys(provider).length === 0) delete retry.provider;
  writer.save();
  await writer.flush();
  const errors = writer.drainErrors();
  if (errors.length > 0) {
    const first = errors[0];
    throw new Error(first.error instanceof Error ? first.error.message : String(first.error));
  }
  return readModelRetrySettings(writer);
}
