import { resolveSessionPath } from "@/lib/session-reader";
import { readBetaFeatures } from "@/lib/beta-features";
import { InvalidJsonBodyError, JsonBodyTooLargeError, parseJsonWithinLimit } from "@/lib/bounded-json";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { answerOutputSessionReader } from "@/lib/answer-output-session";
import { isAnswerReceiptError } from "@/lib/answer-output-receipts";
import { isSessionOwnershipError } from "@/lib/session-file-ownership";
import { readMiniAppOutput, readMiniAppReceipt, saveMiniAppOutput } from "@/lib/mini-app/state-service";
import { MINI_APP_LIMITS, MiniAppError, isMiniAppError } from "@/lib/mini-app/limits";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
function failure(error: unknown) {
  if (error instanceof JsonBodyTooLargeError) return json({ error: "Mini app request exceeds its size limit", code: "LIMIT" }, 413);
  if (error instanceof InvalidJsonBodyError) return json({ error: "Expected a complete JSON request", code: "SCHEMA" }, 400);
  if (isAnswerReceiptError(error) || isSessionOwnershipError(error)) return json({ error: error.message, code: "CONFLICT" }, 409);
  if (isMiniAppError(error)) {
    const status = error.code === "NOT_FOUND" ? 404 : error.code === "DISABLED" ? 403 : error.code === "LIMIT" ? 413
      : ["CONFLICT", "IDENTITY", "CORRUPT", "STOPPED"].includes(error.code) ? 409 : error.code === "BUSY" ? 503 : 400;
    return json({ error: error.message, code: error.code, path: error.path }, status);
  }
  return json({ error: "Mini app state is unavailable; the recovery draft has not been confirmed", code: "UNAVAILABLE" }, 500);
}
async function options(context: Context) {
  const { id } = await context.params, path = await resolveSessionPath(id);
  if (!path) throw new MiniAppError("NOT_FOUND", "Session not found");
  return { sessionId: id, readManager: await answerOutputSessionReader(id, path) };
}
function queryId(query: URLSearchParams, name: string, required: boolean) {
  const value = query.get(name);
  if (value === null && !required) return undefined;
  if (!value || value.length > 256) throw new MiniAppError("IDENTITY", `Invalid ${name}`);
  return value;
}
export async function GET(request: Request, context: Context) {
  if (!isApiRequestAllowed(request)) return json({ error: "Forbidden" }, 403);
  try {
    const query = new URL(request.url).searchParams, toolCallId = queryId(query, "toolCallId", true)!;
    const leafId = queryId(query, "leafId", false), requestId = queryId(query, "requestId", false), session = await options(context);
    const requiredAncestorLeafId = queryId(query, "requiredAncestorLeafId", false);
    if (requestId) {
      if (leafId || requiredAncestorLeafId) throw new MiniAppError("IDENTITY", "Receipt queries use the current branch");
      return json({ receipt: await readMiniAppReceipt({ ...session, toolCallId, requestId }) ?? null });
    }
    return json(await readMiniAppOutput({ ...session, toolCallId, leafId, requiredAncestorLeafId }));
  } catch (error) { return failure(error); }
}
export async function PUT(request: Request, context: Context) {
  if (!isApiRequestAllowed(request)) return json({ error: "Forbidden" }, 403);
  if (!hasJsonContentType(request)) return json({ error: "Content-Type must be application/json" }, 415);
  try {
    if (!readBetaFeatures().intelligentUi) throw new MiniAppError("DISABLED", "Intelligent UI is disabled");
    const body = await parseJsonWithinLimit(request, MINI_APP_LIMITS.replyBytes);
    const receipt = await saveMiniAppOutput({ ...await options(context), request: body, enabled: () => readBetaFeatures().intelligentUi, signal: request.signal });
    return json({ receipt });
  } catch (error) { return failure(error); }
}
