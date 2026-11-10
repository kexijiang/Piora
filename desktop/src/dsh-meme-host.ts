/* eslint-disable @typescript-eslint/no-explicit-any */
// Version-specific host for dsh-meme 0.1.76, not a general Cordis runtime.
import { EnvHttpProxyAgent, fetch as proxyFetch } from "undici";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { extendMemePanel } from "./dsh-meme-panel.js";
import { join } from "node:path";
type Callback = (...args: any[]) => any;
const tools = new Map<string, any>();
const events = new Map<string, Callback[]>();
const routes: any[] = [];
const disposers: Callback[] = [];
const context = new AsyncLocalStorage<any>();
const pending = new Map<string, { resolve: Callback; reject: Callback; timer: ReturnType<typeof setTimeout> }>();
function modelCall(payload: any): Promise<any> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Meme model request timed out")); }, 120000);
    pending.set(id, { resolve, reject, timer });
    process.send?.({ type: "model", id, payload: { ...payload, selection: context.getStore()?.selection } });
  });
}
const attachments = {
  async saveImage(value: any) { return { id: randomUUID(), name: value.name, mediaType: value.mediaType, data: Buffer.from(value.data).toString("base64") }; },
  async readImage(ref: any) {
    const stored = context.getStore()?.images?.find((image: any) => image.id === ref.id);
    if (!stored) throw new Error("Attachment is not part of this request");
    return { data: Buffer.from(stored.data, "base64"), ref: stored };
  },
};
const llm = {
  async resolveModelInfo() { await modelCall({ action: "check" }); return { inputModalities: ["image"] }; },
  async resolveCallConfig(value: any) { return value; },
  async prepareCall() { return { async *stream(value: any) {
    const text = await modelCall({ action: "complete", messages: value.messages });
    yield { type: "text-delta", text };
  } }; },
};
const webServer = { register(route: any) { routes.push(route); return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1); }; }, tapIndex() { return () => {}; } };
const services: any = { tools: { register(tool: any) { if (tools.has(tool.name)) throw new Error("Duplicate tool"); tools.set(tool.name, tool); } }, webServer, attachments, llm,
  agentDefaultModel: { currentSelection() { return context.getStore()?.selection || { provider: "piora", model: "default" }; } } };
const ctx: any = { ...services, get(name: string) { return services[name]; }, provide(name: string, value: any) { services[name] = value; },
  logger: { error(message: string) { console.error(message); } },
  inject(_names: string[], fn: Callback) { fn(ctx); },
  effect(fn: Callback) { const dispose = fn(); if (typeof dispose === "function") disposers.push(dispose); },
  on(name: string, fn: Callback) { events.set(name, [...(events.get(name) || []), fn]); },
};
async function jsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 32 * 1024 * 1024) throw new Error("Request too large"); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}
function json(res: ServerResponse, value: unknown, status = 200) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); }
async function start(config: any) {
  const ca = process.env.NODE_EXTRA_CA_CERTS ? readFileSync(process.env.NODE_EXTRA_CA_CERTS, "utf8") : undefined;
  const dispatcher = new EnvHttpProxyAgent({ ...(ca ? { requestTls: { ca }, proxyTls: { ca }, connect: { ca } } : {}) });
  globalThis.fetch = ((input: any, init: any) => proxyFetch(input, { ...init, dispatcher })) as unknown as typeof globalThis.fetch;
  const plugin = await import(pathToFileURL(join(config.root, "installed", "node_modules", "dsh-meme", "index.js")).href);
  plugin.apply(ctx, {});
  for (const name of ["send_meme", "learn_meme", "meme_list", "meme_update"]) if (!tools.has(name)) throw new Error(`Missing upstream tool ${name}`);
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== `Bearer ${config.token}`) { res.writeHead(403); res.end(); return; }
      const url = new URL(req.url || "/", "http://localhost");
      if (url.pathname === "/__piora") {
        const body = await jsonBody(req);
        const result = await context.run(body, async () => {
          if (body.action === "prompt") {
            let assembled: any = { sections: [] };
            for (const fn of events.get("system-prompt/assemble") || []) assembled = await fn({}, {}, async () => assembled);
            return assembled.sections.map((section: any) => section.text).join("\n\n");
          }
          if (body.action === "schemas") return [...tools.values()].map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
          if (body.action !== "tool" || !tools.has(body.name)) throw new Error("Unknown operation");
          const images = body.images || [];
          return tools.get(body.name).execute(body.args, { agent: { session: { deriveMessages: () => [{ role: "user", content: images.map((ref: any) => ({ type: "image", attachment: ref })) }] } } });
        });
        json(res, result); return;
      }
      const route = routes.find(route => route.kind === "exact" ? url.pathname === route.path : url.pathname === route.path || url.pathname.startsWith(route.path + "/"));
      if (!route) { res.writeHead(404); res.end(); return; }
      // Preserve upstream's loopback Host validation. Never expose the application token.
      if (url.pathname === "/memes-panel") {
        const source = readFileSync(join(config.root, "installed", "node_modules", "dsh-meme", "panel.html"), "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); res.end(extendMemePanel(source)); return;
      }
      await route.handler(req, res);
    } catch (error) { if (!res.headersSent) json(res, { error: error instanceof Error ? error.message : "Plugin request failed" }, 400); else res.end(); }
  });
  server.listen(0, "127.0.0.1", () => process.send?.({ type: "ready", port: (server.address() as any).port }));
  process.once("disconnect", () => { for (const dispose of disposers) try { dispose(); } catch {} server.close(); void dispatcher.destroy().finally(() => process.exit(0)); });
}
process.on("message", (message: any) => {
  if (message?.type === "init") void start(message).catch(error => { process.send?.({ type: "failure", error: error.message }); process.exitCode = 1; process.disconnect?.(); });
  if (message?.type === "model-result") {
    const p = pending.get(message.id); if (!p) return; pending.delete(message.id); clearTimeout(p.timer);
    if (message.error) p.reject(new Error(message.error)); else p.resolve(message.value);
  }
});
