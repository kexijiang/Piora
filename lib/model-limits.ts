/**
 * Custom-model context window and max output.
 *
 * Decision A — legacy configs keep the current runtime behavior
 * (`LEGACY_MODEL_LIMIT_RUNTIME`). Piora does not substitute 128000 or 16384,
 * does not rewrite models.json, and does not refuse to chat when a saved
 * custom model omits either field. `storedModelLimits` returns only what is
 * actually stored. Callers that estimate usage from the raw JSON treat a
 * missing or non-positive window as unknown (the estimate is skipped). They
 * must not invent a window size.
 *
 * The SDK still resolves the request. `modelFromJson` in
 * `@earendil-works/pi-coding-agent` (`dist/core/provider-composer.js`) fills
 * `contextWindow ?? 128000` and `maxTokens ?? 16384` on the in-memory model
 * only. Auto-compaction then uses `shouldCompact`: estimated tokens greater
 * than `contextWindow - reserveTokens`. `reserveTokens` is the separate
 * compaction setting (SDK default 16384), not this field. The request output
 * cap is `clampMaxTokensToContext`: `min(model.maxTokens, max(1, contextWindow
 * - used - 4096))`. That SDK fill is intentionally unchanged so models already
 * in use keep working. New saves cannot omit the fields, so the fill remains
 * only for configs that were already on disk. Explicit non-positive values are
 * invalid; Piora does not rewrite them into a hidden default either.
 *
 * Explicit discovery fills absent endpoint limits with visible, editable
 * defaults (512000 context / up to 65536 output, capped at half the context).
 * Loading saved models does not. New or
 * edited custom models need valid limits; unchanged legacy models remain usable.
 */
import { modelSamplingError } from "./model-sampling";

export const LEGACY_MODEL_LIMIT_RUNTIME = "keep-sdk-resolution" as const;

export const REQUIRE_CUSTOM_MODEL_LIMITS = true;

export const DISCOVERED_MODEL_LIMIT_DEFAULTS = { contextWindow: 512_000, maxTokens: 65_536 } as const;

/** A visible discovery default, never a rewrite of a stored or supplied limit. */
export function recommendedMaxOutputTokens(contextWindow: unknown): number {
  const context = positiveTokenCount(contextWindow);
  return context === undefined ? DISCOVERED_MODEL_LIMIT_DEFAULTS.maxTokens
    : Math.min(DISCOVERED_MODEL_LIMIT_DEFAULTS.maxTokens, Math.max(1, Math.floor(context / 2)));
}

export type AutomaticModelLimitSource = "endpoint" | "models.dev";

/** Decision (a). See the file comment. */
export function automaticModelLimitSources(): readonly AutomaticModelLimitSource[] {
  return ["endpoint"];
}

export type ModelLimitSource = "endpoint" | "models.dev" | "default";
export type ModelLimitField = "contextWindow" | "maxTokens";

export interface ModelLimitsMeta {
  contextWindow?: ModelLimitSource;
  maxTokens?: ModelLimitSource;
  /** The configured endpoint was queried and did not provide this field. */
  unavailable?: Partial<Record<ModelLimitField, boolean>>;
}

export interface ModelLimitDraft {
  id?: string;
  contextWindow?: number;
  maxTokens?: number;
  limitsMeta?: ModelLimitsMeta;
  samplingParams?: unknown;
  samplingParamsByThinkingLevel?: unknown;
}

export type ModelLimitProblem =
  | { code: "required" | "not-positive-integer"; field: ModelLimitField }
  | { code: "output-exceeds-context" };

export function positiveTokenCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return undefined;
  return value;
}

/** Raw stored numbers, including non-positive ones. Missing stays missing. */
export function storedModelLimits(model: { contextWindow?: unknown; maxTokens?: unknown }): {
  contextWindow: number | undefined;
  maxTokens: number | undefined;
} {
  return {
    contextWindow: typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow) ? model.contextWindow : undefined,
    maxTokens: typeof model.maxTokens === "number" && Number.isFinite(model.maxTokens) ? model.maxTokens : undefined,
  };
}

