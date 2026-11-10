import type { Context } from "@earendil-works/pi-ai";

let estimateInput: ((context: Context) => number) | undefined;

function estimateInputTokens(context: Context): number {
  if (!estimateInput) {
    // Pi's extension jiti aliases the package root to a compat FILE and treats
    // unmatched subpaths as children of that file. Use Node resolution from the
    // app runtime, as terminal-pty does, so extension imports keep working.
    // Lazy loading also keeps this server-only dependency out of error rendering.
    const { createRequire } = process.getBuiltinModule("node:module");
    const { join } = process.getBuiltinModule("node:path");
    const runtimeRoot = process.env.PIORA_WEB_RUNTIME_ROOT?.trim() || process.cwd();
    const requireSdk = createRequire(join(runtimeRoot, "package.json"));
    // Pi 1.5 exposes these subpaths only under the ESM import condition. Node
    // >=22.19 can synchronously load their ESM files by absolute runtime path.
    const sdkUtils = join(runtimeRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "utils");
    const { estimateContextTokens } = requireSdk(join(sdkUtils, "estimate.js")) as typeof import("@earendil-works/pi-ai/utils/estimate");
    const { normalizeContext } = requireSdk(join(sdkUtils, "transcript.js")) as typeof import("@earendil-works/pi-ai/utils/transcript");
    estimateInput = context => estimateContextTokens(normalizeContext(context)).tokens;
  }
  return estimateInput(context);
}

/** Validate the serialized OpenAI Chat Completions boundary, never rewrite roles. */
export function validateChatPayload(payload: unknown): void {
  if (!payload || typeof payload !== "object") return;
  const messages = (payload as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return;
  for (let index = 0; index < messages.length; index++) {
    const role = messages[index]?.role;
    if (typeof role !== "string" || !role.trim()) {
      throw new Error(`Invalid provider request: messages[${index}].role is empty. Check the provider adapter or extension payload; no request was sent.`);
    }
  }
}

type PayloadHook = (payload: unknown, model: unknown) => unknown | Promise<unknown>;
const installed = new WeakSet<object>();
const sharedContextApis = new Set(["openai-completions", "openai-responses", "azure-openai-responses", "anthropic-messages"]);

/** Check the final wire parameters after hooks; the SDK normally clamps these. */
export function validateOutputBudget(payload: unknown, model: unknown, context?: unknown): void {
  if (!payload || typeof payload !== "object" || !model || typeof model !== "object") return;
  const { contextWindow, api } = model as { contextWindow?: unknown; api?: string };
  if (!sharedContextApis.has(api ?? "") || typeof contextWindow !== "number" || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) return;
  const request = payload as Record<string, unknown>;
  // Match Pi's shared-budget estimate, including system instructions and tools.
  // This is not an exact server tokenizer or a way to infer unknown server limits.
  const input = context && typeof context === "object" && Array.isArray((context as Context).messages)
    ? estimateInputTokens(context as Context) : undefined;
  if (input !== undefined && input >= contextWindow) {
    throw new Error(`maximum context length exceeded: estimated input (${input}) leaves no output room in the context window (${contextWindow}).`);
  }
  const available = input === undefined ? contextWindow - 1 : Math.max(1, contextWindow - input - 4096);
  for (const field of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
    const output = request[field];
    if (typeof output === "number" && Number.isFinite(output) && (output >= contextWindow || output > available)) {
      throw new Error(`Invalid model output budget: ${field} (${output}) must be less than the context window (${contextWindow}) and at most the remaining output budget (${available}). Check Max Output Tokens in model settings and any payload overrides; leave room for input. No request was sent.`);
    }
  }
}

export function installProviderPayloadValidation(runtime: unknown): boolean {
  if (!runtime || typeof runtime !== "object" || installed.has(runtime)) return false;
  const holder = runtime as { streamSimple?: (model: unknown, context: unknown, options?: Record<string, unknown>) => unknown };
  if (typeof holder.streamSimple !== "function") return false;
  const original = holder.streamSimple.bind(runtime);
  holder.streamSimple = (model, context, options) => {
    const api = (model as { api?: string } | null)?.api;
    if (!sharedContextApis.has(api ?? "")) return original(model, context, options);
    const previous = options?.onPayload as PayloadHook | undefined;
    return original(model, context, { ...options, onPayload: async (payload: unknown, selectedModel: unknown) => {
      const replacement = await previous?.(payload, selectedModel);
      const finalPayload = replacement === undefined ? payload : replacement;
      if (api === "openai-completions") validateChatPayload(finalPayload);
      validateOutputBudget(finalPayload, model, context);
      return finalPayload;
    } });
  };
  installed.add(runtime);
  return true;
}

export function summarizeProviderError(raw: string): { summary: string; code?: string; structured: boolean } {
  // Keep the original diagnostics in the details disclosure; only the summary
  // gets a localized, actionable explanation at the rendering boundary.
  if (raw.includes("Invalid model output budget:")
    || (/maximum context length/i.test(raw) && /requested\s+\d+\s+output tokens/i.test(raw) && /(?:\b0 input tokens|\b0 tokens for (?:the )?input)/i.test(raw))
    || /\bmax_completion_tokens=\d+ cannot be greater than max_model_len=(?:max_total_tokens=)?\d+/i.test(raw)) {
    return { summary: "Check Max Output Tokens and the context window in model settings against the provider's actual limits; leave room for input.", code: "model_output_budget", structured: true };
  }
  const start = raw.indexOf("{");
  if (start < 0) return { summary: raw, structured: false };
  try {
    const value = JSON.parse(raw.slice(start));
    const error = value.error && typeof value.error === "object" ? value.error : value;
    const summary = error.error_msg ?? error.message;
    const code = error.error_code ?? error.code;
    if (typeof summary !== "string" || !summary.trim()) return { summary: raw, structured: false };
    return { summary, ...(typeof code === "string" || typeof code === "number" ? { code: String(code) } : {}), structured: true };
  } catch { return { summary: raw, structured: false }; }
}
