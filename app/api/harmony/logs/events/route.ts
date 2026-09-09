import { getHarmonyDeviceManager, type HarmonyLogEntry } from "@/lib/harmony";
import { harmonyErrorResponse, requireHarmonyAccess, requiredQuery } from "../../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request);
  if (denied) return denied;
  let serial: string;
  try { serial = requiredQuery(request, "serial"); } catch (error) { return harmonyErrorResponse(error); }
  const encoder = new TextEncoder();
  const abort = new AbortController();
  let cleanup = () => abort.abort();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false, pending: HarmonyLogEntry[] = [], dropped = 0;
      const send = (event: { type: string; [key: string]: unknown }) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)); } catch { cleanup(); }
      };
      const flush = () => {
        if (!pending.length || (controller.desiredSize ?? 0) < 0) return;
        send({ type: "logs", entries: pending, dropped }); pending = []; dropped = 0;
      };
      const batch = setInterval(flush, 100);
      const heartbeat = setInterval(() => { if ((controller.desiredSize ?? 0) >= 0) send({ type: "heartbeat" }); }, 15_000);
      cleanup = () => {
        if (closed) return;
        closed = true; clearInterval(batch); clearInterval(heartbeat);
        request.signal.removeEventListener("abort", cleanup); abort.abort();
        try { controller.close(); } catch { /* Client already disconnected. */ }
      };
      request.signal.addEventListener("abort", cleanup, { once: true });
      if (request.signal.aborted) { cleanup(); return; }
      send({ type: "connected" });
      void getHarmonyDeviceManager().streamLogs(serial, (entries) => {
        pending.push(...entries);
        if (pending.length > 2000) { dropped += pending.length - 2000; pending = pending.slice(-2000); }
      }, abort.signal).catch((error) => {
        flush(); send({ type: "error", message: error instanceof Error ? error.message : String(error) });
      }).finally(cleanup);
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, { headers: {
    "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "private, no-cache, no-store", Connection: "keep-alive", "X-Accel-Buffering": "no",
  } });
}