export function parseModelLimitDraft(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

export function modelLimitFieldProblem(value: unknown, field: ModelLimitField): ModelLimitProblem | null {
  if (value === undefined || value === null || value === "") return { code: "required", field };
  if (positiveTokenCount(value) === undefined) return { code: "not-positive-integer", field };
  return null;
}

export function modelLimitProblem(model: { contextWindow?: unknown; maxTokens?: unknown }): ModelLimitProblem | null {
  const context = modelLimitFieldProblem(model.contextWindow, "contextWindow");
  if (context) return context;
  const output = modelLimitFieldProblem(model.maxTokens, "maxTokens");
  if (output) return output;
  if ((model.maxTokens as number) >= (model.contextWindow as number)) return { code: "output-exceeds-context" };
  return null;
}

export function modelLimitsError(
  model: { id?: unknown; contextWindow?: unknown; maxTokens?: unknown },
  label?: string,
): string | null {
  const problem = modelLimitProblem(model);
  if (!problem) return null;
  const who = label ?? (typeof model.id === "string" && model.id.trim() ? model.id.trim() : "model");
  if (problem.code === "output-exceeds-context") return `${who}: maxTokens must be less than contextWindow (${model.contextWindow}); leave room for input tokens`;
  const reason = problem.code === "required" ? "is required" : "must be a positive integer";
  return `${who}: ${problem.field} ${reason}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertCustomModelLimits(config: unknown): void {
  if (!isRecord(config) || !isRecord(config.providers)) return;
  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (!isRecord(provider) || !Array.isArray(provider.models)) continue;
    provider.models.forEach((model, index) => {
      if (!isRecord(model)) throw new Error(`${providerId}/models[${index}]: model entry must be an object`);
      const label = typeof model.id === "string" && model.id.trim() ? model.id.trim() : `models[${index}]`;
      const error = modelLimitsError(model, label);
      if (error) throw new Error(`${providerId}/${error}`);
    });
  }
}

function sameJsonValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => sameJsonValue(value, b[index]));
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a).sort();
  const other = Object.keys(b).sort();
  return keys.length === other.length && keys.every((key, index) => key === other[index] && sameJsonValue(a[key], b[key]));
}

export function isUnchangedIncompleteModel(model: Record<string, unknown>, oldModels: unknown[]): boolean {
  const missing = (value: unknown) => value === undefined || value === null || value === "";
  return (missing(model.contextWindow) || missing(model.maxTokens))
    && (missing(model.contextWindow) || positiveTokenCount(model.contextWindow) !== undefined)
    && (missing(model.maxTokens) || positiveTokenCount(model.maxTokens) !== undefined)
    && oldModels.some(old => isRecord(old) && old.id === model.id && sameJsonValue(old, model));
}

/** Older Piora versions allowed equality; unrelated saves must not rewrite it. */
export function isUnchangedEqualBudgetModel(model: Record<string, unknown>, oldModels: unknown[]): boolean {
  return positiveTokenCount(model.contextWindow) !== undefined
    && model.maxTokens === model.contextWindow
    && oldModels.some(old => isRecord(old) && old.id === model.id && sameJsonValue(old, model));
}

export function previousProviderModels(config: unknown, previous: unknown, providerId: string): unknown[] {
  const providers = isRecord(config) && isRecord(config.providers) ? config.providers : {};
  const oldProviders = isRecord(previous) && isRecord(previous.providers) ? previous.providers : {};
  const oldProvider = oldProviders[providerId];
  const oldModels = isRecord(oldProvider) && Array.isArray(oldProvider.models) ? [...oldProvider.models] : [];
  for (const [oldName, oldEntry] of Object.entries(oldProviders)) {
    if (!Object.hasOwn(providers, oldName) && isRecord(oldEntry) && Array.isArray(oldEntry.models)) oldModels.push(...oldEntry.models);
  }
  return oldModels;
}

/** Remove only untouched incomplete legacy rows from unrelated validation. */
export function omitUnchangedIncompleteModels<T>(config: T, previous: unknown): T {
  if (!isRecord(config) || !isRecord(config.providers)) return config;
  const providers = Object.fromEntries(Object.entries(config.providers).map(([id, provider]) => {
    if (!isRecord(provider) || !Array.isArray(provider.models)) return [id, provider];
    const oldModels = previousProviderModels(config, previous, id);
    return [id, { ...provider, models: provider.models.filter(model => !isRecord(model) || !isUnchangedIncompleteModel(model, oldModels)) }];
  }));
  return { ...config, providers } as T;
}

export function validateCustomModelLimits(config: unknown, previous?: unknown): void {
  if (!REQUIRE_CUSTOM_MODEL_LIMITS) return;
  if (!isRecord(config) || !isRecord(config.providers)) return;
  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (!isRecord(provider) || !Array.isArray(provider.models)) continue;
    const oldModels = previousProviderModels(config, previous, providerId);
    for (const [index, model] of provider.models.entries()) {
      if (!isRecord(model)) throw new Error(`${providerId}/models[${index}]: model entry must be an object`);
      const error = modelLimitsError(model, typeof model.id === "string" && model.id.trim() ? model.id.trim() : `models[${index}]`);
      if (!error) continue;
      // Preserve only exact legacy rows already on disk. New or edited rows
      // (including a name/cost change) must satisfy the current limit rules.
      if (isUnchangedIncompleteModel(model, oldModels) || isUnchangedEqualBudgetModel(model, oldModels)) continue;
      throw new Error(`${providerId}/${error}`);
    }
  }
}

export function stripModelLimitUiMeta<T>(config: T): T {
  if (!isRecord(config) || !isRecord(config.providers)) return config;
  let providersChanged = false;
  const providers: Record<string, unknown> = {};
  for (const [name, provider] of Object.entries(config.providers)) {
    if (!isRecord(provider) || !Array.isArray(provider.models)) {
      providers[name] = provider;
      continue;
    }
    let modelsChanged = false;
    const models = provider.models.map((model) => {
      if (!isRecord(model) || !Object.hasOwn(model, "limitsMeta")) return model;
      modelsChanged = true;
      const next = { ...model };
      delete next.limitsMeta;
      return next;
    });
    if (!modelsChanged) {
      providers[name] = provider;
      continue;
    }
    providersChanged = true;
    providers[name] = { ...provider, models };
  }
  if (!providersChanged) return config;
  return { ...config, providers } as T;
}

export type CustomModelSaveBlocker =
  | { kind: "sampling"; providerName: string; index: number; error: string }
  | { kind: "modelId"; providerName: string; index: number }
  | { kind: "limits"; providerName: string; index: number; error: string };

export function firstCustomModelSaveBlocker(
  providers: Record<string, { models?: ModelLimitDraft[] }> | undefined,
  options?: { requireLimits?: boolean; previous?: unknown },
): CustomModelSaveBlocker | null {
  const requireLimits = options?.requireLimits ?? REQUIRE_CUSTOM_MODEL_LIMITS;
  for (const [providerName, provider] of Object.entries(providers ?? {})) {
    const models = provider?.models ?? [];
    const samplingIndex = models.findIndex((model) => modelSamplingError(model));
    if (samplingIndex >= 0) {
      return {
        kind: "sampling",
        providerName,
        index: samplingIndex,
        error: modelSamplingError(models[samplingIndex])!,
      };
    }
    const idIndex = models.findIndex((model) => typeof model.id !== "string" || !model.id.trim());
    if (idIndex >= 0) return { kind: "modelId", providerName, index: idIndex };
    if (!requireLimits) continue;
    const oldModels = previousProviderModels({ providers }, options?.previous, providerName);
    const limitsIndex = models.findIndex((model) => modelLimitProblem(model)
      && !isUnchangedEqualBudgetModel(model as Record<string, unknown>, oldModels));
    if (limitsIndex >= 0) {
      const label = models[limitsIndex].id?.trim() || `models[${limitsIndex}]`;
      return {
        kind: "limits",
        providerName,
        index: limitsIndex,
        error: modelLimitsError(models[limitsIndex], label)!,
      };
    }
  }
  return null;
}

export function customModelsMissingLimits(
  providers: Record<string, { models?: ModelLimitDraft[] }> | undefined,
  previous?: unknown,
): Array<{ providerName: string; index: number; id: string }> {
  const missing: Array<{ providerName: string; index: number; id: string }> = [];
  for (const [providerName, provider] of Object.entries(providers ?? {})) {
    const oldModels = previousProviderModels({ providers }, previous, providerName);
    (provider?.models ?? []).forEach((model, index) => {
      const id = typeof model.id === "string" ? model.id.trim() : "";
      if (!id || !modelLimitProblem(model)) return;
      if (isUnchangedEqualBudgetModel(model as Record<string, unknown>, oldModels)) return;
      missing.push({ providerName, index, id });
    });
  }
  return missing;
}

export function compactLimitMeta(meta: ModelLimitsMeta | undefined): ModelLimitsMeta | undefined {
  if (!meta) return undefined;
  const next: ModelLimitsMeta = {};
  if (meta.contextWindow) next.contextWindow = meta.contextWindow;
  if (meta.maxTokens) next.maxTokens = meta.maxTokens;
  const unavailable: NonNullable<ModelLimitsMeta["unavailable"]> = {};
  if (meta.unavailable?.contextWindow) unavailable.contextWindow = true;
  if (meta.unavailable?.maxTokens) unavailable.maxTokens = true;
  if (Object.keys(unavailable).length) next.unavailable = unavailable;
  return Object.keys(next).length ? next : undefined;
}

export function clearLimitMetaField(meta: ModelLimitsMeta | undefined, field: ModelLimitField): ModelLimitsMeta | undefined {
  if (!meta) return undefined;
  const next: ModelLimitsMeta = { ...meta };
  delete next[field];
  if (next.unavailable) {
    const unavailable = { ...next.unavailable };
    delete unavailable[field];
    next.unavailable = unavailable;
  }
  return compactLimitMeta(next);
}

export function findDiscoveredModel<T extends { id: string }>(models: readonly T[], id: string): T | undefined {
  const needle = id.trim();
  if (!needle) return undefined;
  return models.find((model) => model.id === needle);
}

export function applyEndpointLimits<T extends ModelLimitDraft>(
  model: T,
  discovered: { contextWindow?: number; maxTokens?: number } | undefined,
): { model: T; changed: boolean } {
  let changed = false;
  const next = { ...model };
  const unavailable: NonNullable<ModelLimitsMeta["unavailable"]> = { ...(model.limitsMeta?.unavailable ?? {}) };
  const meta: ModelLimitsMeta = {};
  if (model.limitsMeta?.contextWindow) meta.contextWindow = model.limitsMeta.contextWindow;
  if (model.limitsMeta?.maxTokens) meta.maxTokens = model.limitsMeta.maxTokens;
  for (const field of ["contextWindow", "maxTokens"] as const) {
    const incoming = positiveTokenCount(discovered?.[field]);
    if (model[field] === undefined) {
      next[field] = incoming ?? (field === "maxTokens" ? recommendedMaxOutputTokens(next.contextWindow) : DISCOVERED_MODEL_LIMIT_DEFAULTS.contextWindow);
      meta[field] = incoming === undefined ? "default" : "endpoint";
      delete unavailable[field];
      changed = true;
    }
  }
  if (unavailable.contextWindow || unavailable.maxTokens) {
    meta.unavailable = {
      ...(unavailable.contextWindow ? { contextWindow: true } : {}),
      ...(unavailable.maxTokens ? { maxTokens: true } : {}),
    };
  }
  if (!changed) return { model, changed: false };
  const compacted = compactLimitMeta(meta);
  if (compacted) next.limitsMeta = compacted;
  else delete next.limitsMeta;
  return { model: next, changed: true };
}

/** Explicit editor action: lower configured limits to the queried endpoint. */
export function constrainToEndpointLimits<T extends ModelLimitDraft>(
  model: T,
  discovered: { contextWindow?: number; maxTokens?: number },
): T {
  const next = { ...model };
  const context = positiveTokenCount(discovered.contextWindow);
  const output = positiveTokenCount(discovered.maxTokens);
  const meta = { ...model.limitsMeta };
  if (context !== undefined && positiveTokenCount(model.contextWindow) !== undefined && model.contextWindow! > context) {
    next.contextWindow = context;
    meta.contextWindow = "endpoint";
  }
  if (output !== undefined && positiveTokenCount(model.maxTokens) !== undefined && model.maxTokens! > output) {
    next.maxTokens = output;
    meta.maxTokens = "endpoint";
  }
  if (positiveTokenCount(next.contextWindow) !== undefined && positiveTokenCount(next.maxTokens) !== undefined
    && next.maxTokens! >= next.contextWindow!) {
    next.maxTokens = recommendedMaxOutputTokens(next.contextWindow);
    meta.maxTokens = "default";
  }
  next.limitsMeta = compactLimitMeta(meta);
  return next;
}

export function applyDiscoveredLimits<T extends { models?: ModelLimitDraft[] }>(
  providers: Record<string, T> | undefined,
  discoveredByProvider: Record<string, Array<{ id: string; contextWindow?: number; maxTokens?: number }>>,
): { providers: Record<string, T> | undefined; changed: boolean } {
  if (!providers) return { providers, changed: false };
  let changed = false;
  const nextProviders: Record<string, T> = { ...providers };
  for (const [providerName, discovered] of Object.entries(discoveredByProvider)) {
    const provider = providers[providerName];
    if (!provider?.models) continue;
    let providerChanged = false;
    const models = provider.models.map((model) => {
      if (typeof model.id !== "string" || !model.id.trim()) return model;
      const applied = applyEndpointLimits(model, findDiscoveredModel(discovered, model.id));
      if (!applied.changed) return model;
      providerChanged = true;
      changed = true;
      return applied.model;
    });
    if (providerChanged) nextProviders[providerName] = { ...provider, models };
  }
  return { providers: changed ? nextProviders : providers, changed };
}
