import { createAgentEventTransport } from "@/lib/agent-event-transport";
import { getAgentRuntimeProfile } from "@/lib/agent-runtime-profile";
import { resolveOrStartRpcSession } from "@/lib/session-runtime-resolver";
import { createChatCommandEventResponse } from "@/lib/chat-command-events";

export const dynamic = "force-dynamic";

// GET /api/agent/[id]/events - SSE stream of agent events
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (new URL(req.url).searchParams.get("scope") === "commands") return createChatCommandEventResponse(req, id);
  const runtimeProfile = getAgentRuntimeProfile();

  const sessionReady = resolveOrStartRpcSession(id, { runtimeProfile })
      .then(({ session }) => session)
      .catch((error) => {
        console.error(`[pi-web] failed to start agent for events: ${error}`);
        return null;
      });

  let cleanup = () => {};
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      let unsubscribe = () => {};
      const timers: { heartbeat?: ReturnType<typeof setInterval>; metrics?: ReturnType<typeof setInterval> } = {};
      const encoder = new TextEncoder();
      const transport = createAgentEventTransport((data) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); }
        catch { cleanup(); }
      }, { incremental: new URL(req.url).searchParams.get("transport") === "delta" });
      cleanup = () => {
        if (closed) return;
        closed = true;
        transport.close();
        if (timers.heartbeat) clearInterval(timers.heartbeat);
        if (timers.metrics) clearInterval(timers.metrics);
        unsubscribe();
        req.signal.removeEventListener("abort", cleanup);
        try { controller.close(); } catch { /* Already cancelled. */ }
      };
      // Bind cancellation before awaiting startup, including already-aborted requests.
      req.signal.addEventListener("abort", cleanup, { once: true });
      if (req.signal.aborted) { cleanup(); return; }
      const resolved = await sessionReady;
      if (closed) return;
      if (!resolved) {
        transport.push({ type: "error", message: "Failed to start agent session" });
        cleanup();
        return;
      }
      transport.push({ type: "connected", sessionId: id, runtimeProfile,
        answerOutputPreviews: resolved.getAnswerOutputPreviewSnapshot() });
      unsubscribe = resolved.onEvent((event) => transport.push(event));
      // Seed content and its server-owned rate immediately on session switch
      // or reconnect, including when the model is currently silent.
      const message = resolved.getStreamingMessage();
      if (message) transport.push({ type: "message_update", message });
      timers.metrics = setInterval(() => {
        const streamingMetrics = resolved.getStreamingMetrics();
        if (streamingMetrics) transport.push({ type: "message_metrics", streamingMetrics });
      }, 1_000);
      timers.heartbeat = setInterval(() => {
        if (!closed) {
          try { controller.enqueue(encoder.encode(":\n\n")); } catch { cleanup(); }
        }
      }, 30_000);
    },
    cancel() { cleanup(); },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
