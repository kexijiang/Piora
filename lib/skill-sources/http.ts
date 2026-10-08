import { SkillSourceError, type SkillSource } from "./types";
import { sourceCredential } from "./store";
import { MAX_BYTES } from "./content";

export function apiUrl(source: SkillSource, path: string, query: Record<string, string | undefined> = {}) {
  const url = new URL(`${source.url.replace(/\/$/, "")}/${path.replace(/^\//, "")}`);
  for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, value);
  return url.toString();
}
export async function readResponse(response: Response, limit = MAX_BYTES): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > limit) { await response.body?.cancel(); throw new SkillSourceError("size", "Response too large"); }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  let size = 0; const chunks: Buffer[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > limit) throw new SkillSourceError("size", "Response too large");
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}
export async function sourceRequest(source: SkillSource, address: string, credential = sourceCredential(source.id), fetcher: typeof fetch = fetch) {
  let url = new URL(address), sendCredential = url.origin === new URL(source.url).origin;
  const signal = AbortSignal.timeout(30_000);
  for (let hop = 0; hop < 6; hop++) {
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new SkillSourceError("url", "Unsupported download URL");
    const headers: Record<string, string> = { "User-Agent": "Piora-Skills" };
    if (sendCredential && credential) headers[source.kind === "skillhub" ? "X-API-Key" : "Authorization"] = source.kind === "skillhub" ? credential : `Bearer ${credential}`;
    const response = await fetcher(url, { headers, redirect: "manual", signal, cache: "no-store" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location"); await response.body?.cancel();
      if (!location) throw new SkillSourceError("network", "Missing redirect location", 502);
      const next = new URL(location, url);
      if (url.protocol === "https:" && next.protocol !== "https:") throw new SkillSourceError("url", "Insecure download redirect");
      sendCredential = sendCredential && next.origin === url.origin;
      url = next; continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new SkillSourceError(response.status === 401 || response.status === 403 ? "auth-required" : "network", `Source returned HTTP ${response.status}${response.status === 429 ? " (retry later)" : ""}`, response.status === 401 || response.status === 403 ? 401 : 502);
    }
    return response;
  }
  throw new SkillSourceError("network", "Too many download redirects", 502);
}
export async function sourceJson(source: SkillSource, path: string, query?: Record<string, string | undefined>, credential?: string): Promise<Record<string, unknown>> {
  const response = await sourceRequest(source, apiUrl(source, path, query), credential);
  try { return JSON.parse((await readResponse(response, 8 * 1024 * 1024)).toString("utf8")); }
  catch (error) { if (error instanceof SkillSourceError) throw error; throw new SkillSourceError("protocol", "Source returned invalid JSON", 502); }
}
export function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function string(value: unknown): string { return typeof value === "string" ? value : ""; }
export function array(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(object) : []; }
export function httpLink(value: unknown): string | undefined { try { const u = new URL(string(value)); return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password ? u.toString() : undefined; } catch { return undefined; } }
