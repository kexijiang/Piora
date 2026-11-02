import { resolveSessionPath } from "@/lib/session-reader";
import { readBetaFeatures } from "@/lib/beta-features";
import { InvalidJsonBodyError, JsonBodyTooLargeError, parseJsonWithinLimit } from "@/lib/bounded-json";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { isAnswerReceiptError } from "@/lib/answer-output-receipts";
import { isSessionOwnershipError } from "@/lib/session-file-ownership";
import { isUiGenerationError } from "@/lib/intelligent-ui/generation-journal";
import { readAnswerConversion, confirmAnswerConversion } from "@/lib/answer-output-conversion-service";
import { MiniAppError, isMiniAppError } from "@/lib/mini-app/limits";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
function failure(error: unknown) {
  if (error instanceof JsonBodyTooLargeError) return json({ code: "LIMIT", error: "Conversion request exceeds its limit" }, 413);
  if (error instanceof InvalidJsonBodyError) return json({ code: "SCHEMA", error: "Expected complete JSON" }, 400);
  if (isAnswerReceiptError(error) || isSessionOwnershipError(error) || isUiGenerationError(error)) return json({ code: "CONFLICT", error: error.message }, 409);
  if (isMiniAppError(error)) return json({ code: error.code, error: error.message }, error.code === "NOT_FOUND" ? 404 : error.code === "DISABLED" ? 403
    : ["CONFLICT", "IDENTITY", "STOPPED", "CORRUPT"].includes(error.code) ? 409 : error.code === "BUSY" ? 503 : 400);
  return json({ code: "UNAVAILABLE", error: "Conversion was not acknowledged; refresh its saved status before retrying" }, 500);
}
async function session(context: Context) {
  const { id } = await context.params, path = await resolveSessionPath(id);
  if (!path) throw new MiniAppError("NOT_FOUND", "Session not found");
  return { sessionId: id, sessionFile: path };
}
export async function GET(request: Request, context: Context) {
  if (!isApiRequestAllowed(request)) return json({ error: "Forbidden" }, 403);
  try {
    const query = new URL(request.url).searchParams, toolCallId = query.get("toolCallId"), kind = query.get("kind");
    if (!toolCallId || toolCallId.length > 200 || kind !== "mini-app" && kind !== "intelligent-ui") throw new MiniAppError("IDENTITY", "Invalid output identity");
    return json({ review: await readAnswerConversion({ ...await session(context), kind, toolCallId }) });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request, context: Context) {
  if (!isApiRequestAllowed(request)) return json({ error: "Forbidden" }, 403);
  if (!hasJsonContentType(request)) return json({ error: "Content-Type must be application/json" }, 415);
  try {
    if (!readBetaFeatures().intelligentUi) throw new MiniAppError("DISABLED", "Intelligent UI is disabled");
    const input = await parseJsonWithinLimit(request, 64 * 1024);
    return json(await confirmAnswerConversion({ ...await session(context), input, enabled: () => readBetaFeatures().intelligentUi, signal: request.signal }));
  } catch (error) { return failure(error); }
}
