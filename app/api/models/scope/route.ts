import { createGlobalModelServices } from "@/lib/global-model-services";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { invalidateModelsCache } from "@/lib/models-cache";
import { setProviderRemoved, restoreRemovedProviders } from "@/lib/removed-providers";
import {
  createTrustedModelServices,
  ModelRequestCwdError,
  resolveModelRequestCwd,
} from "@/lib/model-runtime-context";
import {
  assertModelScopeSettingsReadable,
  buildModelScopeSettingsState,
  hasProjectEnabledModelsOverride,
  ModelScopeMutationError,
  ModelScopeSettingsReadError,
  ModelScopeSettingsWriteError,
  mutateModelScopeSettings,
  persistEnabledModelPatterns,
  type ModelScopeMutation,
  type ModelScopeSettingsState,
} from "@/lib/model-scope-settings";

export const dynamic = "force-dynamic";

interface PatchBody {
  scope?: "global";
  cwd?: unknown;
  action?: unknown;
  provider?: unknown;
  id?: unknown;
}

function jsonError(code: string, error: string, status: number): Response {
  return Response.json({ code, error }, { status });
}

function publicState(
  state: ModelScopeSettingsState,
  projectOverride: boolean,
  changed?: boolean,
) {
  return {
    removedProviders: state.removedProviders,
    models: state.models,
    enabledPatterns: state.enabledPatterns,
    projectOverride,
    warnings: state.warnings,
    enabledCount: state.enabledCount,
    totalCount: state.totalCount,
    configuredDefault: state.configuredDefault,
    effectiveDefault: state.effectiveDefault,
    ...(changed === undefined ? {} : { changed }),
  };
}

type SettingsMutation = ModelScopeMutation | { action: "set-default"; provider: string; id: string }
  | { action: "remove-provider"; provider: string }
  | { action: "restore-removed-provider"; provider: string };

function readMutation(body: PatchBody): SettingsMutation {
  if (body.action === "remove-provider" || body.action === "restore-removed-provider") {
    if (typeof body.provider !== "string" || !body.provider.trim()) throw new TypeError("provider is required");
    return { action: body.action, provider: body.provider.trim() };
  }
  if (body.action === "restore-all") return { action: "restore-all" };
  if (body.action === "set-default") {
    if (typeof body.provider !== "string" || !body.provider.trim()) throw new TypeError("provider is required for setting a default model");
    if (typeof body.id !== "string" || !body.id.trim()) throw new TypeError("id is required for setting a default model");
    return { action: body.action, provider: body.provider.trim(), id: body.id.trim() };
  }
  if (body.action === "hide-provider" || body.action === "restore-provider") {
    if (typeof body.provider !== "string" || !body.provider.trim()) {
      throw new TypeError("provider is required for provider visibility changes");
    }
    return { action: body.action, provider: body.provider.trim() };
  }
  if (body.action !== "hide" && body.action !== "restore") {
    throw new TypeError("action must be set-default, hide, restore, hide-provider, restore-provider, or restore-all");
  }
  if (typeof body.provider !== "string" || !body.provider.trim()) {
    throw new TypeError("provider is required for hide and restore");
  }
  if (typeof body.id !== "string" || !body.id.trim()) {
    throw new TypeError("id is required for hide and restore");
  }
  return {
    action: body.action,
    provider: body.provider.trim(),
    id: body.id.trim(),
  };
}

async function loadState(cwd: string | null) {
  const services = cwd === null ? await createGlobalModelServices() : await createTrustedModelServices(cwd);
  const settings: SettingsManager = services.settingsManager;
  assertModelScopeSettingsReadable(settings);
  const projectOverride = hasProjectEnabledModelsOverride(settings.getProjectSettings());
  const state = await buildModelScopeSettingsState({
    runtime: services.modelRuntime,
    enabledPatterns: settings.getEnabledModels(),
    defaultProvider: settings.getDefaultProvider(),
    defaultModel: settings.getDefaultModel(),
    environment: process.env,
  });
  const runtimeError = services.modelRuntime.getError();
  if (runtimeError && !state.warnings.includes(runtimeError)) state.warnings.push(runtimeError);
  return { services, settings, state, projectOverride };
}

