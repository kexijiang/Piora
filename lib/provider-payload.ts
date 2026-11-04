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

export function installProviderPayloadValidation(runtime: unknown): boolean {
  if (!runtime || typeof runtime !== "object" || installed.has(runtime)) return false;
  const holder = runtime as { streamSimple?: (model: unknown, context: unknown, options?: Record<string, unknown>) => unknown };
  if (typeof holder.streamSimple !== "function") return false;
  const original = holder.streamSimple.bind(runtime);
  holder.streamSimple = (model, context, options) => {
    if ((model as { api?: string } | null)?.api !== "openai-completions") return original(model, context, options);
    const previous = options?.onPayload as PayloadHook | undefined;
    return original(model, context, { ...options, onPayload: async (payload: unknown, selectedModel: unknown) => {
      const replacement = await previous?.(payload, selectedModel);
      const finalPayload = replacement === undefined ? payload : replacement;
      validateChatPayload(finalPayload);
      return finalPayload;
    } });
  };
  installed.add(runtime);
  return true;
}

export function summarizeProviderError(raw: string): { summary: string; code?: string; structured: boolean } {
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
