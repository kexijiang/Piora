const COST_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Custom definitions require complete rates; modelOverrides intentionally allow partial rates. */
export function normalizeModelConfigCosts(config: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(config)) throw new Error("模型配置必须是对象");
  const result = structuredClone(config);
  if (!isRecord(result.providers)) return result;
  for (const [providerId, provider] of Object.entries(result.providers)) {
    if (!isRecord(provider) || !Array.isArray(provider.models)) continue;
    for (const [index, model] of provider.models.entries()) {
      if (!isRecord(model) || model.cost === undefined) continue;
      const location = `providers.${providerId}.models.${index}.cost`;
      if (!isRecord(model.cost)) throw new Error(`${location}: 价格必须是对象`);
      for (const key of COST_KEYS) {
        const value = model.cost[key];
        if (value === undefined) model.cost[key] = 0;
        else if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new Error(`${location}.${key}: 价格必须是有效数字`);
        }
      }
    }
  }
  return result;
}
