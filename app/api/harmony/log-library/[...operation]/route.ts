import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { getHarmonyLogLibrary } from "@/lib/harmony/log-library/runtime";
import { resolveSessionPath } from "@/lib/session-reader";
import { parseJsonWithinLimit, JsonBodyTooLargeError, InvalidJsonBodyError } from "@/lib/bounded-json";
import { requireHarmonyAccess, noStoreJson } from "../../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ operation: string[] }> };

async function readChunk(request: Request): Promise<Buffer> {
  const maximum = 256 * 1024;
  if (Number(request.headers.get("content-length")) > maximum) throw new JsonBodyTooLargeError();
  const reader = request.body?.getReader();
  if (!reader) throw new Error("日志分块不能为空");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new JsonBodyTooLargeError(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

async function handle(request: Request, context: Context): Promise<Response> {
  const denied = requireHarmonyAccess(request);
  if (denied) return denied;
  try {
    const operation = (await context.params).operation.join("/");
    const params = new URL(request.url).searchParams;
    const sessionId = params.get("sessionId") ?? "";
    if (!sessionId || sessionId.length > 256 || !await resolveSessionPath(sessionId)) {
      return noStoreJson({ error: "请先打开一个已有会话，再使用会话日志" }, { status: 404 });
    }
    const scope = { sessionId }, library = await getHarmonyLogLibrary();
    const options = Object.fromEntries([...params].filter(([key]) => key !== "sessionId" && key !== "id"));
    if (request.method === "GET") {
      let value: unknown;
      switch (operation) {
        case "capabilities": value = { protocolVersion: 2, features: ["packages", "blocks", "favorites", "analysis-paths", "rar", "text-encodings", "cross-file-search", "direct-delete"], limits: { textBytes: 1024 ** 3, packageBytes: 2 * 1024 ** 3, expandedBytes: 8 * 1024 ** 3, pageLines: 1000 }, sessionId, storage: "session", plugin: "pioraHarmonyLogs" }; break;
        case "list": value = await library.list(Number(params.get("offset") || 0), Number(params.get("limit") || 20), scope, options); break;
        case "info": value = await library.info(params.get("id"), scope); break;
        case "logs": value = await library.getLogs(params.get("id"), options, scope, request.signal); break;
        case "search": value = await library.search(options, scope, request.signal); break;
        case "preferences": value = await library.preferences(scope); break;
        case "import-status": value = await library.importStatus(params.get("id"), scope); break;
        case "usage": value = await library.usage(scope); break;
        case "unassigned": value = await library.unassigned(scope); break;
        case "management/sessions": value = await library.management.sessions(options, scope); break;
        case "source": {
          const source = await library.source(params.get("id"), scope);
          const stream = createReadStream(source.path, { signal: request.signal });
          return new Response(Readable.toWeb(source.compressed ? stream.pipe(createGunzip()) : stream) as ReadableStream, { headers: {
            "Content-Type": /\.(zip|gz|rar)$/i.test(source.name) ? "application/octet-stream" : "text/plain; charset=utf-8",
            "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(source.name),
            "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
          } });
        }
        case "export": {
          const source = await library.export(params.get("id"), options, scope);
          const stream = Readable.from((async function* () { for await (const chunk of source) { if (request.signal.aborted) break; yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); } })());
          return new Response(Readable.toWeb(stream) as ReadableStream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Content-Disposition": "attachment; filename=filtered-logs.jsonl", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
        }
        default: return noStoreJson({ error: "未知日志操作" }, { status: 404 });
      }
      return noStoreJson(value);
    }
    if (operation === "chunk") return noStoreJson(await library.chunk(params.get("id"), Number(params.get("index")), await readChunk(request), scope));
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return noStoreJson({ error: "Content-Type must be application/json" }, { status: 415 });
    const body = await parseJsonWithinLimit(request, 512 * 1024) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new InvalidJsonBodyError();
    let value: unknown;
    switch (operation) {
      case "begin": value = await library.begin(body as Parameters<typeof library.begin>[0], scope); break;
      case "finish": value = await library.finish(body.id, scope); break;
      case "abort": value = await library.abort(body.id, scope); break;
      case "rename": value = await library.rename(body.id, body.name, scope); break;
      case "delete-permanently": value = await library.remove(body as Parameters<typeof library.remove>[0], scope); break;
      case "assign": value = await library.assign(body.id, scope); break;
      case "retry-package": value = await library.retryPackage(body.id, scope, body.encoding); break;
      case "preferences": value = await library.preferences(scope, body); break;
      case "analysis": value = await library.analysis(body as Parameters<typeof library.analysis>[0], scope); break;
      case "select": value = await library.select(body, scope); break;
      case "clear-analysis-cache": value = await library.clearAnalysisCache(scope); break;
      case "management/delete": {
        const plan = await library.management.prepare({ action: "delete", sessionIds: body.sessionIds }, scope);
        value = await library.management.execute({ token: plan.token, confirm: true }, scope); break;
      }
      default: return noStoreJson({ error: "未知日志操作" }, { status: 404 });
    }
    return noStoreJson(value);
  } catch (error) {
    return noStoreJson({ error: error instanceof Error ? error.message : String(error) }, { status: error instanceof JsonBodyTooLargeError ? 413 : 400 });
  }
}

export const GET = handle;
export const POST = handle;
