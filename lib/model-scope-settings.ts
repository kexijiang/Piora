import {
  resolveModelScopeWithDiagnostics,
  type ModelRuntime,
  type ScopedModel,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { prioritizeProvider, resolveDefaultModelPreference } from "./model-policy";
import { modelScopeWarnings } from "./model-scope";

export interface ModelScopeModelView {
  provider: string;
  id: string;
  name: string;
  enabled: boolean;
}

export interface ModelScopeDefault {
  provider: string;
  modelId: string;
}

interface PiSettingsError {
  scope: "global" | "project";
  error: Error;
}

interface PersistenceEntry {
  pattern: string;
  modelKey?: string;
}

export interface ModelScopeSettingsState {
  models: ModelScopeModelView[];
  enabledPatterns: string[] | null;
  warnings: string[];
  enabledCount: number;
  totalCount: number;
  configuredDefault: ModelScopeDefault | null;
  effectiveDefault: ModelScopeDefault | null;
  /** Exact, pin-preserving entries used only when a mutation must be persisted. */
  persistenceEntries: PersistenceEntry[];
  availableModelKeys: Set<string>;
  enabledModelKeys: Set<string>;
  stalePatterns: string[];
}

export type ModelScopeMutation =
  | { action: "hide"; provider: string; id: string }
  | { action: "restore"; provider: string; id: string }
  | { action: "hide-provider"; provider: string }
  | { action: "restore-provider"; provider: string }
  | { action: "restore-all" };

export interface ModelScopeMutationResult {
  changed: boolean;
  patterns: string[] | undefined;
}

export class ModelScopeMutationError extends Error {
  constructor(
    readonly code: "model_not_found" | "provider_not_found" | "last_model",
    message: string,
  ) {
    super(message);
    this.name = "ModelScopeMutationError";
  }
}

export class ModelScopeSettingsReadError extends Error {
  constructor(readonly settingsErrors: PiSettingsError[]) {
    super("Pi settings could not be read safely.");
    this.name = "ModelScopeSettingsReadError";
  }
}

export class ModelScopeSettingsWriteError extends Error {
  constructor(readonly settingsErrors: PiSettingsError[]) {
    super("Pi settings could not be written.");
    this.name = "ModelScopeSettingsWriteError";
  }
}

interface EnabledModelsSettingsWriter {
  setEnabledModels(patterns: string[] | undefined): void;
  flush(): Promise<void>;
  drainErrors(): PiSettingsError[];
}

export function hasProjectEnabledModelsOverride(projectSettings: { enabledModels?: string[] }): boolean {
  return projectSettings.enabledModels !== undefined;
}

function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function serializeScopedModel(scoped: ScopedModel): PersistenceEntry {
  const key = modelKey(scoped.model);
  return {
    modelKey: key,
    pattern: scoped.thinkingLevel ? `${key}:${scoped.thinkingLevel}` : key,
  };
}

function configuredDefault(
  provider: string | undefined,
  modelId: string | undefined,
): ModelScopeDefault | null {
  const normalizedProvider = provider?.trim();
  const normalizedModelId = modelId?.trim();
  return normalizedProvider && normalizedModelId
    ? { provider: normalizedProvider, modelId: normalizedModelId }
    : null;
}

/**
 * Resolve both the complete available catalogue and Pi's effective enabled
 * scope. The persistence entries deliberately expand matching globs to exact
 * identities only when a user mutates the scope. This is the only reliable way
 * to subtract one model from a positive-only allow-list, while preserving
 * thinking-level pins and currently-unmatched patterns.
 */
export async function buildModelScopeSettingsState(options: {
  runtime: ModelRuntime;
  enabledPatterns: string[] | undefined;
  defaultProvider?: string;
  defaultModel?: string;
  environment?: Record<string, string | undefined>;
}): Promise<ModelScopeSettingsState> {
  const available = prioritizeProvider(
    [...await options.runtime.getAvailable()],
    (model) => model.provider,
  );
  const availableByKey = new Map<string, Model<Api>>();
  for (const model of available) {
    const key = modelKey(model);
    if (!availableByKey.has(key)) availableByKey.set(key, model);
  }
  const orderedAvailable = [...availableByKey.values()];
  const availableModelKeys = new Set(availableByKey.keys());
  const cleanedPatterns = unique(
    (options.enabledPatterns ?? []).map((pattern) => pattern.trim()).filter(Boolean),
  );

  const resolved = cleanedPatterns.length > 0
    ? await resolveModelScopeWithDiagnostics(cleanedPatterns, options.runtime)
    : undefined;
  // Pi treats an absent, empty, or wholly-unmatched scope as unfiltered. Keep
  // that safety invariant so a stale setting cannot leave the application with
  // no selectable model.
  const hasResolvedScope = Boolean(resolved?.scopedModels.length);
  const enabledModels = hasResolvedScope
    ? resolved!.scopedModels.map((scoped) => scoped.model)
    : orderedAvailable;
  const enabledModelKeys = new Set(enabledModels.map(modelKey));
  const stalePatterns = unique(
    (resolved?.diagnostics ?? [])
      .filter((diagnostic) => diagnostic.code === "no-match")
      .map((diagnostic) => diagnostic.pattern),
  );

  const persistenceEntries: PersistenceEntry[] = hasResolvedScope
    ? resolved!.scopedModels.map(serializeScopedModel)
    : orderedAvailable.map((model) => ({ pattern: modelKey(model), modelKey: modelKey(model) }));
  for (const pattern of stalePatterns) {
    if (!persistenceEntries.some((entry) => entry.pattern === pattern)) {
      persistenceEntries.push({ pattern });
    }
  }

  const rawDefault = configuredDefault(options.defaultProvider, options.defaultModel);
  const preferredDefault = resolveDefaultModelPreference({
    models: enabledModels,
    settingsProvider: rawDefault?.provider,
    settingsModel: rawDefault?.modelId,
    environment: options.environment ?? process.env,
  });
  const fallbackDefault = preferredDefault
    ?? (enabledModels[0]
      ? { provider: enabledModels[0].provider, modelId: enabledModels[0].id }
      : undefined);

  return {
    models: orderedAvailable.map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name ?? model.id,
      enabled: enabledModelKeys.has(modelKey(model)),
    })),
    enabledPatterns: cleanedPatterns.length > 0 ? cleanedPatterns : null,
    warnings: modelScopeWarnings(resolved?.diagnostics ?? []),
    enabledCount: enabledModelKeys.size,
    totalCount: availableModelKeys.size,
    configuredDefault: rawDefault,
    effectiveDefault: fallbackDefault ?? null,
    persistenceEntries,
    availableModelKeys,
    enabledModelKeys,
    stalePatterns,
  };
}

