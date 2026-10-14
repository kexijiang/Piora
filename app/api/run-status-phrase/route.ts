import { NextResponse } from "next/server";
import { getSupportedThinkingLevels, type Api, type Model, type ThinkingLevel } from "@earendil-works/pi-ai";
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
  buildRunStatusPhraseMessages,
  isRunStatusPhraseStyle,
  RUN_STATUS_PHRASE_CUSTOM_MAX_LENGTH,
  type RunStatusPhraseLocale,
  type RunStatusPhraseStyle,
} from "@/lib/run-status-phrase-prompts";
import { RUN_STATUS_PHRASE_TIMEOUT_MS, sanitizeRunStatusPhrase } from "@/lib/run-status-phrase";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = 8 * 1024;

interface PhraseRequest {
  provider: string;
  modelId: string;
  cwd?: string;
  locale: RunStatusPhraseLocale;
  style: RunStatusPhraseStyle;
  systemPrompt: string;
  userMessage: string;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
 * Same reasoning choice as reply suggestions: disable thinking on adapters
 * that treat a missing effort as off, otherwise ask for the lowest effort so
 * a provider default cannot turn this short line into a long reasoning run.
 */
function utilityReasoning(model: Model<Api>): ThinkingLevel | undefined {
  const levels = getSupportedThinkingLevels(model);
  const disablesThinking = levels.includes("off") && (
    model.api === "anthropic-messages"
    || model.api === "google-generative-ai"
    || model.api === "google-vertex"
    || (model.api === "openai-responses" && model.provider !== "github-copilot")
    || (model.api === "openai-completions" && typeof model.thinkingLevelMap?.off === "string")
  );
  if (disablesThinking) return undefined;
  for (const level of levels) {
    if (level !== "off") return level;
  }
  return undefined;
}

function readPhraseRequest(body: unknown): PhraseRequest | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const provider = typeof record.provider === "string" ? record.provider.trim() : "";
  const modelId = typeof record.modelId === "string" ? record.modelId.trim() : "";
  const locale = record.locale === "zh-CN" || record.locale === "en" ? record.locale : null;
  const style = isRunStatusPhraseStyle(record.style) ? record.style : null;
  if (!provider || !modelId || !locale || !style) return null;
  if (provider.length > 200 || modelId.length > 200) return null;
  // Only the custom style takes client text, and only into the user message.
  let customPrompt = "";
  if (style === "custom") {
    if (typeof record.customPrompt !== "string") return null;
    customPrompt = record.customPrompt.trim();
    if (Array.from(customPrompt).length > RUN_STATUS_PHRASE_CUSTOM_MAX_LENGTH) return null;
  }
  const messages = buildRunStatusPhraseMessages(style, locale, customPrompt);
  if (!messages) return null;
  const cwd = typeof record.cwd === "string" ? record.cwd.trim() : "";
  if (cwd.length > 1_024) return null;
  return { provider, modelId, locale, style, ...messages, ...(cwd ? { cwd } : {}) };
}

/**
 * One-shot side task, same runtime path as prompt optimization and reply
 * suggestions (`modelRuntime.completeSimple`). It does not join the live
 * agent turn, which is already busy while this line is on screen.
 */
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 415 });
  }

  try {
    const parsed = readPhraseRequest(await parseJsonWithinLimit(request, MAX_REQUEST_BYTES));
    if (!parsed) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

    const cwd = await resolveModelRequestCwd(parsed.cwd);
    const { modelRuntime } = await createTrustedModelServices(cwd);
    const loadError = modelRuntime.getError();
    if (loadError) return NextResponse.json({ error: "model_unavailable" }, { status: 400 });

    const model = modelRuntime.getModel(parsed.provider, parsed.modelId);
    if (!model) return NextResponse.json({ error: "model_unavailable" }, { status: 404 });

    const controller = new AbortController();
    const abortFromRequest = () => controller.abort();
    request.signal.addEventListener("abort", abortFromRequest, { once: true });
    const timeout = setTimeout(() => controller.abort(), RUN_STATUS_PHRASE_TIMEOUT_MS);

    try {
      const message = await modelRuntime.completeSimple(model, {
        systemPrompt: parsed.systemPrompt,
        messages: [{ role: "user", content: parsed.userMessage, timestamp: Date.now() }],
      }, {
        reasoning: utilityReasoning(model),
        maxTokens: 256,
        maxRetries: 0,
        timeoutMs: RUN_STATUS_PHRASE_TIMEOUT_MS,
        cacheRetention: "none",
        signal: controller.signal,
      });

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        return NextResponse.json({ error: "phrase_unavailable" }, { status: 502 });
      }

      const phrase = sanitizeRunStatusPhrase(assistantText(message), parsed.locale);
      if (!phrase) return NextResponse.json({ error: "phrase_unavailable" }, { status: 502 });
      return NextResponse.json({ phrase }, { headers: { "Cache-Control": "no-store" } });
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", abortFromRequest);
    }
  } catch (error) {
    if (error instanceof JsonBodyTooLargeError) {
      return NextResponse.json({ error: "invalid_request" }, { status: 413 });
    }
    if (error instanceof InvalidJsonBodyError) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    if (error instanceof ModelRequestCwdError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: "phrase_unavailable" }, { status: 502 });
  }
}
