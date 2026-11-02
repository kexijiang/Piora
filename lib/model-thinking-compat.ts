import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** Defaults for the open-weight Flash/1017 family, including quantized model IDs.
 * https://recipes.vllm.ai/deepseek-ai/DeepSeek-V4.1-Flash
 * Explicit maps belong to the user/provider and always take precedence.
 */
export function withModelThinkingCompat<T extends Model<Api> | undefined>(model: T): T {
  if (!model?.reasoning || model.thinkingLevelMap !== undefined
    || !["openai-completions", "openai-responses", "azure-openai-responses"].includes(model.api)
    || !/(?:^|\/)deepseek[-_. ]*v4[._]1[-_. ]*flash(?:$|[-_. :])/i.test(model.id)) return model;
  const format = model.compat && "thinkingFormat" in model.compat ? model.compat.thinkingFormat : undefined;
  // Hosted gateways with their own protocol retain their own effort semantics.
  if (format && !["openai", "chat-template", "deepseek"].includes(format)) return model;
  return { ...model, thinkingLevelMap: {
    ...(!format || format === "openai" ? { off: "none" } : {}),
    minimal: null, low: "low", medium: null, high: "high",
    // The native DeepSeek protocol has low/high/max, unlike the vLLM template.
    xhigh: format === "deepseek" ? null : "xhigh", max: "max",
  } };
}

const installed = new WeakSet<object>();

/** Keep selectors, restored sessions, refreshes and outgoing requests consistent. */
export function installModelThinkingCompat(runtime: ModelRuntime): void {
  if (installed.has(runtime)) return;
  installed.add(runtime);
  const getModel = runtime.getModel?.bind(runtime);
  if (getModel) runtime.getModel = (...args) => withModelThinkingCompat(getModel(...args));
  const getModels = runtime.getModels?.bind(runtime);
  if (getModels) runtime.getModels = (...args) => getModels(...args).map(withModelThinkingCompat);
  const getAvailable = runtime.getAvailable?.bind(runtime);
  if (getAvailable) runtime.getAvailable = async (...args) => (await getAvailable(...args)).map(withModelThinkingCompat);
  const streamSimple = runtime.streamSimple?.bind(runtime);
  if (streamSimple) runtime.streamSimple = (model, context, options) => streamSimple(withModelThinkingCompat(model), context, options);
}
