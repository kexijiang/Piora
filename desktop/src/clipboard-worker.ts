import { parentPort, workerData } from "node:worker_threads";
import { ClipboardDatabase } from "./clipboard-database.js";
import { exportClipboardArchive, importClipboardArchive, removeClipboardStage } from "./clipboard-archive.js";
import { join } from "node:path";
import type { ClipboardCapture, ClipboardMutation, ClipboardQuery } from "./clipboard-types.js";

if (!parentPort || typeof workerData?.directory !== "string") throw new Error("Invalid clipboard worker setup");
const port = parentPort;
let database: ClipboardDatabase;
try {
  database = new ClipboardDatabase(workerData.directory, Date.now, { maintenance: !workerData.snapshot });
  port.postMessage({ ready: true });
} catch (cause) {
  port.postMessage({ ready: false, error: cause instanceof Error ? cause.message : String(cause) });
  port.close();
}
const jobs = new Set<Promise<void>>();
const queries = new Map<string, { requestId: number | undefined; cancelled: boolean }>();
let closing = false;
async function dispatch(request: { id: number; method: string; value?: unknown }) {
  try {
    if (closing) throw new Error("剪贴板存储正在关闭。");
    let result: unknown;
    switch (request.method) {
      case "query": {
        const { query, scope } = request.value as { query: ClipboardQuery; scope?: string };
        const token = { requestId: query?.requestId, cancelled: false };
        if (scope) { const previous = queries.get(scope); if (previous) previous.cancelled = true; queries.set(scope, token); }
        try { result = await database.queryAsync(query, () => token.cancelled || closing); }
        finally { if (scope && queries.get(scope) === token) queries.delete(scope); }
        break;
      }
      case "cancel-query": {
        const value = request.value as { scope: string; requestId?: number };
        const token = queries.get(value.scope);
        if (token && (value.requestId === undefined || token.requestId === value.requestId)) token.cancelled = true;
        break;
      }
      case "detail": result = database.detail(String(request.value)); break;
      case "status": result = database.status(); break;
      case "settings": result = database.settings(); break;
      case "capture": result = database.capture(request.value as ClipboardCapture); break;
      case "mutate": result = database.mutate(request.value as ClipboardMutation); break;
      case "asset": result = database.assetForClip(String(request.value)); break;
      case "prune": result = database.prune(); break;
      case "snapshot": {
        if (typeof request.value !== "string" || !/^[a-f0-9-]{36}$/.test(request.value)) throw new Error("快照标识无效。");
        const directory = join(database.directory, "snapshots", request.value);
        try { database.createSnapshot(directory); result = directory; }
        catch (error) { await removeClipboardStage(join(database.directory, "snapshots"), directory); throw error; }
        break;
      }
      case "remove-snapshot": {
        if (typeof request.value !== "string" || !/^[a-f0-9-]{36}$/.test(request.value)) throw new Error("快照标识无效。");
        await removeClipboardStage(join(database.directory, "snapshots"), join(database.directory, "snapshots", request.value)); break;
      }
      case "export": await exportClipboardArchive(database, String(request.value)); break;
      case "import": result = await importClipboardArchive(database, String(request.value)); break;
      case "close": closing = true; await Promise.allSettled([...jobs]); database.close(); port.postMessage({ id: request.id, result: null }); port.close(); return;
      default: throw new Error("Unknown clipboard worker request");
    }
    port.postMessage({ id: request.id, result });
  } catch (cause) { port.postMessage({ id: request.id, error: cause instanceof Error ? cause.message : String(cause) }); }
}
port.on("message", (request: { id: number; method: string; value?: unknown }) => {
  const job = dispatch(request);
  // close captures the existing jobs before its first await; it must not await itself.
  if (request.method !== "close") { jobs.add(job); void job.finally(() => jobs.delete(job)); }
});
