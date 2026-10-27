import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const limits = await jiti.import("./model-limits.ts");
const { estimateSessionContextUsage } = await jiti.import("./context-usage.ts");
const { getDirectPromptTokenBudget } = await jiti.import("./prompt-input-policy.ts");
const { enLocale } = await jiti.import("./i18n/messages/en.ts");
const { zhCNLocale } = await jiti.import("./i18n/messages/zh-CN.ts");

test("model limits accept only positive integers with max output inside the context", () => {
  const cases = [
    [{}, "required", "contextWindow"],
    [{ contextWindow: 10 }, "required", "maxTokens"],
    [{ contextWindow: 0, maxTokens: 1 }, "not-positive-integer", "contextWindow"],
    [{ contextWindow: 10, maxTokens: -1 }, "not-positive-integer", "maxTokens"],
    [{ contextWindow: 10.5, maxTokens: 1 }, "not-positive-integer", "contextWindow"],
    [{ contextWindow: "10", maxTokens: 1 }, "not-positive-integer", "contextWindow"],
    [{ contextWindow: null, maxTokens: 1 }, "required", "contextWindow"],
    [{ contextWindow: 10, maxTokens: 11 }, "output-exceeds-context"],
    [{ contextWindow: 10, maxTokens: 10 }, null],
  ];
  for (const [model, code, field] of cases) {
    const problem = limits.modelLimitProblem(model);
    assert.equal(problem?.code ?? null, code);
    if (field) assert.equal(problem.field, field);
  }
  assert.equal(limits.parseModelLimitDraft("1.5"), 1.5);
  assert.equal(limits.parseModelLimitDraft(""), undefined);
  assert.deepEqual(limits.storedModelLimits({}), { contextWindow: undefined, maxTokens: undefined });
  assert.deepEqual(limits.storedModelLimits({ contextWindow: 0, maxTokens: -2 }), { contextWindow: 0, maxTokens: -2 });
  assert.match(limits.modelLimitsError({ id: "m" }), /m: contextWindow is required/);
  assert.match(limits.modelLimitsError({ id: "m", contextWindow: 1.2, maxTokens: 1 }), /contextWindow must be a positive integer/);
  assert.match(limits.modelLimitsError({ id: "m", contextWindow: 4, maxTokens: 5 }), /maxTokens must be less than or equal to contextWindow/);
});

test("save blockers keep sampling, then model id, then limits, and the page block can be turned off", () => {
  assert.equal(limits.LEGACY_MODEL_LIMIT_RUNTIME, "keep-sdk-resolution");
  assert.equal(limits.BLOCK_ALL_SAVES_UNTIL_MODEL_LIMITS_COMPLETE, true);
  assert.deepEqual(limits.automaticModelLimitSources(), ["endpoint"]);
  const sampling = { p: { models: [
    { id: "ok", contextWindow: 10, maxTokens: 4, samplingParams: { temperature: -1 } },
    { id: "" },
    { id: "missing" },
  ] } };
  assert.equal(limits.firstCustomModelSaveBlocker(sampling).kind, "sampling");
  assert.equal(limits.firstCustomModelSaveBlocker({ p: { models: [{ id: "" }, { id: "missing" }] } }).kind, "modelId");
  const limitsOnly = limits.firstCustomModelSaveBlocker({ p: { models: [{ id: "missing" }, { id: "wide", contextWindow: 4, maxTokens: 5 }] } });
  assert.deepEqual({ kind: limitsOnly.kind, index: limitsOnly.index }, { kind: "limits", index: 0 });
  assert.equal(limits.firstCustomModelSaveBlocker({ p: { models: [{ id: "missing" }] } }, { requireLimits: false }), null);
  assert.deepEqual(limits.customModelsMissingLimits({ p: { models: [{ id: "" }, { id: " missing ", contextWindow: 8, maxTokens: 2 }, { id: "gap" }] } }), [
    { providerName: "p", index: 2, id: "gap" },
  ]);
});

