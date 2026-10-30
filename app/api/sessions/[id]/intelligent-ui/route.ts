import { resolveSessionPath } from "@/lib/session-reader";
import { readBetaFeatures } from "@/lib/beta-features";
import { JsonBodyTooLargeError, parseJsonWithinLimit } from "@/lib/bounded-json";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { UiStateError, isUiStateError } from "@/lib/intelligent-ui/store";
import { intelligentUiSessionReader } from "@/lib/intelligent-ui/session";
import { readUiOutput } from "@/lib/intelligent-ui/read-output";
import { isUiGenerationError } from "@/lib/intelligent-ui/generation-journal";
import { isSessionOwnershipError } from "@/lib/session-file-ownership";
import { saveUiOutput } from "@/lib/intelligent-ui/write-output";

export const dynamic = "force-dynamic";
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const failure = (error: unknown) => json({ error: error instanceof Error ? error.message : "UI state unavailable" }, isUiStateError(error) ? error.status : isUiGenerationError(error) || isSessionOwnershipError(error) ? 409 : error instanceof JsonBodyTooLargeError ? 413 : 400);
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
    const requiredAncestorLeafId = query.get("requiredAncestorLeafId");
    if (requiredAncestorLeafId !== null && (!requiredAncestorLeafId || requiredAncestorLeafId.length > 256)) throw new UiStateError("Invalid draft branch anchor");
    const manager = (await intelligentUiSessionReader(id, await sessionPath(id)))();
    // Migration is allowed only along the active branch. An explicit historical
    // leaf must not turn a sibling draft into a valid current-branch source.
    if (requiredAncestorLeafId !== null && (leafId !== null && leafId !== manager.getLeafId()
      || !manager.getBranch().some(entry => entry.id === requiredAncestorLeafId))) {
      throw new UiStateError("The draft belongs to another branch. Return to its branch before migrating it.", 409);
    }
    return json(await readUiOutput(manager, toolCallId, { leafId }));
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
      return json(await saveUiOutput({ sessionId: id, toolCallId: body.toolCallId, leafId: body.leafId, expectedRevision: Number(body.expectedRevision), state: body.state,
        readManager, enabled: () => readBetaFeatures().intelligentUi }));
    } catch (error) {
      if (isUiStateError(error) && error.status === 409 || isUiGenerationError(error) || isSessionOwnershipError(error)) {
        try { return json({ error: error.message, current: await readUiOutput(readManager(), body.toolCallId) }, 409); } catch { /* Surface no longer belongs to the current branch. */ }
      }
      throw error;
    }
  } catch (error) { return failure(error); }
}
