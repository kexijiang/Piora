import { randomUUID } from "node:crypto";
import type { NetworkProxySettings } from "./network-proxy";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
const state = globalThis as typeof globalThis & { __pioraDesktopNetwork?: { pending: Map<string, Pending> } };

export function hasDesktopNetworkBridge(): boolean {
  return process.env.PIORA_DESKTOP_NETWORK_IPC === "1" && typeof process.send === "function" && process.connected === true;
}

function requestDesktopNetwork(action: "apply" | "resolve", value: unknown): Promise<unknown> {
  if (!hasDesktopNetworkBridge()) return Promise.reject(new Error("Desktop network bridge unavailable"));
  if (!state.__pioraDesktopNetwork) {
    state.__pioraDesktopNetwork = { pending: new Map() };
    process.on("message", (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const response = message as { type?: unknown; requestId?: unknown; ok?: unknown; value?: unknown; error?: unknown };
      if (response.type !== "pi-desktop:network-response" || typeof response.requestId !== "string") return;
      const pending = state.__pioraDesktopNetwork!.pending.get(response.requestId);
      if (!pending) return;
      state.__pioraDesktopNetwork!.pending.delete(response.requestId);
      clearTimeout(pending.timer);
      if (response.ok === true) pending.resolve(response.value);
      else pending.reject(new Error(typeof response.error === "string" ? response.error : "Desktop network request failed"));
    });
  }
  const pendingRequests = state.__pioraDesktopNetwork.pending;
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingRequests.delete(requestId); reject(new Error("Desktop network request timed out")); }, 5_000);
    timer.unref();
    pendingRequests.set(requestId, { resolve, reject, timer });
    process.send!({ type: "pi-desktop:network-request", requestId, action, value }, (error: Error | null) => {
      if (!error) return;
      pendingRequests.delete(requestId); clearTimeout(timer); reject(error);
    });
  });
}

export async function applyDesktopProxySettings(settings: NetworkProxySettings): Promise<void> {
  if (!hasDesktopNetworkBridge()) return;
  if (await requestDesktopNetwork("apply", settings) !== true) throw new Error("Desktop network proxy could not be applied");
}

export async function resolveDesktopSystemProxy(url: string): Promise<string> {
  const value = await requestDesktopNetwork("resolve", url);
  if (typeof value !== "string") throw new Error("Invalid system proxy response");
  return value;
}

/** Chromium's PAC result is ordered; never silently bypass an unsupported proxy. */
export function systemProxyUrl(result: string): string | undefined {
  const first = result.split(";", 1)[0].trim();
  if (first === "DIRECT") return undefined;
  const match = /^(PROXY|HTTPS)\s+(\S+)$/i.exec(first);
  if (!match) throw new Error("System proxy requires an HTTP or HTTPS proxy");
  return `${match[1].toUpperCase() === "HTTPS" ? "https" : "http"}://${match[2]}`;
}
