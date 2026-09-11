import type { ManagedShellSession } from "./session";
import type { ShellEvent } from "./types";

/** A detached or slow renderer must not retain an unbounded PTY output queue. */
export function shellEventStream(session: ManagedShellSession, request: Request): Response {
  const encoder = new TextEncoder();
  let close = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false, unsubscribe = () => {};
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      close = () => {
        if (closed) return;
        closed = true; unsubscribe(); clearInterval(heartbeat); heartbeat = undefined;
        request.signal.removeEventListener("abort", close);
        try { controller.close(); } catch { /* Reader already cancelled. */ }
      };
      const send = (data: string) => {
        if (closed) return;
        const bytes = encoder.encode(data);
        if (bytes.byteLength > (controller.desiredSize ?? 0)) { close(); return; }
        try { controller.enqueue(bytes); } catch { close(); }
      };
      const publish = (event: ShellEvent) => send(`id: ${event.generation}:${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
      request.signal.addEventListener("abort", close, { once: true });
      if (request.signal.aborted) { close(); return; }
      // Snapshot and subscription stay synchronous so no events fall in a gap.
      const snapshot = session.snapshot();
      publish({ type: "snapshot", snapshot, terminalId: session.state.id, generation: session.state.generation, sequence: snapshot.sequence });
      if (closed) return;
      unsubscribe = session.subscribe(publish);
      heartbeat = setInterval(() => send(": keepalive\n\n"), 15_000);
      heartbeat.unref();
    },
    cancel() { close(); },
  }, { highWaterMark: 16 * 1024 * 1024, size: chunk => chunk.byteLength });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
}
