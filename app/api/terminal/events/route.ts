import { isTerminalSessionError } from "@/lib/terminal-session";
import { ShellError, isShellError } from "@/lib/shell/errors";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getLegacyTerminal, legacyTerminalEvent, legacyTerminalSnapshot } from "@/lib/shell/legacy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

export async function GET(request: Request) {
  try {
    if (!isApiRequestAllowed(request)) throw new ShellError("Untrusted API request", 403);
    const terminal = await getLegacyTerminal(new URL(request.url).searchParams.get("cwd"));
    await terminal.connect();
    let unsubscribe = () => {};
    let heartbeat: NodeJS.Timeout | null = null;
    let closed = false;
    let close = () => {};

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (value: unknown) => {
          if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
        };
        close = () => {
          if (closed) return;
          closed = true;
          unsubscribe();
          if (heartbeat) clearInterval(heartbeat);
          request.signal.removeEventListener("abort", close);
          try { controller.close(); } catch { /* The client may already be gone. */ }
        };
        send({ type: "snapshot", ...legacyTerminalSnapshot(terminal) });
        unsubscribe = terminal.subscribe(event => { const mapped = legacyTerminalEvent(event); if (mapped) send(mapped); });
        heartbeat = setInterval(() => {
          if (!closed) controller.enqueue(encoder.encode(": keepalive\n\n"));
        }, 15_000);
        heartbeat.unref?.();
        request.signal.addEventListener("abort", close, { once: true });
        if (request.signal.aborted) close();
      },
      cancel() {
        close();
      },
    });

    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    const status = isTerminalSessionError(error) || isShellError(error) ? error.status : 500;
    return new Response(error instanceof Error ? error.message : String(error), { status });
  }
}