test("endpoint fill only writes empty fields and ui meta is stripped before save", () => {
  const original = { id: "a", contextWindow: 0 };
  const filled = limits.applyEndpointLimits(original, { contextWindow: 99, maxTokens: 4 });
  assert.equal(original.contextWindow, 0);
  assert.equal(original.maxTokens, undefined);
  assert.equal(filled.changed, true);
  assert.equal(filled.model.contextWindow, 0);
  assert.equal(filled.model.maxTokens, 4);
  assert.equal(filled.model.limitsMeta.maxTokens, "endpoint");
  assert.equal(filled.model.limitsMeta.contextWindow, undefined);
  assert.equal(filled.model.limitsMeta.unavailable, undefined);

  const empty = limits.applyEndpointLimits({ id: "b" }, undefined);
  assert.equal(empty.model.limitsMeta.unavailable.contextWindow, true);
  assert.equal(empty.model.limitsMeta.unavailable.maxTokens, true);
  assert.equal(empty.model.contextWindow, undefined);

  const kept = limits.applyEndpointLimits({ id: "c", contextWindow: 20, maxTokens: 5, limitsMeta: { contextWindow: "models.dev" } }, { contextWindow: 99, maxTokens: 9 });
  assert.equal(kept.changed, false);

  const clean = { id: "clean", contextWindow: 8, maxTokens: 2 };
  const dirty = { id: "dirty", contextWindow: 8, maxTokens: 2, limitsMeta: { contextWindow: "endpoint" } };
  const config = { providers: { p: { models: [clean, dirty] } } };
  const stripped = limits.stripModelLimitUiMeta(config);
  assert.equal(stripped.providers.p.models[0], clean);
  assert.equal(stripped.providers.p.models[1].limitsMeta, undefined);
  assert.equal(config.providers.p.models[1].limitsMeta.contextWindow, "endpoint");
  assert.equal(limits.stripModelLimitUiMeta(stripped), stripped);

  const discovered = limits.applyDiscoveredLimits({
    p: { models: [{ id: "" }, { id: "keep", contextWindow: 10 }, { id: "fill" }] },
    other: { models: [{ id: "untouched" }] },
  }, { p: [{ id: "fill", contextWindow: 30, maxTokens: 6 }] });
  assert.equal(discovered.changed, true);
  assert.equal(discovered.providers.p.models[0].id, "");
  assert.equal(discovered.providers.p.models[0].limitsMeta, undefined);
  assert.equal(discovered.providers.p.models[1].contextWindow, 10);
  assert.equal(discovered.providers.p.models[1].maxTokens, undefined);
  assert.equal(discovered.providers.p.models[1].limitsMeta.unavailable.maxTokens, true);
  assert.equal(discovered.providers.p.models[2].contextWindow, 30);
  assert.equal(discovered.providers.p.models[2].maxTokens, 6);
  assert.equal(discovered.providers.other.models[0].limitsMeta, undefined);
});

test("legacy configs keep the SDK resolution without rewriting the file or inventing a Piora default", async () => {
  const { ModelConfig } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/model-config.js");
  const { composeModelProvider } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/provider-composer.js");
  const { shouldCompact } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js");
  const { clampMaxTokensToContext } = await import("../node_modules/@earendil-works/pi-ai/dist/api/simple-options.js");
  const directory = mkdtempSync(path.join(tmpdir(), "piora-model-limits-"));
  const filename = path.join(directory, "models.json");
  const raw = {
    providers: {
      custom: {
        api: "openai-completions",
        baseUrl: "https://example.invalid/v1",
        apiKey: "fixture",
        models: [
          { id: "legacy", name: "Legacy" },
          { id: "explicit", contextWindow: 1000, maxTokens: 100 },
        ],
      },
    },
  };
  writeFileSync(filename, JSON.stringify(raw));
  const before = readFileSync(filename, "utf8");
  try {
    const loaded = await ModelConfig.load(filename);
    assert.equal(loaded.getError(), undefined);
    const models = composeModelProvider("custom", undefined, loaded, undefined).getModels();
    const legacy = models.find((model) => model.id === "legacy");
    const explicit = models.find((model) => model.id === "explicit");
    assert.equal(legacy.contextWindow, 128000);
    assert.equal(legacy.maxTokens, 16384);
    assert.equal(explicit.contextWindow, 1000);
    assert.equal(explicit.maxTokens, 100);
    assert.equal(readFileSync(filename, "utf8"), before);
    assert.equal(before.includes("128000"), false);
    assert.equal(before.includes("16384"), false);
    assert.equal(shouldCompact(100, legacy.contextWindow, { enabled: true, reserveTokens: 16384 }), false);
    assert.equal(shouldCompact(legacy.contextWindow - 16384 + 1, legacy.contextWindow, { enabled: true, reserveTokens: 16384 }), true);
    assert.equal(clampMaxTokensToContext({ contextWindow: 20000, maxTokens: 8000 }, { messages: [] }, 8000), 8000);
    assert.equal(clampMaxTokensToContext({ contextWindow: 1000, maxTokens: 100 }, { messages: [] }, 100), 1);
    assert.equal(estimateSessionContextUsage([], 0), null);
    assert.equal(getDirectPromptTokenBudget({ contextWindow: 0, tokens: 10 }), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("limit help is translated and does not advertise a hidden default", () => {
  for (const key of [
    "models.limits.help",
    "models.limits.endpointMissing",
    "models.limits.missingBanner",
    "models.limits.saveError",
    "models.limits.sourceEndpoint",
    "models.limits.sourceCatalog",
  ]) {
    assert.equal(typeof enLocale.messages[key], "string", key);
    assert.equal(typeof zhCNLocale.messages[key], "string", key);
    assert.equal(enLocale.messages[key].includes("128000"), false, key);
    assert.equal(zhCNLocale.messages[key].includes("16384"), false, key);
  }
  assert.match(zhCNLocale.messages["models.limits.help"], /当前已用/);
  assert.match(zhCNLocale.messages["models.limits.endpointMissing"], /接口未提供，请手动填写/);
  assert.match(enLocale.messages["models.limits.help"], /context − used − 4096/);
  assert.match(enLocale.messages["models.limits.endpointMissing"], /Enter it manually/);
});
