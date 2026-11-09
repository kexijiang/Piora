import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import ts from "typescript";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url);
const store = await jiti.import("./provider-order-store.ts");
const defaultStore = await jiti.import("./default-model-store.ts");
const { orderByProvider, moveProvider } = await jiti.import("./provider-order.ts");
const scopeHelpers = await jiti.import("./model-scope.ts");
const policy = await jiti.import("./model-policy.ts");
const { buildModelScopeSettingsState } = await jiti.import("./model-scope-settings.ts");
const cache = await jiti.import("./models-cache.ts");
const loadRoute = (file, modules) => {
  const js = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const api = {};
  new Function("require", "exports", js)(id => { assert.ok(modules[id], id); return modules[id]; }, api);
  return api;
};

test("channel ordering is stable, includes new channels and preserves model order", () => {
  const models = [{ provider: "a", id: "2" }, { provider: "b", id: "1" }, { provider: "a", id: "1" }, { provider: "c", id: "1" }];
  assert.deepEqual(orderByProvider(models, ["offline", "b", "a"], m => m.provider).map(m => `${m.provider}/${m.id}`), ["b/1", "a/2", "a/1", "c/1"]);
  assert.deepEqual(moveProvider(["a", "b", "c"], "a", "c"), ["b", "c", "a"]);
  assert.deepEqual(moveProvider(["a", "b", "c"], "c", "a"), ["c", "a", "b"]);
});

test("persisted channel and model order determine catalogue/default across scope, API and startup", async () => {
  const root = mkdtempSync(join(tmpdir(), "piora-provider-order-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const modelsPath = join(root, "models.json"), authPath = join(root, "auth.json");
    const config = { providers: Object.fromEntries(["a", "b"].map(provider => [provider, { baseUrl: "https://unused.invalid/v1", api: "openai-completions", apiKey: "fixture", models: ["second", "first"].map(id => ({ id, name: id, contextWindow: 10000, maxTokens: 100 })) }])) };
    writeFileSync(modelsPath, JSON.stringify(config));
    let runtime = await ModelRuntime.create({ authPath, modelsPath, modelsStorePath: join(root, "catalog.json"), refreshOnCreate: false });
    const settings = { getEnabledModels: () => ["a/first", "b/first", "a/second", "b/second"], getDefaultProvider: () => "a", getDefaultModel: () => "first" };
    let invalidations = 0;
    const orderApi = loadRoute("../app/api/models/provider-order/route.ts", {
      "@/lib/provider-order-store": store,
      "@/lib/models-cache": { invalidateModelsCache: () => { invalidations++; cache.invalidateModelsCache(); } },
    });
    const catalogue = loadRoute("../app/api/models/route.ts", {
      "@/lib/default-model-store": defaultStore,
      "@earendil-works/pi-ai": { getSupportedThinkingLevels: () => ["off"] },
      "@/lib/models-cache": cache, "@/lib/model-scope": scopeHelpers, "@/lib/model-policy": policy,
      "@/lib/model-runtime-context": { createTrustedModelServices: async () => ({ modelRuntime: runtime, settingsManager: settings }), ModelRequestCwdError: class extends Error {}, resolveModelRequestCwd: async () => root },
    });
    const getModels = async () => (await catalogue.GET(new Request("http://localhost/api/models"))).json();
    assert.deepEqual(store.readProviderOrder(), []);
    const original = await getModels();
    assert.equal(original.modelError, undefined);
    assert.deepEqual(original.defaultModel, { provider: "a", modelId: "second" }, "first configured model wins over old default and enabledModels pattern order");
    assert.equal((await orderApi.PUT(new Request("http://localhost", { method: "PUT", body: JSON.stringify({ providers: ["b", "a", "b"] }) }))).status, 200);
    assert.equal(invalidations, 1);
    assert.deepEqual((await (await orderApi.GET()).json()).providers, ["b", "a"]);
    let data = await getModels();
    assert.deepEqual(data.modelList.map(m => `${m.provider}/${m.id}`), ["b/second", "b/first", "a/second", "a/first"]);
    assert.deepEqual(data.defaultModel, { provider: "b", modelId: "second" });
    const scope = await scopeHelpers.resolveVisibleModels(runtime, settings.getEnabledModels(), []);
    const initial = scopeHelpers.selectInitialModelScope(scope, { defaultModel: policy.resolveDefaultModelPreference({ models: scope.visible, environment: {} }) });
    assert.equal(initial.model.provider, "b"); assert.equal(initial.model.id, "second");
    assert.equal(scopeHelpers.selectInitialModelScope(scope, { requestedModel: { provider: "a", modelId: "first" } }).model.id, "first", "explicit session selection is preserved");
    const state = await buildModelScopeSettingsState({ runtime, enabledPatterns: settings.getEnabledModels(), removedProviders: [] });
    assert.deepEqual(state.effectiveDefault, data.defaultModel);
    config.providers.b.models.reverse(); writeFileSync(modelsPath, JSON.stringify(config));
    runtime = await ModelRuntime.create({ authPath, modelsPath, modelsStorePath: join(root, "catalog.json"), refreshOnCreate: false }); cache.invalidateModelsCache();
    data = await getModels();
    assert.deepEqual(data.defaultModel, { provider: "b", modelId: "first" }, "channel-internal reordering changes the new-chat default");
    assert.equal((await orderApi.PUT(new Request("http://localhost", { method: "PUT", body: '{"providers":[1]}' }))).status, 400);
    assert.deepEqual(store.readProviderOrder(), ["b", "a"]);
    writeFileSync(join(root, "piora", "provider-order.json"), "{broken");
    assert.equal((await orderApi.GET()).status, 500);
    assert.throws(() => store.readProviderOrder(), /无法读取/);
  } finally {
    cache.invalidateModelsCache();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
