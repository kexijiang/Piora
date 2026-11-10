import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("./model-policy.ts");
  } catch {
    return import("./model-policy.ts");
  }
}

const {
  prioritizeProvider,
  readPioraDefaultModel,
  resolveDefaultModelPreference,
} = await loadSubject();

const models = [
  { provider: "anthropic", id: "claude-sonnet" },
  { provider: "deepseek", id: "deepseek-chat" },
  { provider: "openai", id: "gpt" },
  { provider: "deepseek", id: "deepseek-reasoner" },
];

test("moves DeepSeek first while preserving both partitions", () => {
  const ordered = prioritizeProvider(models, (model) => model.provider);
  assert.deepEqual(ordered.map((model) => `${model.provider}/${model.id}`), [
    "deepseek/deepseek-chat",
    "deepseek/deepseek-reasoner",
    "anthropic/claude-sonnet",
    "openai/gpt",
  ]);
  assert.deepEqual(models.map((model) => model.provider), [
    "anthropic", "deepseek", "openai", "deepseek",
  ]);
});

test("reads a complete PIORA desktop default without accepting partial config", () => {
  assert.deepEqual(readPioraDefaultModel({
    PIORA_DEFAULT_PROVIDER: " deepseek ",
    PIORA_DEFAULT_MODEL: " deepseek-reasoner ",
  }), { provider: "deepseek", modelId: "deepseek-reasoner" });
  assert.equal(readPioraDefaultModel({ PIORA_DEFAULT_PROVIDER: "deepseek" }), undefined);
});

test("first displayed model is the default even with legacy settings", () => {
  assert.deepEqual(resolveDefaultModelPreference({
    models,
    settingsProvider: "anthropic",
    settingsModel: "claude-sonnet",
    environment: {
      PIORA_DEFAULT_PROVIDER: "openai",
      PIORA_DEFAULT_MODEL: "gpt",
    },
  }), { provider: "anthropic", modelId: "claude-sonnet" });
});

test("launcher defaults do not override display order", () => {
  assert.deepEqual(resolveDefaultModelPreference({
    models,
    environment: {
      PIORA_DEFAULT_PROVIDER: "openai",
      PIORA_DEFAULT_MODEL: "gpt",
    },
  }), { provider: "anthropic", modelId: "claude-sonnet" });
});

test("uses the first available displayed model", () => {
  assert.deepEqual(resolveDefaultModelPreference({
    models,
    environment: {},
  }), { provider: "anthropic", modelId: "claude-sonnet" });
});

test("an explicit Piora choice survives display order changes without reordering models", () => {
  const explicitDefault = { provider: "deepseek", modelId: "deepseek-reasoner" };
  for (const ordered of [models, [...models].reverse()]) {
    assert.deepEqual(resolveDefaultModelPreference({ models: ordered, explicitDefault, environment: {} }), explicitDefault);
  }
  assert.equal(models[0].provider, "anthropic");
});

test("an unavailable explicit default falls back by full provider/model identity", () => {
  assert.deepEqual(resolveDefaultModelPreference({ models, explicitDefault: { provider: "other", modelId: "deepseek-reasoner" }, environment: {} }), { provider: "anthropic", modelId: "claude-sonnet" });
  assert.equal(resolveDefaultModelPreference({ models: [], explicitDefault: { provider: "deepseek", modelId: "deepseek-reasoner" }, environment: {} }), undefined);
});

test("ignores unavailable settings and launcher defaults", () => {
  assert.deepEqual(resolveDefaultModelPreference({
    models,
    settingsProvider: "missing",
    settingsModel: "missing",
    environment: {
      PIORA_DEFAULT_PROVIDER: "openai",
      PIORA_DEFAULT_MODEL: "missing",
    },
  }), { provider: "anthropic", modelId: "claude-sonnet" });
});
