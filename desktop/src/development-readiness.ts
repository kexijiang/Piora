import { setTimeout as delay } from "node:timers/promises";
import { request } from "node:http";

interface DevelopmentReadinessOptions {
  headers: Record<string, string>;
  timeoutMs?: number;
  requestTimeoutMs?: number;
  retryIntervalMs?: number;
  onProgress?: (progress: { phase: "page" | "assets" | "retry"; attempts: number; elapsedMs: number; assets?: number; message?: string }) => void;
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
  // A cold Windows compile can take over three minutes before returning HTML
  // (measured at 194s). Keep a bounded development-only budget large enough
  // for that work plus chunk warming; explicit test/caller deadlines still win.
  const timeoutMs = options.timeoutMs ?? 600_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let attempts = 0;
  let lastError: unknown;
  const pending = new Set<string>();
  function progress(phase: "page" | "assets" | "retry", details: { assets?: number; message?: string } = {}) {
    options.onProgress?.({ phase, attempts, elapsedMs: Date.now() - startedAt, ...details });
  }

  async function read(target: URL, kind: "html" | "script" | "style"): Promise<string> {
    const requestController = new AbortController();
    // A cold Next compilation is real work, not a hung HTTP request. Do not
    // cancel it every minute and queue another page compile before the shared
    // startup deadline. Callers can still request a shorter per-request limit.
    const requestTimeoutMs = options.requestTimeoutMs ?? timeoutMs;
    const requestTimer = setTimeout(() => requestController.abort(), requestTimeoutMs);
    const operation = `${kind} ${target.pathname}`;
    pending.add(operation);
    try {
      // This is a local health probe, not application network traffic. Keep it
      // independent of fetch/SDK dispatchers, proxy hooks and shared keep-alive
      // pools while the application transport is itself still starting.
      return await new Promise<string>((resolveBody, reject) => {
        const probe = request(target, {
          method: "GET", agent: false,
          headers: { ...options.headers, accept: kind === "html" ? "text/html" : "*/*", "accept-encoding": "identity", "cache-control": "no-store" },
          signal: AbortSignal.any([controller.signal, requestController.signal]),
        }, response => {
          response.on("error", reject);
          const status = response.statusCode ?? 0;
          const contentType = response.headers["content-type"] ?? "";
          const expected = kind === "html" ? /text\/html/i : kind === "style" ? /text\/css/i : /(?:javascript|ecmascript)/i;
          let error: Error | undefined;
          if (status === 401 || status === 403) {
            error = new DevelopmentAuthenticationError(`Development request ${target.pathname} requires authentication (HTTP ${status})`);
          } else if (status < 200 || status >= 300 || !expected.test(contentType)) {
            error = new Error(`Development ${operation} is not ready (HTTP ${status}, ${contentType || "no content type"})`);
          } else if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") {
            error = new Error(`Development ${operation} ignored the uncompressed local probe`);
          }
          if (error) { reject(error); response.destroy(); return; }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (kind === "html") chunks.push(chunk);
          });
          response.on("end", () => {
            if (!response.complete || !size) { reject(new Error(`Development ${operation} has an incomplete or empty body`)); return; }
            resolveBody(kind === "html" ? Buffer.concat(chunks).toString("utf8") : "");
          });
        });
        probe.on("error", reject);
        probe.end();
      });
    } catch (error) {
      if (controller.signal.aborted || requestController.signal.aborted) {
        throw new Error(`Development ${operation} timed out after ${Math.min(timeoutMs, requestTimeoutMs)}ms`, { cause: error });
      }
      throw error;
    } finally { pending.delete(operation); clearTimeout(requestTimer); }
  }

  try {
    while (!controller.signal.aborted) {
      attempts++;
      try {
        progress("page");
        const html = await read(url, "html");
        const assets = developmentPageAssets(html, url);
        if (!assets.some(asset => asset.pathname.endsWith(".js"))) throw new Error("Development page has no application scripts yet");
        progress("assets", { assets: assets.length });
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
        progress("retry", { message: error instanceof Error ? error.message : "Development request failed" });
        if (controller.signal.aborted) break;
        await delay(options.retryIntervalMs ?? 250, undefined, { signal: controller.signal }).catch(() => {});
      }
    }
    const detail = pending.size ? `Waiting for ${[...pending].join(", ")}`
      : lastError instanceof Error ? lastError.message : "No completed page request";
    throw new Error(`Development page assets did not become ready within ${timeoutMs}ms. ${detail}`, { cause: lastError });
  } finally { clearTimeout(timer); }
}
