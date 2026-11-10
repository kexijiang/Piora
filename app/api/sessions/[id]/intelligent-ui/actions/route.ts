import { resolveSessionPath } from "@/lib/session-reader";
import { readBetaFeatures } from "@/lib/beta-features";
import { JsonBodyTooLargeError, parseJsonWithinLimit } from "@/lib/bounded-json";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { readUiActions, startUiAction, controlUiAction } from "@/lib/intelligent-ui/action-service";
import { isUiActionError, actionErrorProblem } from "@/lib/intelligent-ui/action-contract";
import { isUiGenerationError } from "@/lib/intelligent-ui/generation-journal";
import { isSessionOwnershipError } from "@/lib/session-file-ownership";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const failure = (error: unknown) => json({ error: error instanceof Error ? error.message : "Action unavailable",
  problem: actionErrorProblem(error) ?? (isUiGenerationError(error) || isSessionOwnershipError(error) ? "changed" : error instanceof JsonBodyTooLargeError ? "limit" : "request_unknown") },
  error instanceof JsonBodyTooLargeError ? 413 : isUiGenerationError(error) || isSessionOwnershipError(error)
    || isUiActionError(error) && error.code === "CONFLICT" ? 409 : isUiActionError(error) || error instanceof SyntaxError ? 400 : 500);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128;

export async function GET(request: Request, context: Context) {
  if (!isApiRequestAllowed(request)) return json({ error: "Forbidden" }, 403);
  if (!readBetaFeatures().intelligentUi) return json({ error: "Intelligent UI is disabled" }, 403);
  try {
    const { id } = await context.params, toolCallId = new URL(request.url).searchParams.get("toolCallId");
    if (!text(toolCallId)) return json({ error: "toolCallId is required" }, 400);
    const path = await resolveSessionPath(id);
    return path ? json(await readUiActions(id, path, toolCallId)) : json({ error: "Session not found" }, 404);
  } catch (error) { return failure(error); }
}

export async function POST(request: Request, context: Context) {
  if (!isApiRequestAllowed(request)) return json({ error: "Forbidden" }, 403);
  if (!hasJsonContentType(request)) return json({ error: "Content-Type must be application/json" }, 415);
  if (!readBetaFeatures().intelligentUi) return json({ error: "Intelligent UI is disabled" }, 403);
  try {
    const { id } = await context.params, body = await parseJsonWithinLimit(request, 4000) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Invalid action request" }, 400);
    const path = await resolveSessionPath(id);
    if (!path) return json({ error: "Session not found" }, 404);
    if (body.command === "start") {
      if (Object.keys(body).some(key => !["command", "requestId", "toolCallId", "sourceDigest", "actionId"].includes(key))
        || !text(body.requestId) || !text(body.toolCallId) || !text(body.sourceDigest) || !text(body.actionId)) return json({ error: "Invalid start request" }, 400);
      return json(await startUiAction(id, path, { requestId: body.requestId, toolCallId: body.toolCallId, sourceDigest: body.sourceDigest, actionId: body.actionId }), 202);
    }
    if (Object.keys(body).some(key => !["command", "operationId", "approvalId"].includes(key)) || !text(body.operationId)
      || !["approve", "deny", "cancel", "reconcile", "apply"].includes(String(body.command))
      || body.approvalId !== undefined && !text(body.approvalId)) return json({ error: "Invalid action control" }, 400);
    return json(await controlUiAction(id, path, { operationId: body.operationId,
      command: body.command as "approve" | "deny" | "cancel" | "reconcile" | "apply", ...(typeof body.approvalId === "string" ? { approvalId: body.approvalId } : {}) }, request.signal));
  } catch (error) { return failure(error); }
}
