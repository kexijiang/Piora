import { getRoomTask, listRoomArtifacts, listRoomAudit, listRoomMessages, listRoomTasks, subscribeRoomEvents } from "@/lib/room-store";
import { projectRoomTaskRun } from "@/lib/task-run";
import { requireRoomMemberBySession } from "@/lib/team-agent-api";
import { subscribeRoomActivity } from "@/lib/room-activity-stream";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const room = requireRoomMemberBySession(id, new URL(request.url).searchParams.get("sessionId")).room;
    let cleanup = () => {};
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        let unsubscribe = () => {};
        let stopActivity = () => {};
        // Cleanup can run before interval creation, including an already aborted request.
        // eslint-disable-next-line prefer-const
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
          stopActivity();
          request.signal.removeEventListener("abort", cleanup);
          try { controller.close(); } catch { /* already closed */ }
        };
        request.signal.addEventListener("abort", cleanup, { once: true });
        if (request.signal.aborted) { cleanup(); return; }
        const send = (data: unknown) => {
          if (closed) return;
          try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch { cleanup(); }
        };
        const taskRunFor = (taskId: string) => projectRoomTaskRun(getRoomTask(id, taskId), listRoomArtifacts(id));
        unsubscribe = subscribeRoomEvents(id, (event) => {
          if (event.type === "task") send({ ...event, taskRun: projectRoomTaskRun(event.task, listRoomArtifacts(id)) });
          else if (event.type === "artifact" && event.artifact.taskId) send({ ...event, taskRun: taskRunFor(event.artifact.taskId) });
          else send(event);
        });
        const tasks = listRoomTasks(id);
        const artifacts = listRoomArtifacts(id);
        send({
          type: "snapshot",
          room,
          messages: listRoomMessages(id),
          tasks,
          taskRuns: tasks.map((task) => projectRoomTaskRun(task, artifacts)),
          artifacts,
          audit: listRoomAudit(id),
        });
        if (closed) return;
        stopActivity = subscribeRoomActivity(id, (activities) => send({ type: "activity", activities }));
        if (closed) { stopActivity(); return; }
        heartbeat = setInterval(() => {
          if (!closed) {
            try { controller.enqueue(encoder.encode(":\n\n")); } catch { cleanup(); }
          }
        }, 30_000);
      },
      cancel() { cleanup(); },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 404 });
  }
}
