import { NextResponse } from "next/server";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import {
  InvalidJsonBodyError,
  JsonBodyTooLargeError,
  parseJsonWithinLimit,
} from "@/lib/bounded-json";
import {
  createTrustedModelServices,
  ModelRequestCwdError,
  resolveModelRequestCwd,
} from "@/lib/model-runtime-context";
import {
  PROMPT_OPTIMIZER_MAX_INPUT_LENGTH,
  PROMPT_OPTIMIZER_MAX_SYSTEM_PROMPT_LENGTH,
  PROMPT_OPTIMIZER_SYSTEM_PROMPT,
  parseOptimizedPrompt,
} from "@/lib/prompt-optimizer";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const PROMPT_OPTIMIZER_MAX_REQUEST_BYTES = 64 * 1024;
const PROMPT_OPTIMIZER_TIMEOUT_MS = 60_000;

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await parseJsonWithinLimit(request, PROMPT_OPTIMIZER_MAX_REQUEST_BYTES) as {
      prompt?: unknown;
      provider?: unknown;
      modelId?: unknown;
      cwd?: unknown;
      systemPrompt?: unknown;
    };
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const provider = typeof body.provider === "string" ? body.provider.trim() : "";
    const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
    const optimizerSystemPrompt = typeof body.systemPrompt === "string"
      ? body.systemPrompt.trim()
      : PROMPT_OPTIMIZER_SYSTEM_PROMPT;

    if (!prompt) return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
    if (Array.from(prompt).length > PROMPT_OPTIMIZER_MAX_INPUT_LENGTH) {
      return NextResponse.json({ error: `Prompt must not exceed ${PROMPT_OPTIMIZER_MAX_INPUT_LENGTH} characters` }, { status: 400 });
    }
    if (!provider || !modelId) {
      return NextResponse.json({ error: "A model must be selected" }, { status: 400 });
    }
    if (!optimizerSystemPrompt) {
      return NextResponse.json({ error: "Prompt optimizer system prompt is required" }, { status: 400 });
    }
    if (Array.from(optimizerSystemPrompt).length > PROMPT_OPTIMIZER_MAX_SYSTEM_PROMPT_LENGTH) {
      return NextResponse.json({ error: `Prompt optimizer system prompt must not exceed ${PROMPT_OPTIMIZER_MAX_SYSTEM_PROMPT_LENGTH} characters` }, { status: 400 });
    }

    const cwd = await resolveModelRequestCwd(typeof body.cwd === "string" ? body.cwd : undefined);
    const { modelRuntime } = await createTrustedModelServices(cwd, "prompt_optimize");
    const loadError = modelRuntime.getError();
    if (loadError) return NextResponse.json({ error: loadError }, { status: 400 });

    const model = modelRuntime.getModel(provider, modelId);
    if (!model) return NextResponse.json({ error: `Model not found: ${provider}/${modelId}` }, { status: 404 });

    const controller = new AbortController();
    const abortFromRequest = () => controller.abort();
    request.signal.addEventListener("abort", abortFromRequest, { once: true });
    const timeout = setTimeout(() => controller.abort(), PROMPT_OPTIMIZER_TIMEOUT_MS);

    try {
      const message = await modelRuntime.completeSimple(model, {
        systemPrompt: optimizerSystemPrompt,
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
      }, {
        maxTokens: 4_096,
        maxRetries: 1,
        timeoutMs: PROMPT_OPTIMIZER_TIMEOUT_MS,
        cacheRetention: "none",
        signal: controller.signal,
      });

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        const fallback = controller.signal.aborted ? "Prompt optimization timed out" : "Prompt optimization failed";
        return NextResponse.json({ error: message.errorMessage ?? fallback }, { status: 502 });
      }

      return NextResponse.json({ optimizedPrompt: parseOptimizedPrompt(assistantText(message)) });
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", abortFromRequest);
    }
  } catch (error) {
    if (error instanceof JsonBodyTooLargeError) {
      return NextResponse.json({ error: "Request body is too large" }, { status: 413 });
    }
    if (error instanceof InvalidJsonBodyError) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    if (error instanceof ModelRequestCwdError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
