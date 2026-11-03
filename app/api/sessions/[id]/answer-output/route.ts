import { resolveSessionPath } from "@/lib/session-reader";
import { isApiRequestAllowed } from "@/lib/request-security";
import { answerOutputDescriptor } from "@/lib/answer-output-catalog";

export const dynamic = "force-dynamic";

/** Read-only fallback contract; it never enables tools or creates an AgentSession. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (!isApiRequestAllowed(request)) return json({ error: "Forbidden" }, 403);
  const query = new URL(request.url).searchParams;
  const toolCallId = query.get("toolCallId");
  const kind = query.get("kind") ?? "";
  if (!answerOutputDescriptor(kind) || !toolCallId || toolCallId.length > 256) return json({ error: "Unknown answer output" }, 400);
  try {
    const { id } = await context.params;
    const path = await resolveSessionPath(id);
    if (!path) return json({ error: "Session not found" }, 404);
    const { readAnswerOutputSavedSnapshot } = await import("@/lib/answer-output-server");
    const snapshot = await readAnswerOutputSavedSnapshot(kind, id, path, toolCallId);
    return json({ snapshot });
  } catch {
    return json({ error: "Saved output is unavailable on the current branch" }, 404);
  }
}
