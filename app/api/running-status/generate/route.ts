import { InvalidJsonBodyError, JsonBodyTooLargeError, parseJsonWithinLimit } from "@/lib/bounded-json";
import { createTrustedModelServices, ModelRequestCwdError, resolveModelRequestCwd } from "@/lib/model-runtime-context";
import { resolveDefaultModelPreference } from "@/lib/model-policy";
import { readDefaultModel } from "@/lib/default-model-store";
import { resolveVisibleModels, selectInitialModelScope } from "@/lib/model-scope";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { parseGeneratedRunningStatusLabels, runningStatusGenerationPrompt } from "@/lib/running-status-labels";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "access_denied" }, { status: 403 });
  if (!hasJsonContentType(request)) return Response.json({ error: "invalid_request" }, { status: 415 });
  try {
    const body = await parseJsonWithinLimit(request, 8 * 1024);
    if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "invalid_request" }, { status: 400 });
    const input = body as { locale?: unknown; cwd?: unknown };
    if (input.cwd !== undefined && typeof input.cwd !== "string") return Response.json({ error: "invalid_request" }, { status: 400 });
    const cwd = await resolveModelRequestCwd(input.cwd as string | undefined);
    const { modelRuntime, settingsManager } = await createTrustedModelServices(cwd, "system");
    const scope = await resolveVisibleModels(modelRuntime, settingsManager.getEnabledModels());
    const preference = resolveDefaultModelPreference({ models: scope.visible, explicitDefault: readDefaultModel(), settingsProvider: settingsManager.getDefaultProvider(), settingsModel: settingsManager.getDefaultModel(), environment: process.env });
    const { model } = selectInitialModelScope(scope, { ...(preference ? { defaultModel: preference } : {}) });
    if (!model) return Response.json({ error: "model_unavailable" }, { status: 422 });
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]);
    signal.throwIfAborted();
    const message = await modelRuntime.completeSimple(model, {
      systemPrompt: runningStatusGenerationPrompt(input.locale === "en" ? "en" : "zh-CN"),
      messages: [{ role: "user", content: "Generate the 50 status messages now.", timestamp: Date.now() }],
    }, { maxTokens: 4_096, maxRetries: 1, timeoutMs: 60_000, cacheRetention: "none", signal });
    signal.throwIfAborted();
    if (message.stopReason === "error" || message.stopReason === "aborted") return Response.json({ error: "generation_failed" }, { status: 502 });
    const text = message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    let labels: string[];
    try { labels = parseGeneratedRunningStatusLabels(text); }
    catch { return Response.json({ error: "invalid_generated_labels" }, { status: 502 }); }
    return Response.json({ labels, model: model.name });
  } catch (error) {
    if (error instanceof InvalidJsonBodyError || error instanceof JsonBodyTooLargeError) return Response.json({ error: "invalid_request" }, { status: error instanceof JsonBodyTooLargeError ? 413 : 400 });
    if (error instanceof ModelRequestCwdError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: "generation_failed" }, { status: 502 });
  }
}
