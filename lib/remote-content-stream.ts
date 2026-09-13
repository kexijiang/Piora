export function createRemoteContentStream(input: { snapshot: () => Record<string,unknown>; authorize: () => void; alive?: () => boolean; signal: AbortSignal; intervalMs?: number }): ReadableStream<Uint8Array> {
  let cleanup = () => {};
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let last = "";
      let heartbeatAt = Date.now();
      let timer: ReturnType<typeof setInterval> | undefined;
      cleanup = () => { if (closed) return; closed = true; clearInterval(timer); input.signal.removeEventListener("abort", cleanup); try { controller.close(); } catch {} };
      const flush = () => {
        if (closed) return;
        try {
          input.authorize();
          if (input.alive?.() === false) { controller.enqueue(encoder.encode('data: {"type":"stream.reset","reason":"SESSION_RESTARTED"}\n\n')); cleanup(); return; }
          if ((controller.desiredSize ?? 0) <= 0) return;
          const next = JSON.stringify(input.snapshot());
          if (next !== last) { controller.enqueue(encoder.encode("data: " + next + "\n\n")); last = next; heartbeatAt = Date.now(); }
          else if (Date.now() - heartbeatAt > 15000) { controller.enqueue(encoder.encode(": heartbeat\n\n")); heartbeatAt = Date.now(); }
        } catch {
          try { controller.enqueue(encoder.encode('data: {"type":"error","code":"REMOTE_ACCESS_ENDED"}\n\n')); } catch {}
          cleanup();
        }
      };
      input.signal.addEventListener("abort", cleanup, { once: true });
      if (input.signal.aborted) { cleanup(); return; }
      flush();
      if (!closed) timer = setInterval(flush, input.intervalMs ?? 250);
    },
    cancel() { cleanup(); },
  });
}
