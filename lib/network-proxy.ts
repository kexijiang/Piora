import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { getRuntimeAgentDataDirectory } from "./runtime-home";

export type NetworkProxyMode = "system" | "manual" | "direct";

export interface NetworkProxySettings {
  mode: NetworkProxyMode;
  proxyUrl: string;
  bypass: string;
}
interface StoredNetworkProxySettings {
  schema: 1;
  mode: NetworkProxyMode;
  proxyUrl?: string;
  bypass?: string;
}

export const DEFAULT_NETWORK_PROXY_BYPASS = "localhost,127.0.0.1,::1";
export const DEFAULT_NETWORK_PROXY_SETTINGS: NetworkProxySettings = {
  mode: "system",
  proxyUrl: "",
  bypass: DEFAULT_NETWORK_PROXY_BYPASS,
};

export function networkProxySettingsPath(): string {
  const desktopData = process.env.PIORA_DESKTOP_DATA_DIR?.trim();
  if (desktopData) return join(resolve(desktopData), "network-proxy.json");
  return join(getRuntimeAgentDataDirectory(), "piora", "network-proxy.json");
}

function normalizeBypass(value: unknown): string {
  const entries = typeof value === "string"
    ? value.split(/[;,\s]+/).map((entry) => entry.trim()).filter(Boolean)
    : [];
  for (const required of ["localhost", "127.0.0.1", "::1"]) {
    if (!entries.includes(required)) entries.push(required);
  }
  return entries.join(",");
}

function normalizeProxyUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("Proxy address must be a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS proxy addresses are supported");
  }
  if (!parsed.hostname) throw new Error("Proxy address must include a host");
  return parsed.toString().replace(/\/$/, "");
}

export function parseNetworkProxySettings(input: unknown): NetworkProxySettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid network proxy settings");
  }
  const candidate = input as Record<string, unknown>;
  const mode = candidate.mode;
  if (mode !== "system" && mode !== "manual" && mode !== "direct") {
    throw new Error("Invalid network proxy mode");
  }
  const proxyUrl = normalizeProxyUrl(candidate.proxyUrl);
  if (mode === "manual" && !proxyUrl) throw new Error("Enter a proxy address");
  return {
    mode,
    proxyUrl: mode === "manual" ? proxyUrl : "",
    bypass: normalizeBypass(candidate.bypass),
  };
}

export function readNetworkProxySettings(): NetworkProxySettings {
  try {
    const parsed = JSON.parse(readFileSync(networkProxySettingsPath(), "utf8")) as Partial<StoredNetworkProxySettings>;
    if (parsed.schema !== 1) return { ...DEFAULT_NETWORK_PROXY_SETTINGS };
    return parseNetworkProxySettings(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
      return { ...DEFAULT_NETWORK_PROXY_SETTINGS };
    }
    return { ...DEFAULT_NETWORK_PROXY_SETTINGS };
  }
}

export function writeNetworkProxySettings(input: unknown): NetworkProxySettings {
  const settings = parseNetworkProxySettings(input);
  const path = networkProxySettingsPath();
  mkdirSync(dirname(path), { recursive: true });
  const stored: StoredNetworkProxySettings = {
    schema: 1,
    mode: settings.mode,
    ...(settings.proxyUrl ? { proxyUrl: settings.proxyUrl } : {}),
    bypass: settings.bypass,
  };
  writePrivateFileAtomicSync(path, `${JSON.stringify(stored, null, 2)}\n`);
  return settings;
}

export function networkProxyNoProxy(settings: NetworkProxySettings): string {
  return normalizeBypass(settings.bypass);
}

export function browserNetworkProxyOptions(settings = readNetworkProxySettings()): {
  args: string[];
  proxy?: { server: string; bypass: string; username?: string; password?: string };
} {
  if (settings.mode === "direct") return { args: ["--no-proxy-server"] };
  const proxyUrl = settings.mode === "manual" ? settings.proxyUrl
    : process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY || process.env.all_proxy || process.env.ALL_PROXY;
  if (!proxyUrl) return { args: [] };
  const url = new URL(proxyUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP and HTTPS browser proxies are supported");
  return {
    args: [],
    proxy: {
      server: `${url.protocol}//${url.host}`,
      bypass: settings.mode === "manual" ? networkProxyNoProxy(settings) : normalizeBypass(process.env.no_proxy || process.env.NO_PROXY),
      ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
      ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    },
  };
}
