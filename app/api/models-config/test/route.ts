import { NextResponse } from "next/server";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { resolveSamplingParams } from "@earendil-works/pi-ai/api/simple-options";
import { modelSamplingError, samplingParamsError, SAMPLING_APIS, SAMPLING_THINKING_LEVELS, type SamplingThinkingLevel } from "@/lib/model-sampling";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  createTrustedModelServices,
  ModelRequestCwdError,
  resolveModelRequestCwd,
} from "@/lib/model-runtime-context";

export const dynamic = "force-dynamic";

const TEST_TIMEOUT_MS = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ ok: false, error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json(
      { ok: false, error: "Content-Type must be application/json" },
      { status: 415 },
    );
  }

  let tempDir: string | undefined;

  try {
    const body = await req.json() as {
      providerName?: unknown;
      provider?: unknown;
      model?: unknown;
      modelId?: unknown;
      cwd?: unknown;
      previewOnly?: boolean;
      thinkingLevel?: unknown;
      requestSamplingParams?: unknown;
    };
    const thinkingLevel = body.thinkingLevel ?? "off";
    if (!SAMPLING_THINKING_LEVELS.includes(thinkingLevel as SamplingThinkingLevel)) {
      return NextResponse.json({ ok: false, error: "thinkingLevel must be a Pi thinking level" }, { status: 400 });
    }
    const requestError = samplingParamsError(body.requestSamplingParams, "requestSamplingParams");
    if (requestError) return NextResponse.json({ ok: false, error: requestError }, { status: 400 });
    const providerName = typeof body.providerName === "string" ? body.providerName.trim() : "";
    if (!providerName) return NextResponse.json({ ok: false, error: "providerName is required" }, { status: 400 });
    const testingDraftConfig = body.provider !== undefined || body.model !== undefined;
    let modelId: string;
    let modelRuntime: ModelRuntime;

    if (testingDraftConfig) {
      if (!isRecord(body.provider)) return NextResponse.json({ ok: false, error: "provider is required" }, { status: 400 });
      if (!isRecord(body.model)) return NextResponse.json({ ok: false, error: "model is required" }, { status: 400 });
      const samplingError = modelSamplingError(body.model);
      if (samplingError) return NextResponse.json({ ok: false, error: samplingError }, { status: 400 });
      modelId = typeof body.model.id === "string" ? body.model.id.trim() : "";
      if (!modelId) return NextResponse.json({ ok: false, error: "Model ID is required" }, { status: 400 });

      tempDir = mkdtempSync(join(tmpdir(), "pi-web-model-test-"));
      const modelsPath = join(tempDir, "models.json");
      writeFileSync(modelsPath, JSON.stringify({
        providers: {
          [providerName]: {
            ...body.provider,
            models: [{ ...body.model, id: modelId }],
          },
        },
      }, null, 2), "utf8");
      modelRuntime = await ModelRuntime.create({ modelsPath });
    } else {
      modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
      if (!modelId) return NextResponse.json({ ok: false, error: "modelId is required" }, { status: 400 });
      const cwd = await resolveModelRequestCwd(typeof body.cwd === "string" ? body.cwd : undefined);
      modelRuntime = (await createTrustedModelServices(cwd)).modelRuntime;
    }

    const loadError = modelRuntime.getError();
    if (loadError) return NextResponse.json({ ok: false, error: loadError });

    const model = modelRuntime.getModel(providerName, modelId);
    if (!model) return NextResponse.json({ ok: false, error: `Model not found: ${providerName}/${modelId}` });

    const effectiveThinkingLevel = clampThinkingLevel(model, thinkingLevel as SamplingThinkingLevel);
    const applicable = SAMPLING_APIS.includes(model.api);
    const requestSamplingParams = body.requestSamplingParams as Record<string, unknown> | undefined;
    const samplingPreview = {
      api: model.api,
      applicable,
      requestedThinkingLevel: thinkingLevel,
      effectiveThinkingLevel,
      supportedThinkingLevels: getSupportedThinkingLevels(model),
      params: applicable ? resolveSamplingParams(model, effectiveThinkingLevel, requestSamplingParams) ?? {} : null,
    };
    if (body.previewOnly) return NextResponse.json({ ok: true, samplingPreview });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    let status: number | undefined;
    const startedAt = Date.now();

    try {
      // Use the same runtime that loaded the temporary models.json. Calling
      // the legacy compat dispatcher here bypasses custom provider overlays
      // (baseUrl, headers, API-key commands) and can make a valid configured
      // model appear unreachable.
      const message = await modelRuntime.completeSimple(model, {
        messages: [{
          role: "user",
          content: "Reply with OK only.",
          timestamp: Date.now(),
        }],
      }, {
        maxTokens: 16,
        timeoutMs: TEST_TIMEOUT_MS,
        maxRetries: 0,
        cacheRetention: "none",
        signal: controller.signal,
        reasoning: effectiveThinkingLevel === "off" ? undefined : effectiveThinkingLevel,
        samplingParams: requestSamplingParams,
        onResponse: (response) => { status = response.status; },
      });

      const latencyMs = Date.now() - startedAt;
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        return NextResponse.json({
          ok: false,
          error: message.errorMessage ?? (controller.signal.aborted ? "Test timed out" : "Model returned an error"),
          latencyMs,
          status,
          samplingPreview,
        });
      }

      return NextResponse.json({
        ok: true,
        latencyMs,
        status,
        responseText: getAssistantText(message).slice(0, 300),
        samplingPreview,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (error instanceof ModelRequestCwdError) {
      return NextResponse.json(
        { ok: false, error: error.message, code: error.code },
        { status: error.status },
      );
    }
    return NextResponse.json({ ok: false, error: errorMessage(error) }, { status: 500 });
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}
