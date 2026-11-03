import { randomUUID } from "node:crypto";
interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
const state = globalThis as typeof globalThis & { __pioraMemeBridge?: Map<string, Pending> };
export function memeDesktopAvailable() { return process.env.PIORA_DESKTOP_NETWORK_IPC === "1" && typeof process.send === "function" && process.connected; }
export async function callMemeDesktop<T = unknown>(action: string, value?: unknown): Promise<T> {
  if (!memeDesktopAvailable()) throw new Error("DSH Meme requires the Piora desktop application");
  if (!state.__pioraMemeBridge) {
    const pending = state.__pioraMemeBridge = new Map();
    process.on("message", message => {
      const m = message as { type?: string; requestId?: string; ok?: boolean; value?: unknown; error?: string };
      if (m?.type !== "pi-desktop:meme-response" || !m.requestId) return;
      const p = pending.get(m.requestId); if (!p) return; pending.delete(m.requestId); clearTimeout(p.timer);
      if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error || "Meme request failed"));
    });
    process.once("disconnect", () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("Desktop disconnected")); } pending.clear(); });
  }
  return new Promise<T>((resolve, reject) => {
    const requestId = randomUUID(); const pending = state.__pioraMemeBridge!;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("Meme request timed out")); }, 130000);
    pending.set(requestId, { resolve: value => resolve(value as T), reject, timer });
    process.send!({ type: "pi-desktop:meme-request", requestId, action, value }, error => { if (error) { clearTimeout(timer); pending.delete(requestId); reject(error); } });
  });
}
export async function memeHttp(path: string, method = "GET", body?: unknown) {
  const response = await callMemeDesktop<{ status: number; mime: string; data: string }>("http", { path, method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { ...response, bytes: Buffer.from(response.data, "base64") };
}
export async function memeJson<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
  const response = await memeHttp(path, body === undefined ? "GET" : "POST", body);
  const value = JSON.parse(response.bytes.toString());
  if (response.status >= 400 || value.ok === false) throw new Error(value.error || value.message || "DSH Meme operation failed");
  return value;
}
export interface UpstreamMeme { path: string; caption: string; tag: string; keywords?: string; url: string }
export interface UpstreamCatalog { memes: UpstreamMeme[]; packs: { id: string; name: string }[]; sendGear?: string }
export function memeCatalog() { return memeJson<UpstreamCatalog>("/dsh-memes-api?packId=all"); }
