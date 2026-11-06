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
export function validateOutputBudget(payload: unknown, model: unknown): void {
  if (!payload || typeof payload !== "object" || !model || typeof model !== "object") return;
  const { contextWindow, api } = model as { contextWindow?: unknown; api?: string };
  if (!sharedContextApis.has(api ?? "") || typeof contextWindow !== "number" || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) return;
  const request = payload as Record<string, unknown>;
  for (const field of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
    const output = request[field];
    if (typeof output === "number" && Number.isFinite(output) && output >= contextWindow) {
      throw new Error(`Invalid model output budget: ${field} (${output}) must be less than the context window (${contextWindow}). Check Max Output Tokens in model settings and any payload overrides; leave room for input. No request was sent.`);
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
      validateOutputBudget(finalPayload, model);
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
    || (/maximum context length/i.test(raw) && /requested\s+\d+\s+output tokens/i.test(raw) && /(?:\b0 input tokens|\b0 tokens for (?:the )?input)/i.test(raw))) {
    return { summary: "Check Max Output Tokens in model settings: output must leave room for input within the context window.", code: "model_output_budget", structured: true };
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
