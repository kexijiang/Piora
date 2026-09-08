import { createReadStream, existsSync } from "node:fs";
import { readFile, writeFile, open } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { backupJob, newBackupJob, exportApplicationBackup, previewApplicationBackup, prepareApplicationRestore, backupControlRoot } from "@/lib/app-backup";
import { getRuntimeAgentDataDirectory } from "@/lib/runtime-home";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { listAllSessions } from "@/lib/session-reader";
import { acquireDesktopUpdateLease, releaseDesktopUpdateLease } from "@/lib/prompt-run-registry";
import { getRunningRpcSessionIds } from "@/lib/rpc-manager";
import { parseJsonWithinLimit } from "@/lib/bounded-json";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };
function fail(error: unknown) { return Response.json({ error: error instanceof Error ? error.message : "backup_failed" }, { status: 400, headers }); }
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) return Response.json({ error: "Access denied" }, { status: 403 });
  const url = new URL(req.url);
  try {
    if (url.searchParams.get("action") === "client") { const file = path.join(getRuntimeAgentDataDirectory(), "piora/import-client.json"); return Response.json(existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : null, { headers }); }
    const file = path.join(backupJob(url.searchParams.get("id") ?? ""), "backup.piora");
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers: { ...headers, "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="piora-backup.piora"' } });
  } catch (error) { return fail(error); }
}
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) return Response.json({ error: "Access denied" }, { status: 403 });
  let handle;
  try {
    const id = await newBackupJob(); handle = await open(path.join(backupJob(id), "upload.piora"), "wx", 0o600);
    if (!req.body) throw new Error("backup_format");
    const reader = req.body.getReader(); let size = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 100 * 1024 ** 3) throw new Error("backup_limit"); let offset = 0; while (offset < value.length) { const result = await handle.write(value, offset); if (!result.bytesWritten) throw new Error("backup_write"); offset += result.bytesWritten; } } } finally { await reader.cancel(); reader.releaseLock(); }
    await handle.sync(); return Response.json({ id }, { headers });
  } catch (error) { return fail(error); } finally { await handle?.close(); }
}
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req) || !hasJsonContentType(req)) return Response.json({ error: "Access denied" }, { status: 403 });
  let lease: string | undefined; let refresh: ReturnType<typeof setInterval> | undefined; let prepared = false;
  try {
    const body = await parseJsonWithinLimit(req, 256 * 1024 ** 2) as { action?: string; id: string; password: string; client?: unknown; previousClient?: unknown; mappings: Array<{ from: string; to: string }> };
    if (!body || typeof body !== "object") throw new Error("backup_format");
    if (body.action === "preview") return Response.json({ manifest: await previewApplicationBackup(body.id, body.password) }, { headers });
    if (body.action !== "export" && body.action !== "prepare") throw new Error("backup_action");
    if (getRunningRpcSessionIds().length || existsSync(path.join(backupControlRoot(), "pending.json"))) throw new Error("backup_busy");
    lease = acquireDesktopUpdateLease(); if (!lease) throw new Error("backup_busy");
    refresh = setInterval(() => { const current = globalThis.__pioraDesktopUpdateLease; if (current && current.token === lease) current.expiresAt = Date.now() + 120_000; }, 30_000);
    if (body.action === "export") {
      const sessions = await listAllSessions();
      return Response.json(await exportApplicationBackup(body.password, body.client, sessions.filter((session) => !session.projectless).map((session) => session.projectRoot ?? session.cwd)), { headers });
    }
    if (!Array.isArray(body.mappings)) throw new Error("backup_mapping");
    await writeFile(path.join(backupJob(body.id), "previous-client.json"), JSON.stringify(body.previousClient), { mode: 0o600 });
    const result = await prepareApplicationRestore(body.id, body.mappings); prepared = true;
    return Response.json(result, { headers });
  } catch (error) { return fail(error); }
  finally { if (refresh) clearInterval(refresh); if (lease && !prepared) releaseDesktopUpdateLease(lease); }
}
