import { resolveSessionPath } from "@/lib/session-reader";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

/** Read-only fallback contract; it never enables tools or creates an AgentSession. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (!isApiRequestAllowed(request)) return json({ error: "Forbidden" }, 403);
  const query = new URL(request.url).searchParams;
  const toolCallId = query.get("toolCallId");
  if (query.get("kind") !== "intelligent-ui" || !toolCallId || toolCallId.length > 256) return json({ error: "Unknown answer output" }, 400);
  try {
    const { id } = await context.params;
    const path = await resolveSessionPath(id);
    if (!path) return json({ error: "Session not found" }, 404);
    const { getSurfaceState } = await import("@/lib/intelligent-ui/store");
    const { intelligentUiSessionReader } = await import("@/lib/intelligent-ui/session");
    const manager = (await intelligentUiSessionReader(id, path))();
    const { snapshot } = getSurfaceState(id, manager.getBranch(), toolCallId);
    return json({ snapshot });
  } catch {
    return json({ error: "Saved output is unavailable on the current branch" }, 404);
  }
}
