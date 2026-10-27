import { positiveTokenCount } from "./model-limits";

export interface DiscoveredModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
}

export interface ParseDiscoveredModelsOptions {
  /**
   * Provider API id. `max_tokens` is read as max output only for
   * anthropic-messages, so an OpenAI-compatible payload cannot be misread.
   */
  api?: string;
}

/** Shared budget for the models-list request. The client aborts with the same limit. */
export const MODEL_DISCOVERY_TIMEOUT_MS = 20_000;

const CONTEXT_KEYS = [
  "context_length",
  "context_window",
  "max_context_length",
  "max_model_len",
  "max_input_tokens",
  "inputTokenLimit",
] as const;

const OUTPUT_KEYS = [
  "max_output_tokens",
  "max_completion_tokens",
  "outputTokenLimit",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstPositive(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) continue;
    const value = positiveTokenCount(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function readContextWindow(record: Record<string, unknown>): number | undefined {
  const direct = firstPositive(record, CONTEXT_KEYS);
  if (direct !== undefined) return direct;
  if (isRecord(record.top_provider)) {
    const nested = positiveTokenCount(record.top_provider.context_length);
    if (nested !== undefined) return nested;
  }
  if (isRecord(record.limit)) {
    const nested = positiveTokenCount(record.limit.context);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function readMaxTokens(record: Record<string, unknown>, api: string | undefined): number | undefined {
  const direct = firstPositive(record, OUTPUT_KEYS);
  if (direct !== undefined) return direct;
  if (isRecord(record.top_provider)) {
    const nested = positiveTokenCount(record.top_provider.max_completion_tokens);
    if (nested !== undefined) return nested;
  }
  if (api === "anthropic-messages") {
    const anthropic = positiveTokenCount(record.max_tokens);
    if (anthropic !== undefined) return anthropic;
  }
  if (isRecord(record.limit)) {
    const nested = positiveTokenCount(record.limit.output);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function modelFromValue(value: unknown, api: string | undefined): DiscoveredModel | null {
  if (typeof value === "string") {
    const id = value.trim();
    return id ? { id } : null;
  }
  if (!isRecord(value)) return null;

  const rawId = cleanString(value.id) ?? cleanString(value.model) ?? cleanString(value.name);
  if (!rawId) return null;
  const id = rawId.startsWith("models/") ? rawId.slice("models/".length) : rawId;
  if (!id) return null;
  const name = cleanString(value.display_name)
    ?? cleanString(value.displayName)
    ?? (cleanString(value.id) || cleanString(value.model) ? cleanString(value.name) : undefined);
  let contextWindow = readContextWindow(value);
  let maxTokens = readMaxTokens(value, api);
  // A contradictory pair is not usable. Drop both and let the user type them.
  if (contextWindow !== undefined && maxTokens !== undefined && maxTokens > contextWindow) {
    contextWindow = undefined;
    maxTokens = undefined;
  }
  const model: DiscoveredModel = { id };
  if (name && name !== id) model.name = name;
  if (contextWindow !== undefined) model.contextWindow = contextWindow;
  if (maxTokens !== undefined) model.maxTokens = maxTokens;
  return model;
}

function listFromResponse(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of ["data", "models", "results", "items"]) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
    if (isRecord(candidate)) return Object.values(candidate);
  }
  return [];
}

export function parseDiscoveredModels(value: unknown, options?: ParseDiscoveredModelsOptions): DiscoveredModel[] {
  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  for (const item of listFromResponse(value)) {
    const model = modelFromValue(item, options?.api);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id, undefined, {
    numeric: true,
    sensitivity: "base",
  }));
}

export function buildModelsListUrl(baseUrl: string, api: string): URL {
  const url = new URL(baseUrl.trim());
  const trimmedPath = url.pathname.replace(/\/+$/, "");

  if (!/\/models$/i.test(trimmedPath)) {
    let path = trimmedPath;
    if (api === "anthropic-messages" && !/\/v\d+(?:beta)?$/i.test(path)) path += "/v1";
    if (api === "google-generative-ai" && !/\/v\d+(?:beta)?$/i.test(path)) path += "/v1beta";
    url.pathname = `${path}/models`.replace(/\/+/g, "/");
  }

  if (api === "anthropic-messages" && !url.searchParams.has("limit")) {
    url.searchParams.set("limit", "1000");
  }
  if (api === "google-generative-ai" && !url.searchParams.has("pageSize")) {
    url.searchParams.set("pageSize", "1000");
  }
  return url;
}

export interface DiscoveryAbort {
  signal: AbortSignal;
  timedOut: () => boolean;
  /** Cancel without counting as a timeout (model switch, form close, a newer read). */
  cancel: () => void;
  dispose: () => void;
}

/** Client-side timeout plus an external cancel signal. Dispose clears the timer. */
export function createDiscoveryAbort(parent?: AbortSignal, timeoutMs = MODEL_DISCOVERY_TIMEOUT_MS): DiscoveryAbort {
  const controller = new AbortController();
  let didTimeout = false;
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return;
    didTimeout = true;
    controller.abort(new DOMException("The model list request timed out", "TimeoutError"));
  }, timeoutMs);
  const onParentAbort = () => {
    clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort(parent?.reason);
  };
  if (parent) {
    if (parent.aborted) onParentAbort();
    else parent.addEventListener("abort", onParentAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    cancel: () => {
      clearTimeout(timer);
      if (!controller.signal.aborted) controller.abort();
    },
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

export async function requestDiscoveredModels(input: {
  providerName: string;
  provider: object;
  signal?: AbortSignal;
}): Promise<{ models: DiscoveredModel[]; endpoint?: string }> {
  const provider = { ...(input.provider as Record<string, unknown>) };
  delete provider.models;
  const response = await fetch("/api/models-config/discover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerName: input.providerName, provider }),
    signal: input.signal,
  });
  let data: { models?: DiscoveredModel[]; endpoint?: string; error?: string } = {};
  try {
    data = await response.json() as typeof data;
  } catch {
    data = {};
  }
  if (!response.ok || data.error || !Array.isArray(data.models)) {
    throw new Error(typeof data.error === "string" && data.error ? data.error : `HTTP ${response.status}`);
  }
  return { models: data.models, endpoint: data.endpoint };
}
