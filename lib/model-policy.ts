export const PIORA_DEFAULT_PROVIDER_ENV = "PIORA_DEFAULT_PROVIDER";
export const PIORA_DEFAULT_MODEL_ENV = "PIORA_DEFAULT_MODEL";
export const DEFAULT_PREFERRED_PROVIDER = "deepseek";

export interface ModelReference {
  provider: string;
  modelId: string;
}

export interface ModelIdentity {
  provider: string;
  id: string;
}

type Environment = Record<string, string | undefined>;

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function asReference(
  provider: string | null | undefined,
  modelId: string | null | undefined,
): ModelReference | undefined {
  const normalizedProvider = nonEmpty(provider);
  const normalizedModelId = nonEmpty(modelId);
  return normalizedProvider && normalizedModelId
    ? { provider: normalizedProvider, modelId: normalizedModelId }
    : undefined;
}

/** Read the non-secret desktop default packaged or supplied by the launcher. */
export function readPioraDefaultModel(environment: Environment): ModelReference | undefined {
  return asReference(
    environment[PIORA_DEFAULT_PROVIDER_ENV],
    environment[PIORA_DEFAULT_MODEL_ENV],
  );
}

/**
 * Resolve the default for a new desktop session.
 *
 * The first available model in display order is the default. Legacy settings
 * and launcher defaults must not silently override the user's channel order.
 */
export function resolveDefaultModelPreference(options: {
  models: readonly ModelIdentity[];
  settingsProvider?: string | null;
  settingsModel?: string | null;
  environment: Environment;
  preferredProvider?: string;
}): ModelReference | undefined {
  const first = options.models[0];
  return first ? { provider: first.provider, modelId: first.id } : undefined;
}

/**
 * Move one provider to the front without mutating the input or reordering any
 * items within the preferred and remaining partitions.
 */
export function prioritizeProvider<T>(
  items: readonly T[],
  getProvider: (item: T) => string,
  preferredProvider = DEFAULT_PREFERRED_PROVIDER,
): T[] {
  const normalizedPreferred = preferredProvider.toLocaleLowerCase();
  const preferred: T[] = [];
  const remaining: T[] = [];
  for (const item of items) {
    const target = getProvider(item).toLocaleLowerCase() === normalizedPreferred
      ? preferred
      : remaining;
    target.push(item);
  }
  return [...preferred, ...remaining];
}
