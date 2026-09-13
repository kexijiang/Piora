import type { SessionCommandEvent, SessionControlState } from "./session-message-types";

interface RemoteEventsInput {
  sessionId: string;
  after: number;
  signal: AbortSignal;
  authorize: () => void;
  router: {
    getState: (sessionId: string) => Promise<SessionControlState>;
    listEvents: (sessionId: string, after: number) => SessionCommandEvent[];
    subscribeEvents: (sessionId: string, listener: (event: SessionCommandEvent) => void) => () => void;
  };
}

export function createRemoteEventsStream(input: RemoteEventsInput): ReadableStream<Uint8Array> {
  let cleanup = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let replaying = true;
      let lastCursor = input.after;
      let lastWrite = Date.now();
      const timer: { current?: ReturnType<typeof setInterval> } = {};
      let unsubscribe: (() => void) | undefined;
      const pending: SessionCommandEvent[] = [];
      cleanup = () => {
        if (closed) return;
        closed = true;
        if (timer.current !== undefined) clearInterval(timer.current);
        input.signal.removeEventListener("abort", cleanup);
        unsubscribe?.();
        pending.length = 0;
        try { controller.close(); } catch {}
      };
      const end = (type: string, code: string) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode("data: " + JSON.stringify({ type, code }) + "\n\n")); } catch {}
        cleanup();
      };
      const authorized = () => {
        if (closed) return false;
        try { input.authorize(); return true; }
        catch { end("error", "REMOTE_ACCESS_ENDED"); return false; }
      };
      const write = (text: string) => {
        if (!authorized()) return false;
        const bytes = encoder.encode(text);
        if (bytes.byteLength > 65536 || (controller.desiredSize ?? 0) < bytes.byteLength) {
          end("stream.reset", "REMOTE_STREAM_BACKPRESSURE");
          return false;
        }
        try { controller.enqueue(bytes); lastWrite = Date.now(); return true; }
        catch { cleanup(); return false; }
      };
      const writeEvent = (event: SessionCommandEvent) => {
        if (closed || event.cursor <= lastCursor) return;
        if (write("id: " + event.cursor + "\ndata: " + JSON.stringify(event) + "\n\n")) lastCursor = event.cursor;
      };
      input.signal.addEventListener("abort", cleanup, { once: true });
      if (input.signal.aborted) { cleanup(); return; }
      if (!authorized()) return;
      try {
        unsubscribe = input.router.subscribeEvents(input.sessionId, (event) => {
          if (!authorized()) return;
          if (!replaying) { writeEvent(event); return; }
          if (pending.length >= 128 || encoder.encode(JSON.stringify(event)).byteLength > 65536) {
            end("stream.reset", "REMOTE_STREAM_BACKPRESSURE");
            return;
          }
          pending.push(event);
        });
        if (closed) { unsubscribe(); return; }
      } catch { end("error", "SESSION_NOT_FOUND"); return; }
      timer.current = setInterval(() => {
        if (authorized() && Date.now() - lastWrite >= 15000) write(":\n\n");
      }, 1000);
      void (async () => {
        try {
          const state = await input.router.getState(input.sessionId);
          if (!write("data: " + JSON.stringify({ type: "snapshot", sessionId: input.sessionId, state }) + "\n\n")) return;
          const events = [...input.router.listEvents(input.sessionId, input.after), ...pending.splice(0)].sort((left, right) => left.cursor - right.cursor);
          replaying = false;
          for (const event of events) writeEvent(event);
        } catch { if (authorized()) end("error", "SESSION_NOT_FOUND"); }
      })();
    },
    cancel() { cleanup(); },
  }, new ByteLengthQueuingStrategy({ highWaterMark: 262144 }));
}