/** Apply one idempotent hide/restore action without touching the filesystem. */
export function mutateModelScopeSettings(
  state: ModelScopeSettingsState,
  mutation: ModelScopeMutation,
): ModelScopeMutationResult {
  if (mutation.action === "restore-all") {
    return {
      changed: state.enabledPatterns !== null,
      patterns: undefined,
    };
  }

  if (mutation.action === "hide-provider" || mutation.action === "restore-provider") {
    const providerModels = state.models.filter((model) => model.provider === mutation.provider);
    if (providerModels.length === 0) {
      throw new ModelScopeMutationError(
        "provider_not_found",
        `Provider is not available: ${mutation.provider}`,
      );
    }

    const providerKeys = providerModels.map(modelKey);
    const providerKeySet = new Set(providerKeys);
    const enabledProviderKeys = providerKeys.filter((key) => state.enabledModelKeys.has(key));

    if (mutation.action === "hide-provider") {
      if (enabledProviderKeys.length === 0) {
        return {
          changed: false,
          patterns: state.enabledPatterns ?? undefined,
        };
      }
      if (state.enabledCount - enabledProviderKeys.length < 1) {
        throw new ModelScopeMutationError(
          "last_model",
          "At least one available model must remain enabled.",
        );
      }
      return {
        changed: true,
        patterns: state.persistenceEntries
          .filter((entry) => !entry.modelKey || !providerKeySet.has(entry.modelKey))
          .map((entry) => entry.pattern),
      };
    }

    const missingProviderKeys = providerKeys.filter((key) => !state.enabledModelKeys.has(key));
    if (missingProviderKeys.length === 0) {
      return {
        changed: false,
        patterns: state.enabledPatterns ?? undefined,
      };
    }
    const nextEntries = [
      ...state.persistenceEntries,
      ...missingProviderKeys.map((key) => ({ modelKey: key, pattern: key })),
    ];
    const nextEnabledKeys = new Set(state.enabledModelKeys);
    missingProviderKeys.forEach((key) => nextEnabledKeys.add(key));
    const allAvailableEnabled = nextEnabledKeys.size === state.availableModelKeys.size
      && [...state.availableModelKeys].every((availableKey) => nextEnabledKeys.has(availableKey));
    return {
      changed: true,
      patterns: allAvailableEnabled && state.stalePatterns.length === 0
        ? undefined
        : nextEntries.map((entry) => entry.pattern),
    };
  }

  const key = `${mutation.provider}/${mutation.id}`;
  if (!state.availableModelKeys.has(key)) {
    throw new ModelScopeMutationError("model_not_found", `Model is not available: ${key}`);
  }

  const currentlyEnabled = state.enabledModelKeys.has(key);
  if (mutation.action === "hide") {
    if (!currentlyEnabled) {
      return {
        changed: false,
        patterns: state.enabledPatterns ?? undefined,
      };
    }
    if (state.enabledCount <= 1) {
      throw new ModelScopeMutationError("last_model", "At least one available model must remain enabled.");
    }
    return {
      changed: true,
      patterns: state.persistenceEntries
        .filter((entry) => entry.modelKey !== key)
        .map((entry) => entry.pattern),
    };
  }

  if (currentlyEnabled) {
    return {
      changed: false,
      patterns: state.enabledPatterns ?? undefined,
    };
  }

  const nextEntries = [
    ...state.persistenceEntries,
    { modelKey: key, pattern: key },
  ];
  const nextEnabledKeys = new Set(state.enabledModelKeys);
  nextEnabledKeys.add(key);
  const allAvailableEnabled = nextEnabledKeys.size === state.availableModelKeys.size
    && [...state.availableModelKeys].every((availableKey) => nextEnabledKeys.has(availableKey));
  // Clear the allow-list only when it contains exactly the complete available
  // catalogue. Unmatched patterns are retained unless the user explicitly asks
  // for restore-all, matching Pi's model selector behavior.
  const canReturnToUnfiltered = allAvailableEnabled && state.stalePatterns.length === 0;
  return {
    changed: true,
    patterns: canReturnToUnfiltered ? undefined : nextEntries.map((entry) => entry.pattern),
  };
}

/** Fail closed when SettingsManager loaded malformed settings. */
export function assertModelScopeSettingsReadable(settings: EnabledModelsSettingsWriter): void {
  const errors = settings.drainErrors();
  if (errors.length > 0) throw new ModelScopeSettingsReadError(errors);
}

/**
 * Persist through Pi's SettingsManager. `flush()` intentionally does not throw;
 * callers must inspect `drainErrors()` before reporting success or invalidating
 * the model cache.
 */
export async function persistEnabledModelPatterns(
  settings: EnabledModelsSettingsWriter,
  patterns: string[] | undefined,
  afterPersisted?: () => void,
): Promise<void> {
  settings.setEnabledModels(patterns);
  await settings.flush();
  const errors = settings.drainErrors();
  if (errors.length > 0) throw new ModelScopeSettingsWriteError(errors);
  afterPersisted?.();
}
