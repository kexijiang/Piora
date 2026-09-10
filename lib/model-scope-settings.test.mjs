import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("./model-scope-settings.ts");
  } catch {
    return import("./model-scope-settings.ts");
  }
}

const {
  assertModelScopeSettingsReadable,
  buildModelScopeSettingsState,
  hasProjectEnabledModelsOverride,
  ModelScopeMutationError,
  ModelScopeSettingsReadError,
  ModelScopeSettingsWriteError,
  mutateModelScopeSettings,
  persistEnabledModelPatterns,
} = await loadSubject();

const MODELS = [
  { id: "claude-opus", provider: "anthropic", name: "Claude Opus" },
  { id: "claude-sonnet", provider: "anthropic", name: "Claude Sonnet" },
  { id: "deepseek-v4", provider: "deepseek", name: "DeepSeek V4" },
];

const runtime = (models = MODELS) => ({ getAvailable: async () => models });

test("unconfigured scope exposes every available model and uses null for all", async () => {
  const state = await buildModelScopeSettingsState({
    runtime: runtime(),
    enabledPatterns: undefined,
    defaultProvider: "deepseek",
    defaultModel: "deepseek-v4",
    environment: {},
  });

  assert.equal(state.enabledPatterns, null);
  assert.equal(state.enabledCount, 3);
  assert.equal(state.totalCount, 3);
  assert.ok(state.models.every((model) => model.enabled));
  assert.deepEqual(state.effectiveDefault, { provider: "deepseek", modelId: "deepseek-v4" });
  // Piora deliberately prioritizes DeepSeek in the visible selector.
  assert.equal(state.models[0].provider, "deepseek");
});

