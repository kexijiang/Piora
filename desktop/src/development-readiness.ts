import { setTimeout as delay } from "node:timers/promises";

interface DevelopmentReadinessOptions {
  headers: Record<string, string>;
  timeoutMs?: number;
  requestTimeoutMs?: number;
  retryIntervalMs?: number;
}

class DevelopmentAuthenticationError extends Error {}

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag)?.slice(1).find(value => value !== undefined);
}

/** Only warm assets emitted by this loopback page; never forward its token elsewhere. */
export function developmentPageAssets(html: string, pageUrl: URL): URL[] {
  const assets = new Map<string, URL>();
  for (const match of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    const tag = match[0];
    const script = /^<script\b/i.test(tag);
    if (!script && attribute(tag, "rel")?.toLowerCase() !== "stylesheet") continue;
    const source = attribute(tag, script ? "src" : "href");
    if (!source) continue;
    const decoded = source.replace(/&(?:amp|quot|apos|#(\d+)|#x([\da-f]+));/gi, (entity, decimal: string | undefined, hex: string | undefined) => {
      if (decimal || hex) {
        const code = Number.parseInt(decimal ?? hex!, decimal ? 10 : 16);
        return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
      }
      return entity.toLowerCase() === "&amp;" ? "&" : entity.toLowerCase() === "&quot;" ? '"' : "'";
    });
    let url: URL;
    try { url = new URL(decoded, pageUrl); } catch { continue; }
    if (url.origin !== pageUrl.origin || url.username || url.password || !url.pathname.startsWith("/_next/static/")) continue;
    if (!url.pathname.endsWith(script ? ".js" : ".css")) continue;
    url.hash = "";
    assets.set(url.href, url);
  }
  return [...assets.values()];
}

/** TCP readiness is insufficient: Next dev compiles the page and its chunks on demand. */
export async function waitForDevelopmentPageAssets(url: URL, options: DevelopmentReadinessOptions): Promise<{
  assets: number;
  attempts: number;
  elapsedMs: number;
}> {
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) {
    throw new Error("Development readiness requires an authenticated loopback URL");
  }
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 180_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let attempts = 0;
  let lastError: unknown;

  async function read(target: URL, kind: "html" | "script" | "style"): Promise<string> {
    const requestController = new AbortController();
    const requestTimer = setTimeout(() => requestController.abort(), options.requestTimeoutMs ?? 60_000);
    try {
      const response = await fetch(target, {
        headers: options.headers,
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.any([controller.signal, requestController.signal]),
      });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        throw new DevelopmentAuthenticationError(`Development request ${target.pathname} requires authentication (HTTP ${response.status})`);
      }
      const contentType = response.headers.get("content-type") ?? "";
      const expected = kind === "html" ? /text\/html/i : kind === "style" ? /text\/css/i : /(?:javascript|ecmascript)/i;
      if (!response.ok || !expected.test(contentType)) {
        await response.body?.cancel();
        throw new Error(`Development ${kind} ${target.pathname} is not ready (HTTP ${response.status}, ${contentType || "no content type"})`);
      }
      if (kind === "html") return await response.text();
      // Consume the entire body, not just headers. A stalled chunk must keep
      // the intro barrier closed without retaining large dev bundles in memory.
      const reader = response.body?.getReader();
      if (!reader) throw new Error(`Development asset ${target.pathname} has no body`);
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
        }
      } finally { reader.releaseLock(); }
      if (!size) throw new Error(`Development asset ${target.pathname} is empty`);
      return "";
    } finally { clearTimeout(requestTimer); }
  }

  try {
    while (!controller.signal.aborted) {
      attempts++;
      try {
        const html = await read(url, "html");
        const assets = developmentPageAssets(html, url);
        if (!assets.some(asset => asset.pathname.endsWith(".js"))) throw new Error("Development page has no application scripts yet");
        let next = 0;
        const results = await Promise.allSettled(Array.from({ length: Math.min(4, assets.length) }, async () => {
          while (next < assets.length) {
            const asset = assets[next++]!;
            await read(asset, asset.pathname.endsWith(".css") ? "style" : "script");
          }
        }));
        const failed = results.find(result => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
        return { assets: assets.length, attempts, elapsedMs: Date.now() - startedAt };
      } catch (error) {
        if (error instanceof DevelopmentAuthenticationError) throw error;
        lastError = error;
        if (controller.signal.aborted) break;
        await delay(options.retryIntervalMs ?? 250, undefined, { signal: controller.signal }).catch(() => {});
      }
    }
    throw new Error(`Development page assets did not become ready within ${timeoutMs}ms`, { cause: lastError });
  } finally { clearTimeout(timer); }
}
