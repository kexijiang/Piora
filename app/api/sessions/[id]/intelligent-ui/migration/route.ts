import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveSessionPath } from "@/lib/session-reader";
import { readBetaFeatures } from "@/lib/beta-features";
import { JsonBodyTooLargeError, parseJsonWithinLimit } from "@/lib/bounded-json";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { intelligentUiSessionReader } from "@/lib/intelligent-ui/session";
import { UiGenerationPrototype, isUiGenerationError } from "@/lib/intelligent-ui/generation-journal";
import { confirmUiMigration } from "@/lib/intelligent-ui/confirm-migration";
import { isSessionOwnershipError } from "@/lib/session-file-ownership";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const failure = (error: unknown) => json({ error: error instanceof Error ? error.message : "Migration unavailable" },
  error instanceof JsonBodyTooLargeError ? 413 : isUiGenerationError(error) || isSessionOwnershipError(error) ? 409 : 400);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;

export async function GET(request: Request, context: Context) {
  if (!isApiRequestAllowed(request)) return json({ error: "Forbidden" }, 403);
  if (!readBetaFeatures().intelligentUi) return json({ error: "Intelligent UI is disabled" }, 403);
  try {
    const { id } = await context.params, toolCallId = new URL(request.url).searchParams.get("toolCallId");
    if (!text(toolCallId)) return json({ error: "toolCallId is required" }, 400);
    const path = await resolveSessionPath(id);
    if (!path) return json({ error: "Session not found" }, 404);
    const manager = (await intelligentUiSessionReader(id, path))();
    return json({ review: await new UiGenerationPrototype({ manager, root: getAgentDir() }).readMigration(toolCallId) });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request, context: Context) {
  if (!isApiRequestAllowed(request)) return json({ error: "Forbidden" }, 403);
  if (!hasJsonContentType(request)) return json({ error: "Content-Type must be application/json" }, 415);
  if (!readBetaFeatures().intelligentUi) return json({ error: "Intelligent UI is disabled" }, 403);
  try {
    const { id } = await context.params;
    const body = await parseJsonWithinLimit(request, 32_000) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some(key => !["proposalId", "digest", "leafId", "requestId", "decision", "state"].includes(key))
      || !text(body.proposalId) || !text(body.digest) || !text(body.leafId) || !text(body.requestId)
      || body.decision !== "confirm" && body.decision !== "cancel") return json({ error: "Invalid confirmation request" }, 400);
    const path = await resolveSessionPath(id);
    if (!path) return json({ error: "Session not found" }, 404);
    return json(await confirmUiMigration({ sessionId: id, sessionFile: path, signal: request.signal,
      enabled: () => readBetaFeatures().intelligentUi,
      input: { proposalId: body.proposalId, digest: body.digest, leafId: body.leafId, requestId: body.requestId,
        decision: body.decision, state: body.state } }));
  } catch (error) { return failure(error); }
}
