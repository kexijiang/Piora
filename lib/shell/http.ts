import path from "node:path";
import { homedir } from "node:os";
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isApiRequestAllowed, hasJsonContentType } from "../request-security";
import { parseJsonWithinLimit, InvalidJsonBodyError, JsonBodyTooLargeError } from "../bounded-json";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "../file-access";
import { isTerminalSessionError } from "../terminal-session";
import { createShell, getShell, listShells, closeShell, ensureDefaultShell } from "./registry";
import { getShellStore } from "./store";
import { ShellError, isShellError, shellId, shellText } from "./errors";
import { discoverShellProfiles, resolveShellProfile } from "./profiles";
import { readShellSettings, writeShellSettings, normalizeShellModel, normalizeShellSettings } from "./settings";
import { discoverHistorySources, syncShellHistory } from "./history";
import { shellCompletions, commandCatalog } from "./completions";
import { classifyShellInput } from "./intent";
import { startShellAgent, controlShellAgent, normalizeShellReferences } from "./agent";
import { searchHistoryByIntent, normalizeHistoryFilters } from "./history-search";
import type { ShellEvent, HistoryQuery, HistoryRecord, ShellInputMode } from "./types";
import type { ManagedShellSession } from "./session";

function json(value: unknown, status = 200) { return Response.json(value, { status, headers: { "Cache-Control": "no-store" } }); }
function eventStream(session: ManagedShellSession, request: Request): Response {
  const encoder = new TextEncoder();
  let unsubscribe = () => {}, close = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: ShellEvent) => { if (!closed) controller.enqueue(encoder.encode(`id: ${event.generation}:${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`)); };
      // Snapshot and subscription happen without awaiting, so events cannot fall into a gap.
      const snapshot = session.snapshot();
      send({ type: "snapshot", snapshot, terminalId: session.state.id, generation: session.state.generation, sequence: snapshot.sequence });
      unsubscribe = session.subscribe(send);
      const heartbeat = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(": keepalive\n\n")); }, 15000);
      heartbeat.unref();
      close = () => { if (closed) return; closed = true; unsubscribe(); clearInterval(heartbeat); request.signal.removeEventListener("abort", close); try { controller.close(); } catch { /* Disconnected. */ } };
      request.signal.addEventListener("abort", close, { once: true });
      if (request.signal.aborted) close();
    },
    cancel() { close(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
}

export async function handleShellRequest(request: Request, parts: string[]): Promise<Response> {
  try {
    if (!isApiRequestAllowed(request)) throw new ShellError("Untrusted API request", 403);
    const url = new URL(request.url);
    const endpoint = parts.join("/");
    const method = request.method;
    const store = getShellStore();
    if (method === "GET") {
      if (endpoint === "profiles") return json({ profiles: await discoverShellProfiles() });
      if (endpoint === "settings") return json(await readShellSettings());
      if (endpoint === "sessions") return json({ sessions: await listShells(shellText(url.searchParams.get("cwd"), "cwd", 4096)) });
      if (endpoint === "history") {
        const query: HistoryQuery = { query: (url.searchParams.get("q") || "").slice(0, 500), limit: Number(url.searchParams.get("limit")) || 50, offset: Number(url.searchParams.get("offset")) || 0, favorite: url.searchParams.get("favorite") === "true", suggestions: url.searchParams.get("suggestions") === "true" };
        for (const key of ["cwd", "shell", "source", "status"] as const) { const value = url.searchParams.get(key); if (value) Object.assign(query, { [key]: value }); }
        // Do not put an import ahead of a latency-sensitive autocomplete query.
        void syncShellHistory().catch(() => {});
        return json(await store.history(query));
      }
      if (endpoint === "history/sources") {
        const [discovered, settings] = await Promise.all([discoverHistorySources(), readShellSettings()]);
        await store.ready;
        return json({ discovered, configured: settings.sources, status: await store.call("getValue", { key: "source-status" }) || [] });
      }
      if (parts[0] === "sessions" && parts[1]) {
        const session = await getShell(parts[1]);
        if (parts.length === 2) return json(session.snapshot());
        if (parts[2] === "events") return eventStream(session, request);
        if (parts[2] === "completions") return json(await shellCompletions(session, (url.searchParams.get("q") || "").slice(0, 4096)));
        if (parts[2] === "commands") return json({ commands: await store.list("command", session.state.id, 50, Number(url.searchParams.get("offset")) || 0) });
        if (parts[2] === "timeline") {
          const cursor = url.searchParams.get("before"), before = cursor ? Number(cursor) : undefined;
          if (cursor && (!/^\d+$/.test(cursor) || !Number.isSafeInteger(before) || before! <= 0)) throw new ShellError("Invalid history cursor");
          return json(await store.call("timeline", { terminalId: session.state.id, before }));
        }
      }
      if (parts[0] === "history" && parts.length === 2) {
        await store.ready;
        const records = await store.call<HistoryRecord[]>("getHistoryRecords", { ids: [shellId(parts[1])] });
        return json({ record: records[0] || null });
      }
    }
    if (method === "DELETE") {
      if (parts[0] === "sessions" && parts.length === 2) { await closeShell(shellId(parts[1])); return json({ success: true }); }
      if (parts[0] === "history" && parts.length === 2) { await store.ready; await store.call("deleteHistory", { id: shellId(parts[1]) }); return json({ success: true }); }
    }
    if (method !== "POST" && method !== "PATCH") throw new ShellError("Shell endpoint not found", 404);
    if (!hasJsonContentType(request)) throw new ShellError("Content-Type must be application/json", 415);
    const body = await parseJsonWithinLimit(request, 512 * 1024);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ShellError("Request must be a JSON object");
    const data = body as Record<string, unknown>;
    if (endpoint === "settings") {
      const settings = normalizeShellSettings(data);
      if (settings.executable) await resolveShellProfile(settings.executable);
      const roots = new Set(await getAllowedFileRoots()); roots.add(homedir());
      const previous = await readShellSettings();
      for (const source of settings.sources) {
        // A moved/deleted file must still be disableable. Re-enabling it, or
        // changing its identity/path, always repeats the filesystem check.
        if (!source.enabled && previous.sources.some(item => item.id === source.id && item.path === source.path && item.kind === source.kind)) continue;
        if (!path.isAbsolute(source.path) || !isExistingFilePathAllowed(source.path, roots) || !await stat(source.path).then(file => file.isFile(), () => false)) throw new ShellError("History source must be an existing file in the allowed user/workspace paths", 403);
      }
      return json(await writeShellSettings(settings));
    }
    if (endpoint === "sessions") {
      const cwd = shellText(data.cwd, "cwd", 4096);
      const session = data.ensure === true ? await ensureDefaultShell(cwd) : await createShell(cwd, typeof data.executable === "string" ? data.executable : null);
      return json(session.snapshot(), 201);
    }
    if (endpoint === "history/sync") return json({ sources: await syncShellHistory(true) });
    if (endpoint === "history/search") return json(await searchHistoryByIntent(await getShell(shellId(data.terminalId)), shellText(data.query, "query", 2000), request.signal, normalizeHistoryFilters(data.filters)));
    if (endpoint === "history/migrate") {
      if (!Array.isArray(data.entries) || data.entries.length > 1000) throw new ShellError("Invalid legacy history batch");
      const records: HistoryRecord[] = data.entries.map(entry => {
        if (!entry || typeof entry !== "object") throw new ShellError("Invalid history entry");
        const item = entry as Record<string, unknown>;
        const command = shellText(item.command, "command"), cwd = shellText(item.cwd, "cwd", 4096);
        return { id: "legacy:" + createHash("sha256").update(cwd + "\0" + command).digest("hex"), sourceId: "legacy-browser", source: "legacy", command, cwd, shell: null, executedAt: null, importedAt: Date.now(), exitCode: null, status: null, favorite: false, terminalId: null, sessionId: null };
      });
      await store.recordHistory(records); return json({ durable: true, count: records.length });
    }
    if (parts[0] === "history" && parts.length === 2) { await store.ready; const changed = await store.call("favoriteHistory", { id: shellId(parts[1]), favorite: data.favorite === true }); if (!changed) throw new ShellError("History record is unavailable", 404); return json({ success: true }); }
    if (parts[0] === "sessions" && parts[1]) {
      const session = await getShell(parts[1]);
      if (parts.length === 2 && method === "PATCH") {
        if (typeof data.draft === "string") await session.saveDraft(data.draft);
        if (data.model !== undefined || data.title !== undefined) await session.savePreferences({ ...(data.model !== undefined ? { model: normalizeShellModel(data.model) } : {}), ...(data.title !== undefined ? { title: shellText(data.title, "title", 100) } : {}) });
        return json(session.snapshot());
      }
      if (parts[2] === "actions") {
        switch (data.action) {
          case "start": await session.start(); break;
          case "submit": {
            const text = shellText(data.text, "input", 32000);
            const mode = data.mode === "command" || data.mode === "agent" ? data.mode : "auto" as ShellInputMode;
            const requestId = shellId(data.clientRequestId);
            const receipt = await store.call<{ kind: "command" | "run" } | null>("getRequest", { terminalId: session.state.id, requestId });
            const admittedIntent = receipt?.kind === "run" ? "agent" : receipt?.kind;
            if (admittedIntent && mode !== "auto" && mode !== admittedIntent) throw new ShellError("Request id was already used with a different execution mode", 409);
            // Alias/PATH changes after admission must not reinterpret a retry.
            // The executor below validates the original content fingerprint.
            const intent = admittedIntent || classifyShellInput(text, await commandCatalog(session), mode);
            if (intent === "ambiguous") return json({ intent, accepted: false });
            if (intent === "command") return json({ accepted: true, durable: true, command: await session.execute(text, requestId) });
            return json({ accepted: true, durable: true, run: await startShellAgent(session, text, requestId, normalizeShellReferences(data.references)) });
          }
          case "input":
            if (data.generation !== undefined && data.generation !== session.state.generation) throw new ShellError("Terminal restarted before the input arrived", 409, "stale_terminal_input");
            session.input(typeof data.data === "string" ? data.data : "", data.replay === true); break;
          case "resize": session.resize(Number(data.cols), Number(data.rows)); break;
          case "clear": session.clear(); break;
          case "restart": if (session.state.activeRunId) await controlShellAgent(session, "cancel"); await session.stop(); await session.start(); break;
          case "cancel": case "takeover": case "approve": case "reject": case "answer": await controlShellAgent(session, data.action, typeof data.id === "string" ? data.id : undefined, typeof data.answer === "string" ? data.answer : undefined); break;
          default: throw new ShellError("Unsupported Shell action");
        }
        return json(session.snapshot());
      }
    }
    throw new ShellError("Shell endpoint not found", 404);
  } catch (error) {
    const status = isShellError(error) || isTerminalSessionError(error) ? error.status : error instanceof JsonBodyTooLargeError ? 413 : error instanceof InvalidJsonBodyError ? 400 : 500;
    return json({ error: error instanceof Error ? error.message : String(error), code: isShellError(error) ? error.code : "shell_error" }, status);
  }
}
