import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { writePrivateFileAtomicSync } = await jiti.import("./atomic-file.ts");
const { setProviderRemoved } = await jiti.import("./removed-providers.ts");
const { normalizeModelConfigCosts } = await jiti.import("./model-config-cost.ts");
const { stripJsonComments } = await jiti.import("./mcp-capabilities.ts");
const { validateModelSamplingConfig } = await jiti.import("./model-sampling.ts");
const { validateCustomModelLimits, stripModelLimitUiMeta, omitUnchangedIncompleteModels } = await jiti.import("./model-limits.ts");
const source = fs.readFileSync("app/api/models-config/route.ts", "utf8");
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

function loadRoute(directory) {
  const modules = {
    "@/lib/removed-providers": { setProviderRemoved: (id, removed) => setProviderRemoved(id, removed, directory) },
    "next/server": { NextResponse: Response },
    fs,
    path,
    "@earendil-works/pi-coding-agent": { getAgentDir: () => directory },
    "@/lib/atomic-file": { writePrivateFileAtomicSync },
    "@/lib/models-cache": { invalidateModelsCache() {} },
    "@/lib/rpc-manager": { invalidateServicesCache() {} },
    "@/lib/model-config-cost": { normalizeModelConfigCosts },
    "@/lib/model-sampling": { validateModelSamplingConfig },
    "@/lib/model-limits": { validateCustomModelLimits, stripModelLimitUiMeta, omitUnchangedIncompleteModels },
    "@/lib/mcp-capabilities": { stripJsonComments },
  };
  const exports = {};
  new Function("require", "exports", js)((id) => {
    assert.ok(id in modules, id);
    return modules[id];
  }, exports);
  return exports;
}

const validModel = { id: "ready", contextWindow: 32000, maxTokens: 8192 };

