import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import ts from "typescript";
const jiti = createJiti(import.meta.url);
const store = await jiti.import("./removed-providers.ts");
const { resolveVisibleModels, selectInitialModelScope } = await jiti.import("./model-scope.ts");
const { availableFallbackModels } = await jiti.import("./model-fallback.ts");
const settingsHelpers = await jiti.import("./model-scope-settings.ts");
const models = [{ provider: "anthropic", id: "claude", name: "Claude" }, { provider: "deepseek", id: "chat", name: "DeepSeek" }];
const runtime = { getAvailable: async () => models };

test("provider removal persists independently of credentials and catalog availability", () => {
  const root = mkdtempSync(join(tmpdir(), "piora-removed-provider-"));
  try {
    writeFileSync(join(root, "auth.json"), '{"anthropic":{"type":"api_key","key":"fixture"}}');
    const before = readFileSync(join(root, "auth.json"), "utf8");
    assert.deepEqual(store.readRemovedProviders(root), []);
    assert.equal(store.setProviderRemoved("anthropic", true, root), true);
    assert.equal(store.setProviderRemoved("anthropic", true, root), false);
    assert.deepEqual(store.readRemovedProviders(root), ["anthropic"]);
    assert.equal(readFileSync(join(root, "auth.json"), "utf8"), before);
    assert.equal(store.setProviderRemoved("anthropic", false, root), true);
    assert.deepEqual(store.readRemovedProviders(root), []);
    store.setProviderRemoved("anthropic", true, root);
    writeFileSync(join(root, "piora", "removed-providers.json"), "{broken");
    assert.throws(() => store.readRemovedProviders(root), /无法读取/);
    assert.throws(() => store.setProviderRemoved("other", true, root), /无法读取/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("removed providers never return via empty or stale SDK scopes, pins, or new catalog models", async () => {
  for (const patterns of [undefined, ["stale/*"], ["*/*:high"]]) {
    const scope = await resolveVisibleModels(runtime, patterns, ["anthropic"]);
    assert.deepEqual(scope.visible.map(m => m.provider), ["deepseek"]);
    assert.deepEqual(scope.scopedModels.map(m => m.model.provider), ["deepseek"]);
    assert.ok(Object.keys(scope.thinkingLevelPins).every(id => id.startsWith("deepseek/")));
  }
  const expanded = { getAvailable: async () => [...models, { provider: "anthropic", id: "new-claude" }] };
  assert.equal((await resolveVisibleModels(expanded, undefined, ["anthropic"])).visible.length, 1);
  const empty = await resolveVisibleModels({ getAvailable: async () => [models[0]] }, undefined, ["anthropic"]);
  assert.deepEqual(empty.visible, []);
  assert.throws(() => selectInitialModelScope(empty), /没有可用渠道/);
  const state = await settingsHelpers.buildModelScopeSettingsState({ runtime, enabledPatterns: undefined, removedProviders: ["anthropic"], defaultProvider: "anthropic", defaultModel: "claude" });
  assert.equal(state.models.find(m => m.provider === "anthropic").enabled, false);
  assert.deepEqual(state.effectiveDefault, { provider: "deepseek", modelId: "chat" });
});

test("scope API removes the last channel, restores offline channels and reports persistence failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "piora-remove-api-"));
  try {
    let available = [models[0]], invalidations = 0;
    const services = { modelRuntime: { getAvailable: async () => available, getError: () => undefined }, settingsManager: { drainErrors: () => [], getEnabledModels: () => undefined, getDefaultProvider: () => "anthropic", getDefaultModel: () => "claude", getProjectSettings: () => ({}) } };
    const modules = {
      "@/lib/default-model-store": { writeDefaultModel: () => assert.fail("visibility changes must not replace the default") },
      "@/lib/global-model-services": { createGlobalModelServices: async () => services },
      "@/lib/models-cache": { invalidateModelsCache: () => invalidations++ },
      "@/lib/model-runtime-context": { ModelRequestCwdError: class extends Error {}, resolveModelRequestCwd: async () => null },
      "@/lib/removed-providers": { setProviderRemoved: (id, value) => store.setProviderRemoved(id, value, root), restoreRemovedProviders: () => store.restoreRemovedProviders(root) },
      "@/lib/model-scope-settings": { ...settingsHelpers, buildModelScopeSettingsState: options => settingsHelpers.buildModelScopeSettingsState({ ...options, removedProviders: store.readRemovedProviders(root) }) },
    };
    const source = readFileSync(new URL("../app/api/models/scope/route.ts", import.meta.url), "utf8");
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const api = {};
    new Function("require", "exports", js)(id => { assert.ok(modules[id], id); return modules[id]; }, api);
    const change = action => api.PATCH(new Request("http://localhost/api/models/scope", { method: "PATCH", body: JSON.stringify({ scope: "global", provider: "anthropic", action }) }));
    let response = await change("remove-provider");
    assert.equal(response.status, 200);
    let body = await response.json();
    assert.equal(body.enabledCount, 0);
    assert.deepEqual(body.removedProviders, ["anthropic"]);
    available = [];
    body = await (await api.GET(new Request("http://localhost/api/models/scope?scope=global"))).json();
    assert.deepEqual(body.removedProviders, ["anthropic"], "offline catalog does not lose the exclusion");
    assert.equal((await change("restore-removed-provider")).status, 200);
    assert.deepEqual(store.readRemovedProviders(root), []);
    available = [models[0]];
    assert.equal((await (await api.GET(new Request("http://localhost/api/models/scope?scope=global"))).json()).enabledCount, 1);
    assert.equal(invalidations, 2);
    writeFileSync(join(root, "piora", "removed-providers.json"), "{bad");
    assert.equal((await change("remove-provider")).status, 500);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fallback still rejects stale scopes when a provider exclusion creates a nonempty SDK cycle", async () => {
  const root = mkdtempSync(join(tmpdir(), "piora-removed-fallback-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    store.setProviderRemoved("anthropic", true);
    assert.deepEqual(await availableFallbackModels(runtime, ["missing/*"]), []);
    assert.deepEqual((await availableFallbackModels(runtime)).map(model => model.provider), ["deepseek"]);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
