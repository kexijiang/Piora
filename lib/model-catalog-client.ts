export interface ModelCatalogEntry {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  isDefault?: boolean;
}

export interface ModelCatalogResponse {
  models: Record<string, string>;
  modelList?: ModelCatalogEntry[];
  defaultModel?: { provider: string; modelId: string } | null;
  thinkingLevels?: Record<string, string[]>;
  thinkingLevelMaps?: Record<string, Record<string, string | null>>;
  thinkingLevelPins?: Record<string, string>;
  modelError?: string;
  modelScopeWarnings?: string[];
  error?: string;
}

interface FetchModelCatalogOptions {
  cwd?: string;
  forceRefresh?: boolean;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  retryDelaysMs?: readonly number[];
  requestTimeoutMs?: number;
}

const STARTUP_RETRY_DELAYS_MS = [0, 400, 1_200] as const;
const MODEL_REQUEST_TIMEOUT_MS = 15_000;

class ModelCatalogHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ModelCatalogHttpError";
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, delayMs);
    const handleAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

function modelCatalogUrl(cwd: string | undefined, refresh: boolean): string {
  const params = new URLSearchParams();
  if (cwd) params.set("cwd", cwd);
  if (refresh) params.set("refresh", "1");
  const query = params.toString();
  return query ? `/api/models?${query}` : "/api/models";
}

function createAttemptSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timeoutReached = false;
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => {
    timeoutReached = true;
    controller.abort(new DOMException("Model catalog request timed out", "TimeoutError"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

/**
 * Load the model selector data with a short startup-only recovery window.
 * A first packaged request can overlap extension/model cache restoration; an
 * empty error response or a transient HTTP/network failure is retried with a
 * forced server refresh. Usable partial results are returned immediately.
 */
export async function fetchModelCatalog(options: FetchModelCatalogOptions = {}): Promise<ModelCatalogResponse> {
  const fetcher = options.fetcher ?? fetch;
  const delays = options.retryDelaysMs ?? STARTUP_RETRY_DELAYS_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? MODEL_REQUEST_TIMEOUT_MS;
  let lastError: Error | undefined;
  let lastData: ModelCatalogResponse | undefined;

  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    await waitForRetry(delays[attempt] ?? 0, options.signal);
    if (options.signal?.aborted) throw abortReason(options.signal);

    const attemptSignal = createAttemptSignal(options.signal, requestTimeoutMs);
    try {
      const response = await fetcher(
        modelCatalogUrl(options.cwd, options.forceRefresh === true || attempt > 0),
        { cache: "no-store", signal: attemptSignal.signal },
      );
      const data = await response.json() as ModelCatalogResponse;
      if (!response.ok) {
        const error = new ModelCatalogHttpError(data.error || `HTTP ${response.status}`, response.status);
        if (response.status < 500 || attempt === delays.length - 1) throw error;
        lastError = error;
        continue;
      }

      lastData = data;
      const hasUsableModels = (data.modelList?.length ?? 0) > 0;
      if (hasUsableModels || attempt === delays.length - 1) return data;
    } catch (error) {
      if (options.signal?.aborted) throw abortReason(options.signal);
      if (error instanceof ModelCatalogHttpError && error.status < 500) throw error;
      lastError = attemptSignal.timedOut()
        ? new Error("Model catalog request timed out")
        : error instanceof Error ? error : new Error(String(error));
      if (attempt === delays.length - 1) break;
    } finally {
      attemptSignal.cleanup();
    }
  }

  if (lastData) return lastData;
  throw lastError ?? new Error("Unable to load the model catalog");
}
