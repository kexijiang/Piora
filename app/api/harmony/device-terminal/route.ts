import { getDeviceTerminal, startDeviceTerminal, controlDeviceTerminal } from "@/lib/harmony/device-terminal";
import { HarmonyError } from "@/lib/harmony/errors";
import type { HarmonyFileScope } from "@/lib/harmony/device-files";
import { InvalidJsonBodyError, JsonBodyTooLargeError, parseJsonWithinLimit } from "@/lib/bounded-json";
import { hasJsonContentType } from "@/lib/request-security";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../_shared";

export const dynamic = "force-dynamic";

// A 16 Ki-character terminal input can exceed 24 KiB in UTF-8 and reach
// 96 KiB when JSON escapes individual code units. Keep the entire request
// bounded while allowing the terminal's existing character limit.
const MAX_TERMINAL_REQUEST_BYTES = 128 * 1024;

export async function POST(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  if (!hasJsonContentType(request)) return noStoreJson({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const body = await parseJsonWithinLimit(request, MAX_TERMINAL_REQUEST_BYTES) as Record<string, unknown>;
    if (!body || typeof body.action !== "string") throw new HarmonyError("INVALID_ARGUMENT", "Choose a terminal action");
    if (body.action === "start") {
      if (typeof body.serial !== "string" || typeof body.leaseToken !== "string" || (body.kind !== "shared" && body.kind !== "sandbox")
        || (body.kind === "sandbox" && typeof body.bundleName !== "string")) throw new HarmonyError("INVALID_ARGUMENT", "Choose a device and terminal scope");
      if (body.clientTerminalId !== undefined && typeof body.clientTerminalId !== "string") throw new HarmonyError("INVALID_ARGUMENT", "Invalid device terminal tab identity");
      const scope: HarmonyFileScope = body.kind === "shared" ? { kind: "shared" } : { kind: "sandbox", bundleName: body.bundleName as string };
      return noStoreJson({ id: await startDeviceTerminal(body.serial, body.leaseToken, scope, body.clientTerminalId as string | undefined) });
    }
    if (typeof body.id !== "string" || typeof body.leaseToken !== "string" || !["input", "resize", "keepalive", "stop"].includes(body.action)) {
      throw new HarmonyError("INVALID_ARGUMENT", "Invalid terminal action");
    }
    controlDeviceTerminal(body.id, body.leaseToken, body.action as "input" | "resize" | "keepalive" | "stop",
      typeof body.data === "string" ? body.data : undefined,
      typeof body.cols === "number" ? body.cols : undefined, typeof body.rows === "number" ? body.rows : undefined);
    return noStoreJson({ ok: true });
  } catch (error) {
    if (error instanceof JsonBodyTooLargeError) return noStoreJson({ error: "Request body is too large" }, { status: 413 });
    if (error instanceof InvalidJsonBodyError) return noStoreJson({ error: "Invalid JSON body" }, { status: 400 });
    return harmonyErrorResponse(error);
  }
}

export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  let terminal;
  try { terminal = getDeviceTerminal(new URL(request.url).searchParams.get("id") ?? ""); }
  catch (error) { return harmonyErrorResponse(error); }
  const encoder = new TextEncoder();
  let unsubscribe: () => void = () => undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: unknown) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); }
        catch { closed = true; }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
        try { controller.close(); } catch { /* Already closed. */ }
      };
      unsubscribe = terminal.subscribe(send);
      heartbeat = setInterval(() => send({ type: "heartbeat" }), 15_000);
      request.signal.addEventListener("abort", close, { once: true });
    },
    cancel() { unsubscribe(); if (heartbeat) clearInterval(heartbeat); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "private, no-cache, no-store",
    Connection: "keep-alive", "X-Accel-Buffering": "no" } });
}
