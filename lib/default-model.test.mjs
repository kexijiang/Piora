import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import ts from "typescript";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url);
const store = await jiti.import("./default-model-store.ts");
const scopeHelpers = await jiti.import("./model-scope.ts");
const settingsHelpers = await jiti.import("./model-scope-settings.ts");
const policy = await jiti.import("./model-policy.ts");
const cache = await jiti.import("./models-cache.ts");
const orderStore = await jiti.import("./provider-order-store.ts");

function loadRoute(file, modules) {
  const js = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const api = {};
  new Function("require", "exports", js)(id => { assert.ok(modules[id], id); return modules[id]; }, api);
  return api;
}

test("explicit default storage validates, survives reload and reports corrupt/write failures", () => {
  const root = mkdtempSync(join(tmpdir(), "piora-default-store-"));
  try {
    assert.equal(store.readDefaultModel(root), null);
    assert.deepEqual(store.writeDefaultModel({ provider: " a ", modelId: " b " }, root), { provider: "a", modelId: "b" });
    assert.deepEqual(store.readDefaultModel(root), { provider: "a", modelId: "b" });
    for (const value of [null, {}, { provider: "a", modelId: " " }, { provider: 1, modelId: "b" }]) assert.throws(() => store.writeDefaultModel(value, root), /Invalid/);
    assert.deepEqual(store.readDefaultModel(root), { provider: "a", modelId: "b" });
    writeFileSync(join(root, "piora", "default-model.json"), "{broken");
    assert.throws(() => store.readDefaultModel(root), /无法读取默认模型/);
    writeFileSync(join(root, "blocked"), "file");
    assert.throws(() => store.writeDefaultModel({ provider: "a", modelId: "b" }, join(root, "blocked")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("scope action, catalogue and SDK startup agree across persistence, ordering and visibility", async () => {
  const root = mkdtempSync(join(tmpdir(), "piora-default-api-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const config = { providers: Object.fromEntries(["a", "b"].map(provider => [provider, { baseUrl: "https://unused.invalid/v1", api: "openai-completions", apiKey: "fixture", models: ["first", "second"].map(id => ({ id, name: `${provider} ${id}`, contextWindow: 10000, maxTokens: 100 })) }])) };
    const modelsPath = join(root, "models.json");
    writeFileSync(modelsPath, JSON.stringify(config));
    let runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath, modelsStorePath: join(root, "catalog.json"), refreshOnCreate: false });
    let patterns;
    let removed = [];
    let writeFails = false;
    const settings = { getEnabledModels: () => patterns, getDefaultProvider: () => "b", getDefaultModel: () => "first", getProjectSettings: () => ({}), drainErrors: () => [] };
    let invalidations = 0;
    const invalidateModelsCache = () => { invalidations++; cache.invalidateModelsCache(); };
    const getServices = async () => ({ modelRuntime: runtime, settingsManager: settings });
    const context = { createTrustedModelServices: getServices, ModelRequestCwdError: class extends Error {}, resolveModelRequestCwd: async () => root };
    const scopeApi = loadRoute("../app/api/models/scope/route.ts", {
      "@/lib/global-model-services": { createGlobalModelServices: getServices },
      "@/lib/models-cache": { invalidateModelsCache },
      "@/lib/default-model-store": { writeDefaultModel: value => { if (writeFails) throw new Error("disk unavailable"); return store.writeDefaultModel(value); } },
      "@/lib/model-runtime-context": context,
      "@/lib/removed-providers": {},
      "@/lib/model-scope-settings": { ...settingsHelpers, buildModelScopeSettingsState: options => settingsHelpers.buildModelScopeSettingsState({ ...options, removedProviders: removed }) },
    });
    const catalogue = loadRoute("../app/api/models/route.ts", {
      "@earendil-works/pi-ai": { getSupportedThinkingLevels: () => ["off"] },
      "@/lib/models-cache": cache,
      "@/lib/model-scope": { ...scopeHelpers, resolveVisibleModels: (runtime, patterns) => scopeHelpers.resolveVisibleModels(runtime, patterns, removed) },
      "@/lib/model-policy": policy,
      "@/lib/default-model-store": store,
      "@/lib/model-runtime-context": context,
    });
    const getModels = async () => (await catalogue.GET(new Request("http://localhost/api/models"))).json();
    const choose = (provider, id) => scopeApi.PATCH(new Request("http://localhost/api/models/scope", { method: "PATCH", body: JSON.stringify({ scope: "global", action: "set-default", provider, id }) }));
    assert.deepEqual((await getModels()).defaultModel, { provider: "a", modelId: "first" }, "legacy SDK defaults stay ignored");
    let response = await choose("b", "second");
    assert.equal(response.status, 200);
    let state = await response.json();
    assert.deepEqual(state.configuredDefault, { provider: "b", modelId: "second" });
    assert.deepEqual(state.effectiveDefault, state.configuredDefault);
    assert.equal(invalidations, 1);
    let data = await getModels();
    assert.deepEqual(data.defaultModel, state.configuredDefault);
    assert.deepEqual(data.modelList.filter(model => model.isDefault).map(model => `${model.provider}/${model.id}`), ["b/second"]);
    assert.equal(data.modelList[0].provider, "a", "setting a default must not reorder the catalogue");
    orderStore.writeProviderOrder(["b", "a"]);
    config.providers.b.models.reverse();
    writeFileSync(modelsPath, JSON.stringify(config));
    runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath, modelsStorePath: join(root, "catalog.json"), refreshOnCreate: false });
    cache.invalidateModelsCache();
    assert.deepEqual((await getModels()).defaultModel, { provider: "b", modelId: "second" });
    const scope = await scopeHelpers.resolveVisibleModels(runtime, undefined, []);
    const defaultModel = policy.resolveDefaultModelPreference({ models: scope.visible, explicitDefault: store.readDefaultModel(), environment: {} });
    assert.equal(scopeHelpers.selectInitialModelScope(scope, { defaultModel }).model.id, "second");
    assert.equal(scopeHelpers.selectInitialModelScope(scope, { defaultModel, requestedModel: { provider: "a", modelId: "first" } }).model.provider, "a", "per-session selection wins");
    writeFails = true;
    assert.equal((await choose("a", "first")).status, 500);
    assert.deepEqual(store.readDefaultModel(), { provider: "b", modelId: "second" });
    assert.equal(invalidations, 1, "failed persistence must not report/invalidate a new default");
    writeFails = false;
    patterns = ["a/*"];
    assert.equal((await choose("b", "second")).status, 409, "hidden models cannot become the default");
    assert.equal((await choose("missing", "second")).status, 404);
    cache.invalidateModelsCache();
    data = await getModels();
    assert.deepEqual(data.defaultModel, { provider: "a", modelId: "first" });
    assert.ok(data.modelList.every(model => model.provider === "a"));
    patterns = undefined;
    removed = ["b"];
    cache.invalidateModelsCache();
    assert.deepEqual((await getModels()).defaultModel, { provider: "a", modelId: "first" });
    removed = [];
    delete config.providers.b;
    writeFileSync(modelsPath, JSON.stringify(config));
    runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath, modelsStorePath: join(root, "catalog.json"), refreshOnCreate: false });
    cache.invalidateModelsCache();
    assert.deepEqual((await getModels()).defaultModel, { provider: "a", modelId: "first" }, "deleted/unavailable defaults fall back");
    state = await (await scopeApi.GET(new Request("http://localhost/api/models/scope?scope=global"))).json();
    assert.deepEqual(state.effectiveDefault, { provider: "a", modelId: "first" });
  } finally {
    cache.invalidateModelsCache();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