function handleKnownError(error: unknown): Response | undefined {
  if (error instanceof ModelRequestCwdError) {
    return jsonError(error.code, error.message, error.status);
  }
  if (error instanceof ModelScopeSettingsReadError) {
    return jsonError("settings_unreadable", error.message, 409);
  }
  if (error instanceof ModelScopeSettingsWriteError) {
    return jsonError("settings_write_failed", error.message, 500);
  }
  if (error instanceof ModelScopeMutationError) {
    return jsonError(
      error.code,
      error.message,
      error.code === "model_not_found" || error.code === "provider_not_found" ? 404 : 409,
    );
  }
  return undefined;
}

export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const cwd = params.get("scope") === "global" ? null : await resolveModelRequestCwd(params.get("cwd"));
    const { state, projectOverride } = await loadState(cwd);
    return Response.json(publicState(state, projectOverride));
  } catch (error) {
    const known = handleKnownError(error);
    if (known) return known;
    return jsonError(
      "model_scope_load_failed",
      error instanceof Error ? error.message : String(error),
      500,
    );
  }
}

export async function PATCH(req: Request) {
  let body: PatchBody;
  try {
    body = await req.json() as PatchBody;
  } catch {
    return jsonError("invalid_request", "Request body must be valid JSON.", 400);
  }
  if (body.cwd !== undefined && typeof body.cwd !== "string") {
    return jsonError("invalid_request", "cwd must be a string.", 400);
  }

  let mutation: SettingsMutation;
  try {
    mutation = readMutation(body);
  } catch (error) {
    return jsonError(
      "invalid_request",
      error instanceof Error ? error.message : String(error),
      400,
    );
  }

  try {
    const cwd = body.scope === "global" ? null : await resolveModelRequestCwd(body.cwd);
    const { services, settings, state, projectOverride } = await loadState(cwd);
    if (mutation.action === "remove-provider" || mutation.action === "restore-removed-provider") {
      // This preference is independent of auth, catalog availability and the
      // positive-only SDK scope, which cannot represent removing the last model.
      const changed = setProviderRemoved(mutation.provider, mutation.action === "remove-provider");
      if (changed) invalidateModelsCache();
      const next = await loadState(cwd);
      return Response.json(publicState(next.state, next.projectOverride, changed));
    }
    if (projectOverride && mutation.action !== "set-default") {
      return jsonError(
        "project_scope_override",
        "This project defines .pi/settings.json enabledModels, which overrides the global model scope.",
        409,
      );
    }

    if (mutation.action === "set-default") {
      const model = state.models.find((item) => item.provider === mutation.provider && item.id === mutation.id);
      if (!model) throw new ModelScopeMutationError("model_not_found", `Model is not available: ${mutation.provider}/${mutation.id}`);
      if (!model.enabled) return jsonError("model_disabled", "Enable the model before setting it as default.", 409);
      settings.setDefaultModelAndProvider(mutation.provider, mutation.id);
      await settings.flush();
      const errors = settings.drainErrors();
      if (errors.length > 0) throw new ModelScopeSettingsWriteError(errors);
      invalidateModelsCache();
      const nextState = await buildModelScopeSettingsState({ runtime: services.modelRuntime, enabledPatterns: settings.getEnabledModels(), defaultProvider: settings.getDefaultProvider(), defaultModel: settings.getDefaultModel(), environment: process.env });
      return Response.json(publicState(nextState, projectOverride, true));
    }

    const result = mutateModelScopeSettings(state, mutation);
    const restoreRemoved = mutation.action === "restore-all" && state.removedProviders.length > 0;
    if (!result.changed && !restoreRemoved) {
      return Response.json(publicState(state, false, false));
    }

    // Invalidate only after SettingsManager has flushed successfully and
    // reported no queued write errors. The cache generation also prevents an
    // older in-flight load from repopulating stale data.
    if (result.changed) await persistEnabledModelPatterns(settings, result.patterns, invalidateModelsCache);
    if (restoreRemoved && restoreRemovedProviders()) invalidateModelsCache();

    const nextState = await buildModelScopeSettingsState({
      runtime: services.modelRuntime,
      enabledPatterns: settings.getEnabledModels(),
      defaultProvider: settings.getDefaultProvider(),
      defaultModel: settings.getDefaultModel(),
      environment: process.env,
    });
    const runtimeError = services.modelRuntime.getError();
    if (runtimeError && !nextState.warnings.includes(runtimeError)) nextState.warnings.push(runtimeError);
    return Response.json(publicState(nextState, false, true));
  } catch (error) {
    const known = handleKnownError(error);
    if (known) return known;
    return jsonError(
      "model_scope_update_failed",
      error instanceof Error ? error.message : String(error),
      500,
    );
  }
}