test("hiding from an unconfigured scope creates an exact allow-list", async () => {
  const state = await buildModelScopeSettingsState({ runtime: runtime(), enabledPatterns: undefined, environment: {} });
  const result = mutateModelScopeSettings(state, {
    action: "hide",
    provider: "anthropic",
    id: "claude-opus",
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.patterns, [
    "deepseek/deepseek-v4",
    "anthropic/claude-sonnet",
  ]);
});

test("hiding a broad glob expansion preserves pins and unmatched patterns", async () => {
  const state = await buildModelScopeSettingsState({
    runtime: runtime(),
    enabledPatterns: ["anthropic/*:high", "ghost-provider/*"],
    environment: {},
  });
  const result = mutateModelScopeSettings(state, {
    action: "hide",
    provider: "anthropic",
    id: "claude-opus",
  });

  assert.deepEqual(result.patterns, [
    "anthropic/claude-sonnet:high",
    "ghost-provider/*",
  ]);
  assert.deepEqual(state.warnings, []);
});

test("a wholly stale scope falls back to all and can still hide one model safely", async () => {
  const state = await buildModelScopeSettingsState({
    runtime: runtime(),
    enabledPatterns: ["ghost-provider/*"],
    environment: {},
  });
  assert.equal(state.enabledCount, MODELS.length);
  assert.deepEqual(state.warnings, []);

  const result = mutateModelScopeSettings(state, {
    action: "hide",
    provider: "deepseek",
    id: "deepseek-v4",
  });
  assert.deepEqual(result.patterns, [
    "anthropic/claude-opus",
    "anthropic/claude-sonnet",
    "ghost-provider/*",
  ]);
});

test("settings omit deleted-model warnings while retaining actionable model diagnostics", async () => {
  const patterns = ["deleted/old-model:invalid", "anthropic/claude-opus:invalid"];
  const state = await buildModelScopeSettingsState({ runtime: runtime(), enabledPatterns: patterns, environment: {} });
  assert.equal(state.warnings.length, 1);
  assert.match(state.warnings[0], /invalid/);
  assert.doesNotMatch(state.warnings[0], /deleted/);
  assert.deepEqual(state.enabledPatterns, patterns);
  assert.deepEqual(state.stalePatterns, ["deleted/old-model:invalid"]);
  assert.equal(state.models.find((model) => model.id === "claude-opus").enabled, true);
  assert.equal(state.models.some((model) => model.provider === "deleted"), false);
});

test("model identities containing slashes and colons are compared exactly", async () => {
  const specialModels = [
    { id: "vendor/model:exacto", provider: "openrouter", name: "Exacto" },
    { id: "vendor/model", provider: "openrouter", name: "Base" },
  ];
  const state = await buildModelScopeSettingsState({
    runtime: runtime(specialModels),
    enabledPatterns: undefined,
    environment: {},
  });
  const result = mutateModelScopeSettings(state, {
    action: "hide",
    provider: "openrouter",
    id: "vendor/model:exacto",
  });

  assert.deepEqual(result.patterns, ["openrouter/vendor/model"]);
});

test("provider visibility changes are atomic and keep model ids containing slashes", async () => {
  const specialModels = [
    { id: "vendor/model:exacto", provider: "openrouter", name: "Exacto" },
    { id: "vendor/model", provider: "openrouter", name: "Base" },
    { id: "deepseek-v4", provider: "deepseek", name: "DeepSeek V4" },
  ];
  const state = await buildModelScopeSettingsState({
    runtime: runtime(specialModels),
    enabledPatterns: undefined,
    environment: {},
  });

  assert.deepEqual(
    mutateModelScopeSettings(state, { action: "hide-provider", provider: "openrouter" }),
    { changed: true, patterns: ["deepseek/deepseek-v4"] },
  );
});

test("hidden providers restore only their missing models and retain stale patterns", async () => {
  const state = await buildModelScopeSettingsState({
    runtime: runtime(),
    enabledPatterns: ["anthropic/claude-opus:high", "ghost-provider/*"],
    environment: {},
  });

  const result = mutateModelScopeSettings(state, {
    action: "restore-provider",
    provider: "anthropic",
  });
  assert.deepEqual(result.patterns, [
    "anthropic/claude-opus:high",
    "ghost-provider/*",
    "anthropic/claude-sonnet",
  ]);
});

test("provider actions are idempotent and reject hiding the final visible provider", async () => {
  const hiddenState = await buildModelScopeSettingsState({
    runtime: runtime(),
    enabledPatterns: ["deepseek/deepseek-v4"],
    environment: {},
  });
  assert.deepEqual(
    mutateModelScopeSettings(hiddenState, { action: "hide-provider", provider: "anthropic" }),
    { changed: false, patterns: ["deepseek/deepseek-v4"] },
  );
  assert.throws(
    () => mutateModelScopeSettings(hiddenState, { action: "hide-provider", provider: "deepseek" }),
    (error) => error instanceof ModelScopeMutationError && error.code === "last_model",
  );
  assert.throws(
    () => mutateModelScopeSettings(hiddenState, { action: "restore-provider", provider: "ghost" }),
    (error) => error instanceof ModelScopeMutationError && error.code === "provider_not_found",
  );
});

test("the last available model cannot be hidden", async () => {
  const state = await buildModelScopeSettingsState({
    runtime: runtime(),
    enabledPatterns: ["anthropic/claude-opus"],
    environment: {},
  });

  assert.throws(
    () => mutateModelScopeSettings(state, {
      action: "hide",
      provider: "anthropic",
      id: "claude-opus",
    }),
    (error) => error instanceof ModelScopeMutationError && error.code === "last_model",
  );
});

test("restoring the complete catalogue clears enabledModels back to undefined", async () => {
  const twoModels = MODELS.slice(0, 2);
  const state = await buildModelScopeSettingsState({
    runtime: runtime(twoModels),
    enabledPatterns: ["anthropic/claude-opus"],
    environment: {},
  });
  const result = mutateModelScopeSettings(state, {
    action: "restore",
    provider: "anthropic",
    id: "claude-sonnet",
  });

  assert.equal(result.changed, true);
  assert.equal(result.patterns, undefined);
  assert.deepEqual(
    mutateModelScopeSettings(state, { action: "restore-all" }),
    { changed: true, patterns: undefined },
  );
});

test("hiding a configured default preserves it while selecting an effective fallback", async () => {
  const state = await buildModelScopeSettingsState({
    runtime: runtime(MODELS.slice(0, 2)),
    enabledPatterns: ["anthropic/claude-sonnet"],
    defaultProvider: "anthropic",
    defaultModel: "claude-opus",
    environment: {},
  });

  assert.deepEqual(state.configuredDefault, { provider: "anthropic", modelId: "claude-opus" });
  assert.deepEqual(state.effectiveDefault, { provider: "anthropic", modelId: "claude-sonnet" });
});

test("unknown models fail without producing a replacement scope", async () => {
  const state = await buildModelScopeSettingsState({ runtime: runtime(), enabledPatterns: undefined, environment: {} });
  assert.throws(
    () => mutateModelScopeSettings(state, { action: "hide", provider: "ghost", id: "missing" }),
    (error) => error instanceof ModelScopeMutationError && error.code === "model_not_found",
  );
});

test("settings read errors fail closed before any mutation", () => {
  const settings = {
    drainErrors: () => [{ scope: "global", error: new Error("malformed settings") }],
    setEnabledModels: () => assert.fail("must not write"),
    flush: async () => {},
  };
  assert.throws(
    () => assertModelScopeSettingsReadable(settings),
    ModelScopeSettingsReadError,
  );
});

test("an explicitly configured project scope is detected even when it is empty", () => {
  assert.equal(hasProjectEnabledModelsOverride({}), false);
  assert.equal(hasProjectEnabledModelsOverride({ enabledModels: undefined }), false);
  assert.equal(hasProjectEnabledModelsOverride({ enabledModels: [] }), true);
  assert.equal(hasProjectEnabledModelsOverride({ enabledModels: ["anthropic/*"] }), true);
});

test("persistence flushes before invalidation and reports queued write failures", async () => {
  const calls = [];
  const success = {
    setEnabledModels(patterns) { calls.push(["set", patterns]); },
    async flush() { calls.push(["flush"]); },
    drainErrors() { calls.push(["drain"]); return []; },
  };
  await persistEnabledModelPatterns(success, ["anthropic/claude-opus"], () => calls.push(["invalidate"]));
  assert.deepEqual(calls, [
    ["set", ["anthropic/claude-opus"]],
    ["flush"],
    ["drain"],
    ["invalidate"],
  ]);

  let invalidated = false;
  const failure = {
    setEnabledModels() {},
    async flush() {},
    drainErrors() { return [{ scope: "global", error: new Error("disk full") }]; },
  };
  await assert.rejects(
    persistEnabledModelPatterns(failure, ["anthropic/claude-opus"], () => { invalidated = true; }),
    ModelScopeSettingsWriteError,
  );
  assert.equal(invalidated, false);
});
