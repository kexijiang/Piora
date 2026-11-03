export interface PredictionSettings { enabled: boolean; model: { provider: string; modelId: string } | null; timeoutMs: number }
export const defaultPredictionSettings = (): PredictionSettings => ({ enabled: false, model: null, timeoutMs: 30_000 });
export function validatePredictionSettings(value: unknown): PredictionSettings {
  const input = value as Partial<PredictionSettings> | null;
  if (!input || typeof input.enabled !== "boolean" || !Number.isInteger(input.timeoutMs) || input.timeoutMs! < 5000 || input.timeoutMs! > 120000) throw new Error("Invalid prediction settings");
  const model = input.model;
  if (model !== null && (!model || typeof model.provider !== "string" || !model.provider.trim() || model.provider.length > 256 || typeof model.modelId !== "string" || !model.modelId.trim() || model.modelId.length > 256)) throw new Error("Invalid prediction model");
  return { enabled: input.enabled, model: model ?? null, timeoutMs: input.timeoutMs! };
}
export const predictionSettingsKey = (cwd?: string | null) => `piora-input-prediction-v1${cwd ? `:${cwd}` : ""}`;
export function readPredictionSettings(cwd?: string | null): PredictionSettings {
  try { const raw = (cwd && localStorage.getItem(predictionSettingsKey(cwd))) || localStorage.getItem(predictionSettingsKey()); return raw ? validatePredictionSettings(JSON.parse(raw)) : defaultPredictionSettings(); } catch { return defaultPredictionSettings(); }
}
export function savePredictionSettings(value: PredictionSettings | null, cwd?: string | null) {
  if (value) localStorage.setItem(predictionSettingsKey(cwd), JSON.stringify(validatePredictionSettings(value)));
  else localStorage.removeItem(predictionSettingsKey(cwd));
  window.dispatchEvent(new Event("piora:input-prediction"));
}
/** Keep the complete effective text/tool context; media bytes are not useful for text prediction. */
export function predictionContext(messages: unknown[]): string {
  return JSON.stringify(messages, (key, value) => key === "data" || key === "usage" || key === "thinking" ? undefined : value);
}
