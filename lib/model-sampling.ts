/** Browser-safe configuration validation. Resolution belongs to Pi on the server. */
export const SAMPLING_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type SamplingThinkingLevel = typeof SAMPLING_THINKING_LEVELS[number];
export const SAMPLING_APIS = ["openai-completions", "openai-responses", "azure-openai-responses"];
export const COMMON_SAMPLING_PARAMS = ["temperature", "top_p", "top_k", "min_p", "frequency_penalty", "presence_penalty", "seed"] as const;

export interface ModelSamplingConfig {
  // Invalid editor drafts stay in the owning model until corrected, including
  // when switching models. Both save and test reject them before any mutation.
  samplingParams?: unknown;
  samplingParamsByThinkingLevel?: unknown;
}

export function isSamplingObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function samplingParamsError(value: unknown, path = "samplingParams"): string | null {
  if (value === undefined) return null;
  if (!isSamplingObject(value)) return `${path}: expected a JSON object`;
  const pending: unknown[] = [value];
  const seen = new Set<unknown>();
  while (pending.length) {
    const entry = pending.pop();
    if (typeof entry === "number" && !Number.isFinite(entry)) return `${path}: expected finite JSON numbers`;
    if (entry !== null && typeof entry === "object") {
      if (seen.has(entry)) continue;
      seen.add(entry);
      for (const child of Object.values(entry)) pending.push(child);
    }
  }
  for (const key of COMMON_SAMPLING_PARAMS) {
    if (!Object.hasOwn(value, key)) continue;
    const number = value[key];
    if (typeof number !== "number" || !Number.isFinite(number)) return `${path}.${key}: expected a finite number`;
    if ((key === "seed" || key === "top_k") && !Number.isSafeInteger(number)) return `${path}.${key}: expected a safe integer`;
    const range = key === "temperature" ? [0, 2] : key === "top_p" || key === "min_p" ? [0, 1]
      : key === "frequency_penalty" || key === "presence_penalty" ? [-2, 2] : undefined;
    if (range && (number < range[0] || number > range[1])) return `${path}.${key}: expected ${range[0]}…${range[1]}`;
    if (key === "top_k" && number < -1) return `${path}.${key}: expected -1 or a non-negative integer`;
  }
  return null;
}

export function modelSamplingError(model: ModelSamplingConfig): string | null {
  const error = samplingParamsError(model.samplingParams);
  if (error) return error;
  const levels = model.samplingParamsByThinkingLevel;
  if (levels === undefined) return null;
  if (!isSamplingObject(levels)) return "samplingParamsByThinkingLevel: expected a JSON object";
  for (const [level, params] of Object.entries(levels)) {
    if (!SAMPLING_THINKING_LEVELS.includes(level as SamplingThinkingLevel)) return `samplingParamsByThinkingLevel.${level}: expected a Pi thinking level (${SAMPLING_THINKING_LEVELS.join("/")})`;
    if (params === undefined) continue;
    const error = samplingParamsError(params, `samplingParamsByThinkingLevel.${level}`);
    if (error) return error;
  }
  return null;
}

export function validateModelSamplingConfig(config: Record<string, unknown>): void {
  if (!isSamplingObject(config.providers)) return;
  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (!isSamplingObject(provider)) continue;
    const models = Array.isArray(provider.models) ? provider.models : [];
    const overrides = isSamplingObject(provider.modelOverrides) ? Object.values(provider.modelOverrides) : [];
    for (const model of [...models, ...overrides]) {
      if (!isSamplingObject(model)) continue;
      const error = modelSamplingError(model);
      if (error) throw new Error(`${providerId}/${String(model.id ?? "modelOverrides")}: ${error}`);
    }
  }
}
