import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as undici from "undici";
import { hasDesktopNetworkBridge, resolveDesktopSystemProxy, systemProxyUrl } from "./desktop-network-proxy";
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
  __piWebHttpInheritedProxyEnvironment?: Map<string, string | undefined>;
};

const dispatcherGlobal = globalThis as DispatcherGlobal;
const originalGlobalFetch = globalThis.fetch;
const ignoreUndiciDispatcherError = (): void => {};
const PROXY_ENV_KEYS = [
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "http_proxy", "https_proxy", "no_proxy", "all_proxy",
] as const;
const inheritedProxyEnvironment = dispatcherGlobal.__piWebHttpInheritedProxyEnvironment ??= new Map(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]));

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
  if (settings.mode === "system" && hasDesktopNetworkBridge()
    && !process.env.HTTP_PROXY && !process.env.HTTPS_PROXY && !process.env.http_proxy && !process.env.https_proxy && !process.env.ALL_PROXY && !process.env.all_proxy) {
    return new DesktopSystemProxyDispatcher(normalizedTimeoutMs);
  }
  const proxyOptions = settings.mode === "manual"
    ? { httpProxy: settings.proxyUrl, httpsProxy: settings.proxyUrl, noProxy: networkProxyNoProxy(settings) }
    : settings.mode === "direct"
      ? { httpProxy: "", httpsProxy: "", noProxy: "*" }
      : {
          httpProxy: process.env.http_proxy || process.env.HTTP_PROXY || process.env.all_proxy || process.env.ALL_PROXY,
          httpsProxy: process.env.https_proxy || process.env.HTTPS_PROXY || process.env.all_proxy || process.env.ALL_PROXY,
          noProxy: networkProxyNoProxy({ ...settings, bypass: process.env.no_proxy || process.env.NO_PROXY || settings.bypass }),
        };
  return withUndiciErrorListener(new undici.EnvHttpProxyAgent({
    ...proxyOptions,
    allowH2: false,
    bodyTimeout: normalizedTimeoutMs,
    headersTimeout: normalizedTimeoutMs,
    clientFactory: createUndiciClient,
    factory: createUndiciOriginDispatcher,
  }));
}

class DesktopSystemProxyDispatcher extends undici.Dispatcher {
  private readonly agents = new Map<string, undici.Dispatcher>();
  private readonly resolving = new Set<Promise<void>>();
  private closing = false;
  private destroying = false;
  constructor(private readonly timeoutMs: number) { super(); }
  dispatch(options: undici.Dispatcher.DispatchOptions, handler: undici.Dispatcher.DispatchHandler): boolean {
    const url = new URL(options.path, options.origin);
    if (this.closing) {
      handler.onResponseError?.(null as unknown as undici.Dispatcher.DispatchController, new Error("Network dispatcher is closed"));
      return false;
    }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const pending = (local ? Promise.resolve("DIRECT") : resolveDesktopSystemProxy(url.href)).then(result => {
      if (this.destroying) throw new Error("Network dispatcher is destroyed");
      const proxy = systemProxyUrl(result);
      const key = proxy ?? "DIRECT";
      let agent = this.agents.get(key);
      if (!agent) {
        const config = { bodyTimeout: this.timeoutMs, headersTimeout: this.timeoutMs, allowH2: false, factory: createUndiciOriginDispatcher };
        agent = withUndiciErrorListener(proxy ? new undici.ProxyAgent({ ...config, uri: proxy, clientFactory: createUndiciClient }) : new undici.Agent(config));
        this.agents.set(key, agent);
      }
      agent.dispatch(options, handler);
    }).catch(error => handler.onResponseError?.(null as unknown as undici.Dispatcher.DispatchController, error));
    this.resolving.add(pending);
    void pending.finally(() => this.resolving.delete(pending));
    return true;
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.all(this.resolving);
    await Promise.all([...this.agents.values()].map(agent => agent.close()));
  }
  async destroy(): Promise<void> {
    this.closing = true;
    this.destroying = true;
    await Promise.all([...this.agents.values()].map(agent => agent.destroy()));
  }
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
