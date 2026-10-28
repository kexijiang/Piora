import { resolveSessionPath } from "@/lib/session-reader";
import { readBetaFeatures } from "@/lib/beta-features";
import { JsonBodyTooLargeError, parseJsonWithinLimit } from "@/lib/bounded-json";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getSurfaceState, saveSurfaceState, UiStateError } from "@/lib/intelligent-ui/store";
import { intelligentUiSessionReader } from "@/lib/intelligent-ui/session";

export const dynamic = "force-dynamic";
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const failure = (error: unknown) => json({ error: error instanceof Error ? error.message : "UI state unavailable" }, error instanceof UiStateError ? error.status : error instanceof JsonBodyTooLargeError ? 413 : 400);
type Context = { params: Promise<{ id: string }> };
async function sessionPath(id: string) {
  const path = await resolveSessionPath(id);
  if (!path) throw new UiStateError("Session not found", 404);
  return path;
}
export async function GET(request: Request, context: Context) {
  if (!isApiRequestAllowed(request)) return json({ error: "Forbidden" }, 403);
  try {
    const { id } = await context.params, query = new URL(request.url).searchParams;
    const toolCallId = query.get("toolCallId"), leafId = query.get("leafId");
    if (!toolCallId || toolCallId.length > 256) throw new UiStateError("toolCallId is required");
    const manager = (await intelligentUiSessionReader(id, await sessionPath(id)))();
    if (leafId && !manager.getEntry(leafId)) throw new UiStateError("Branch not found", 404);
    return json(getSurfaceState(id, manager.getBranch(leafId ?? undefined), toolCallId));
  } catch (error) { return failure(error); }
}
export async function PUT(request: Request, context: Context) {
  if (!isApiRequestAllowed(request)) return json({ error: "Forbidden" }, 403);
  if (!hasJsonContentType(request)) return json({ error: "Content-Type must be application/json" }, 415);
  try {
    if (!readBetaFeatures().intelligentUi) throw new UiStateError("Intelligent UI is disabled", 403);
    const { id } = await context.params;
    const body = await parseJsonWithinLimit(request, 32_000) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.toolCallId !== "string" || body.toolCallId.length > 256 || typeof body.leafId !== "string" || body.leafId.length > 256 || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0) throw new UiStateError("Invalid UI state request");
    const path = await sessionPath(id);
    const readManager = await intelligentUiSessionReader(id, path);
    try {
      return json(await saveSurfaceState({ sessionId: id, toolCallId: body.toolCallId, leafId: body.leafId, expectedRevision: Number(body.expectedRevision), state: body.state,
        branch: () => readManager().getBranch(), allEntries: () => readManager().getEntries(), enabled: () => readBetaFeatures().intelligentUi,
        canAdvanceLeaf: (from, branch) => {
          const start = branch.findIndex(entry => entry.id === from);
          if (start < 0) return false;
          const entries = readManager().getEntries();
          // Ordinary streamed continuation may advance the leaf. A branching
          // edge is ambiguous and requires the user to reload instead.
          return branch.slice(start, -1).every(entry => entries.filter(candidate => candidate.parentId === entry.id).length === 1);
        } }));
    } catch (error) {
      if (error instanceof UiStateError && error.status === 409) {
        try { return json({ error: error.message, current: getSurfaceState(id, readManager().getBranch(), body.toolCallId) }, 409); } catch { /* Surface no longer belongs to the current branch. */ }
      }
      throw error;
    }
  } catch (error) { return failure(error); }
}
