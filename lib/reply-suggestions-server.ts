import { createHash } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, resolveSessionPath } from "./session-reader";
import { getRpcSession } from "./rpc-manager";
import { createTrustedModelServices, ModelRequestCwdError, resolveModelRequestCwd } from "./model-runtime-context";
import { resolveVisibleModels } from "./model-scope";
import { hasJsonContentType, isApiRequestAllowed } from "./request-security";
import { InvalidJsonBodyError, JsonBodyTooLargeError, parseJsonWithinLimit } from "./bounded-json";
import { latestReplySource, parseReplyResult, REPLY_JSON_PROTOCOL, REPLY_PROTOCOL_VERSION, replySourceText, unicodeLength, validateReplySettings, type ReplyResult } from "./reply-suggestions";

class ReplyError extends Error { constructor(readonly code: string, readonly status = 400) { super(code); } }
type Flight = { promise: Promise<ReplyResult>; controller: AbortController; users: number };
const globals = globalThis as typeof globalThis & { __pioraReplyFlights?: Map<string, Flight>; __pioraReplyCache?: Map<string, { result: ReplyResult; expires: number }> };
const flights: Map<string, Flight> = globals.__pioraReplyFlights ??= new Map<string, Flight>();
const cache: NonNullable<typeof globals.__pioraReplyCache> = globals.__pioraReplyCache ??= new Map();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function sourceSnapshot(id: string, entryId: string, requestedLeaf: string | null) {
  if (getRpcSession(id)?.isRunning()) throw new ReplyError("stale_source", 409);
  const path = await resolveSessionPath(id);
  if (!path) throw new ReplyError("stale_source", 409);
  const sm = SessionManager.open(path);
  const leafId = requestedLeaf ?? sm.getLeafId();
  const entries = sm.getEntries();
  if (!leafId || !entries.some((entry) => entry.id === leafId)) throw new ReplyError("stale_source", 409);
  const context = buildSessionContext(entries as never, leafId);
  const source = latestReplySource(context.messages, context.entryIds);
  if (!source || source.sourceEntryId !== entryId) throw new ReplyError("stale_source", 409);
  return { ...source, leafId, cwd: sm.getCwd() };
}

/** Each caller owns its subscription. Cancelling one pane does not abort another pane's request. */
async function sharedExtraction(key: string, signal: AbortSignal, run: (signal: AbortSignal) => Promise<ReplyResult>) {
  if (signal.aborted) throw new ReplyError("cancelled", 499);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) { cache.delete(key); cache.set(key, hit); return hit.result; }
  let flight = flights.get(key);
  if (!flight || flight.controller.signal.aborted) {
    if (flights.size >= 16) throw new ReplyError("busy", 429);
    const controller = new AbortController();
    flight = { controller, users: 0, promise: Promise.resolve({ groups: [] }) };
    const current = flight;
    const timeout = setTimeout(() => controller.abort(new ReplyError("timeout", 504)), 15_000);
    current.promise = new Promise<ReplyResult>((resolve, reject) => {
      const abort = () => reject(controller.signal.reason ?? new ReplyError("cancelled", 499));
      controller.signal.addEventListener("abort", abort, { once: true });
      void run(controller.signal).then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", abort));
    }).then((result) => {
      cache.set(key, { result, expires: Date.now() + 30 * 60_000 });
      while (cache.size > 200) cache.delete(cache.keys().next().value!);
      return result;
    }).finally(() => { clearTimeout(timeout); if (flights.get(key) === current) flights.delete(key); });
    flights.set(key, current);
  }
  const current = flight;
  current.users++;
  return new Promise<ReplyResult>((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true; signal.removeEventListener("abort", abort);
      if (--current.users === 0 && flights.get(key) === current) current.controller.abort(new ReplyError("cancelled", 499));
    };
    const abort = () => { release(); reject(new ReplyError("cancelled", 499)); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    current.promise.then((result) => { release(); resolve(result); }, (error) => { release(); reject(error); });
  });
}