test("unchanged legacy models survive unrelated saves while new or edited models require valid limits", async () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "piora-model-limits-route-"));
  const filename = path.join(directory, "models.json");
  const route = loadRoute(directory);
  const save = (body) => route.PUT(new Request("http://localhost/api/models-config", { method: "PUT", body: JSON.stringify(body) }));
  const legacy = { providers: { custom: { api: "openai-completions", baseUrl: "https://example.invalid/v1", apiKey: "fixture", models: [{ id: "legacy", name: "Legacy", cost: { input: 1 }, compat: { supportsStore: false }, samplingParams: { temperature: -1 } }], modelOverrides: { builtin: { name: "Built-in" } } } } };
  try {
    fs.writeFileSync(filename, JSON.stringify(legacy));
    const before = fs.readFileSync(filename, "utf8");
    const loaded = await route.GET();
    assert.equal(loaded.status, 200);
    const listed = await loaded.json();
    assert.equal(listed.providers.custom.models[0].contextWindow, undefined);
    assert.equal(listed.providers.custom.models[0].maxTokens, undefined);
    assert.equal(fs.readFileSync(filename, "utf8"), before);
    assert.equal(before.includes("128000"), false);

    const extended = structuredClone(legacy);
    extended.providers.other = { models: [validModel] };
    assert.equal((await save(extended)).status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(filename, "utf8")).providers.custom, legacy.providers.custom);
    const renamed = structuredClone(extended);
    renamed.providers.renamed = renamed.providers.custom;
    delete renamed.providers.custom;
    assert.equal((await save(renamed)).status, 200, "renaming a provider preserves unchanged legacy models");
    assert.equal((await save(extended)).status, 200);
    const current = fs.readFileSync(filename, "utf8");
    const editedLegacy = structuredClone(extended);
    editedLegacy.providers.custom.models[0].name = "Edited";
    delete editedLegacy.providers.custom.models[0].samplingParams;
    const rejected = await save(editedLegacy);
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /custom\/legacy: contextWindow is required/);
    assert.equal(fs.readFileSync(filename, "utf8"), current);

    const illegal = [
      [{ id: "m", contextWindow: 0, maxTokens: 1 }, /contextWindow must be a positive integer/],
      [{ id: "m", contextWindow: 10, maxTokens: -3 }, /maxTokens must be a positive integer/],
      [{ id: "m", contextWindow: 10.5, maxTokens: 1 }, /contextWindow must be a positive integer/],
      [{ id: "m", contextWindow: "10", maxTokens: 1 }, /contextWindow must be a positive integer/],
      [{ id: "m", contextWindow: 10 }, /maxTokens is required/],
      [{ id: "m", contextWindow: 10, maxTokens: 11 }, /maxTokens must be less than contextWindow/],
      [{ id: "m", contextWindow: 300000, maxTokens: 300000 }, /maxTokens must be less than contextWindow \(300000\)/],
    ];
    for (const [model, pattern] of illegal) {
      const response = await save({ providers: { custom: { models: [model] } } });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, pattern);
      assert.equal(fs.readFileSync(filename, "utf8"), current);
    }

    const accepted = { providers: { custom: { models: [validModel, { ...validModel, id: "below", contextWindow: 100, maxTokens: 99 }], modelOverrides: { builtin: {} } }, other: { models: [] } } };
    assert.equal((await save(accepted)).status, 200);
    const saved = JSON.parse(fs.readFileSync(filename, "utf8"));
    assert.equal(saved.providers.custom.models[0].contextWindow, 32000);
    assert.equal(saved.providers.custom.models[0].maxTokens, 8192);
    assert.equal(saved.providers.custom.models[1].maxTokens, 99);

    const tagged = { providers: { custom: { models: [{ ...validModel, limitsMeta: { contextWindow: "endpoint", unavailable: { maxTokens: true } } }] } } };
    assert.equal((await save(tagged)).status, 200);
    const stripped = fs.readFileSync(filename, "utf8");
    assert.equal(stripped.includes("limitsMeta"), false);
    assert.equal(JSON.parse(stripped).providers.custom.models[0].contextWindow, 32000);

    assert.equal((await route.DELETE(new Request("http://localhost/api/models-config", { method: "DELETE", body: JSON.stringify({ provider: "custom", id: "ready" }) }))).status, 200);
    fs.writeFileSync(filename, JSON.stringify(legacy));
    assert.equal((await route.DELETE(new Request("http://localhost/api/models-config", { method: "DELETE", body: JSON.stringify({ provider: "custom", id: "legacy" }) }))).status, 200);
    assert.equal(JSON.parse(fs.readFileSync(filename, "utf8")).providers.custom.models, undefined);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("unchanged equal-budget models survive other provider saves without allowing new or edited equal budgets", async () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "piora-equal-budget-route-"));
  const filename = path.join(directory, "models.json");
  const route = loadRoute(directory);
  const save = body => route.PUT(new Request("http://localhost/api/models-config", { method: "PUT", body: JSON.stringify(body) }));
  const model = { id: "equal", contextWindow: 300000, maxTokens: 300000, cost: { input: 1 }, compat: { supportsStore: false } };
  const previous = { providers: { legacy: { baseUrl: "https://legacy.test/v1", models: [model] } } };
  try {
    fs.writeFileSync(filename, JSON.stringify(previous));
    const next = { providers: { ...previous.providers, other: { models: [validModel] } } };
    assert.equal((await save(next)).status, 200, "adding a valid provider preserves the old model");
    assert.deepEqual(JSON.parse(fs.readFileSync(filename, "utf8")).providers.legacy.models[0], model, "even partial cost metadata is preserved");
    next.providers.other.baseUrl = "https://changed.test/v1";
    assert.equal((await save(next)).status, 200, "other connection edits still save");
    const before = fs.readFileSync(filename, "utf8");
    for (const edit of [
      config => { config.providers.legacy.models[0].name = "edited"; },
      config => { config.providers.legacy.models[0].maxTokens++; },
      config => { config.providers.other.models.push({ ...model, id: "new-equal" }); },
      config => { config.providers.other.models.push({ ...model }); },
    ]) {
      const invalid = structuredClone(next); edit(invalid);
      assert.equal((await save(invalid)).status, 400);
      assert.equal(fs.readFileSync(filename, "utf8"), before);
    }
    next.providers.legacy.models[0] = { ...model, maxTokens: 65536 };
    assert.equal((await save(next)).status, 200, "the old model can be corrected explicitly");
    assert.equal(JSON.parse(fs.readFileSync(filename, "utf8")).providers.legacy.models[0].maxTokens, 65536);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
