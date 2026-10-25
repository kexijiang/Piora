import { getSessionMessageRouter } from "./session-message-router";
import type { SessionCommandEvent, SessionCommandRecord } from "./session-message-types";

export function commandOperationView(record: SessionCommandRecord) {
  return { commandId: record.commandId, idempotencyKey: record.idempotencyKey, targetSessionId: record.targetSessionId, status: record.status, revision: record.revision, queuePaused: record.queuePaused ?? false,
    acceptedAt: record.acceptedAt, operation: record.operation, errorCode: record.errorCode, errorMessage: record.errorMessage,
    preview: record.content.slice(0, 180), attachments: (record.images?.length ?? 0) + (record.materials?.length ?? 0) + (record.localFiles?.length ?? 0) };
}

export function createChatCommandEventResponse(request: Request, sessionId: string): Response {
  const router = getSessionMessageRouter();
  let cleanup = () => {};
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let initializing = true;
      const buffered: SessionCommandEvent[] = [];
      const send = (value: unknown, cursor?: number) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`${cursor === undefined ? "" : `id: ${cursor}\n`}data: ${JSON.stringify(value)}\n\n`)); }
        catch { cleanup(); }
      };
      const unsubscribe = router.subscribeEvents(sessionId, event => {
        if (initializing) buffered.push(event);
        else if (event.source === "ui" || event.operation) send(event, event.cursor);
      });
      const heartbeat = setInterval(() => { if (!closed) { try { controller.enqueue(encoder.encode(":\n\n")); } catch { cleanup(); } } }, 30_000);
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        request.signal.removeEventListener("abort", cleanup);
        try { controller.close(); } catch { }
      };
      request.signal.addEventListener("abort", cleanup, { once: true });
      if (request.signal.aborted) { cleanup(); return; }
      try {
        const cursor = router.listEvents(sessionId).at(-1)?.cursor ?? 0;
        const operations = await router.listOperations(sessionId);
        if (closed) return;
        const recent = operations.slice(-50);
        const visible = new Map(recent.map(command => [command.commandId, command]));
        for (const command of operations) if (!["completed", "failed", "cancelled", "expired", "interrupted"].includes(command.status)) visible.set(command.commandId, command);
        send({ type: "command_snapshot", operations: [...visible.values()].map(commandOperationView), hasMore: operations.length > 50, cursor }, cursor);
        initializing = false;
        for (const event of buffered) if (event.cursor > cursor && (event.source === "ui" || event.operation)) send(event, event.cursor);
        if (operations.some(command => command.status === "accepted" || command.status === "queued")) void router.resumeSession(sessionId);
      } catch {
        send({ type: "command_stream_error", message: "Command state is unavailable" });
        cleanup();
      }
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
}
