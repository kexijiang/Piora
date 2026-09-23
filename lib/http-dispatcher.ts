import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as undici from "undici";
import { getRuntimeAgentDataDirectory } from "./runtime-home";
import {
  networkProxyNoProxy,
  readNetworkProxySettings,
  type NetworkProxySettings,
} from "./network-proxy";

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;

type DispatcherGlobal = typeof globalThis & {
  __piWebHttpDispatcherConfigured?: boolean;
  __piWebHttpDispatcher?: undici.Dispatcher;
  __piWebHttpProxySignature?: string;
};

const dispatcherGlobal = globalThis as DispatcherGlobal;
const originalGlobalFetch = globalThis.fetch;
const ignoreUndiciDispatcherError = (): void => {};
const PROXY_ENV_KEYS = [
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "http_proxy", "https_proxy", "no_proxy", "all_proxy",
] as const;
const inheritedProxyEnvironment = new Map(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]));

function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.toLowerCase() === "disabled") return 0;
    if (trimmed.length === 0) return undefined;
    return parseHttpIdleTimeoutMs(Number(trimmed));
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

/** Keep startup and later proxy changes aligned with the saved global timeout. */
export function readConfiguredHttpIdleTimeoutMs(settingsPath = join(getRuntimeAgentDataDirectory(), "settings.json")): number {
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, "")) as { httpIdleTimeoutMs?: unknown };
    return parseHttpIdleTimeoutMs(settings.httpIdleTimeoutMs) ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS;
  } catch {
    return DEFAULT_HTTP_IDLE_TIMEOUT_MS;
  }
}

// Undici can emit an internal Client error while terminating a response body.
// The body stream still rejects; this prevents the EventEmitter error from
// terminating the Next.js process first.
function withUndiciErrorListener<T extends undici.Dispatcher>(dispatcher: T): T {
  if (dispatcher instanceof EventEmitter) {
    EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
  }
  return dispatcher;
}

function createUndiciClient(origin: string | URL, options: object): undici.Dispatcher {
  return withUndiciErrorListener(
    new undici.Client(origin, options as undici.Client.Options),
  );
}

function createUndiciOriginDispatcher(origin: string | URL, options: object): undici.Dispatcher {
  const dispatcherOptions = options as undici.Pool.Options;
  if (dispatcherOptions.connections === 1) {
    return createUndiciClient(origin, dispatcherOptions);
  }

  return withUndiciErrorListener(
    new undici.Pool(origin, {
      ...dispatcherOptions,
      factory: createUndiciClient,
    }),
  );
}

function createHttpDispatcher(settings: NetworkProxySettings, timeoutMs: number): undici.Dispatcher {
  const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
  if (normalizedTimeoutMs === undefined) {
    throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
  }
  const proxyOptions = settings.mode === "manual"
    ? { httpProxy: settings.proxyUrl, httpsProxy: settings.proxyUrl, noProxy: networkProxyNoProxy(settings) }
    : settings.mode === "direct"
      ? { httpProxy: "", httpsProxy: "", noProxy: "*" }
      : {};
  return withUndiciErrorListener(new undici.EnvHttpProxyAgent({
    ...proxyOptions,
    allowH2: false,
    bodyTimeout: normalizedTimeoutMs,
    headersTimeout: normalizedTimeoutMs,
    clientFactory: createUndiciClient,
    factory: createUndiciOriginDispatcher,
  }));
}

function applyProxyEnvironment(settings: NetworkProxySettings): void {
  if (settings.mode === "system") {
    for (const [key, value] of inheritedProxyEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return;
  }
  if (settings.mode === "direct") {
    for (const key of PROXY_ENV_KEYS) delete process.env[key];
    process.env.NO_PROXY = "*";
    process.env.no_proxy = "*";
    return;
  }
  const noProxy = networkProxyNoProxy(settings);
  process.env.HTTP_PROXY = settings.proxyUrl;
  process.env.HTTPS_PROXY = settings.proxyUrl;
  process.env.ALL_PROXY = settings.proxyUrl;
  process.env.http_proxy = settings.proxyUrl;
  process.env.https_proxy = settings.proxyUrl;
  process.env.all_proxy = settings.proxyUrl;
  process.env.NO_PROXY = noProxy;
  process.env.no_proxy = noProxy;
}

export function applyNetworkProxySettings(
  settings: NetworkProxySettings,
  timeoutMs: number = readConfiguredHttpIdleTimeoutMs(),
): void {
  const signature = JSON.stringify({ settings, timeoutMs });
  if (dispatcherGlobal.__piWebHttpProxySignature === signature && dispatcherGlobal.__piWebHttpDispatcherConfigured) return;
  applyProxyEnvironment(settings);
  const dispatcher = createHttpDispatcher(settings, timeoutMs);
  const previous = dispatcherGlobal.__piWebHttpDispatcher;
  undici.setGlobalDispatcher(dispatcher);
  dispatcherGlobal.__piWebHttpDispatcher = dispatcher;
  dispatcherGlobal.__piWebHttpProxySignature = signature;

  // Keep fetch and the dispatcher on the same undici implementation. Preserve
  // an intentional fetch override installed after this module was loaded.
  if (globalThis.fetch === originalGlobalFetch) {
    undici.install?.();
  }

  dispatcherGlobal.__piWebHttpDispatcherConfigured = true;
  if (previous && previous !== dispatcher) {
    void previous.close().catch(() => undefined);
  }
}

export function configureHttpDispatcher(
  timeoutMs: number = readConfiguredHttpIdleTimeoutMs(),
): void {
  if (dispatcherGlobal.__piWebHttpDispatcherConfigured) return;
  applyNetworkProxySettings(readNetworkProxySettings(), timeoutMs);
}