export async function handleReplyRequest(request: Request, sessionId?: string): Promise<Response> {
  if (!isApiRequestAllowed(request)) return Response.json({ code: "access_denied" }, { status: 403 });
  if (!hasJsonContentType(request)) return Response.json({ code: "invalid_request" }, { status: 415 });
  try {
    const input = await parseJsonWithinLimit(request, 256 * 1024);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new ReplyError("invalid_request");
    const body = input as Record<string, unknown>;
    if (body.leafId !== undefined && body.leafId !== null && (typeof body.leafId !== "string" || !body.leafId || body.leafId.length > 256)) throw new ReplyError("invalid_request");
    let settings;
    try { settings = validateReplySettings({ version: 1, enabled: true, model: body.model, systemPrompt: body.systemPrompt }); } catch { throw new ReplyError("invalid_settings"); }
    const locale = typeof body.locale === "string" ? body.locale.slice(0, 32) : "zh-CN";
    const requestedLeaf = typeof body.leafId === "string" && body.leafId.length <= 256 ? body.leafId : null;
    const entryId = typeof body.sourceEntryId === "string" && body.sourceEntryId.length <= 256 ? body.sourceEntryId : "";
    const snapshot = sessionId ? await sourceSnapshot(sessionId, entryId, requestedLeaf) : null;
    if (!snapshot && (typeof body.source !== "string" || unicodeLength(body.source) > 24_000)) throw new ReplyError("invalid_source");
    const source = snapshot?.text ?? replySourceText(body.source as string);
    if (!source) return Response.json({ groups: [] });
    const cwd = await resolveModelRequestCwd(snapshot?.cwd ?? (typeof body.cwd === "string" ? body.cwd : undefined));
    const sourceKey = digest([sessionId, snapshot, source]);
    const key = digest([sourceKey, cwd, settings.model, settings.systemPrompt, locale, REPLY_PROTOCOL_VERSION]);
    const result = await sharedExtraction(key, request.signal, async (signal) => {
      const { modelRuntime, settingsManager } = await createTrustedModelServices(cwd);
      signal.throwIfAborted();
      const { visible } = await resolveVisibleModels(modelRuntime, settingsManager.getEnabledModels());
      const model = visible.find((m) => m.provider === settings.model!.provider && m.id === settings.model!.modelId);
      if (!model) throw new ReplyError("model_unavailable", 422);
      const message = await modelRuntime.completeSimple(model, {
        systemPrompt: `${settings.systemPrompt}\n\n${REPLY_JSON_PROTOCOL}`,
        messages: [{ role: "user", content: JSON.stringify({ locale, assistantText: source }), timestamp: Date.now() }],
      }, { maxTokens: 3072, maxRetries: 0, timeoutMs: 15_000, cacheRetention: "none", signal });
      signal.throwIfAborted();
      if (message.stopReason !== "stop") throw new ReplyError("provider_error", 502);
      try { return parseReplyResult(message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n"), source); }
      catch { throw new ReplyError("invalid_output", 502); }
    });
    if (snapshot && digest([sessionId, await sourceSnapshot(sessionId!, entryId, requestedLeaf), source]) !== sourceKey) { cache.delete(key); throw new ReplyError("stale_source", 409); }
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ReplyError) return Response.json({ code: error.code }, { status: error.status });
    if (error instanceof ModelRequestCwdError) return Response.json({ code: error.code }, { status: error.status });
    if (error instanceof JsonBodyTooLargeError) return Response.json({ code: "invalid_request" }, { status: 413 });
    if (error instanceof InvalidJsonBodyError) return Response.json({ code: "invalid_request" }, { status: 400 });
    // Provider error strings can contain URLs/credentials. Return only app-owned error categories.
    return Response.json({ code: "provider_error" }, { status: 502 });
  }
}
