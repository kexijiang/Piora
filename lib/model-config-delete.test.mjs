import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import ts from "typescript";
import { createJiti } from "jiti";
const { writePrivateFileAtomicSync } = await createJiti(import.meta.url).import("./atomic-file.ts");
const { normalizeModelConfigCosts } = await createJiti(import.meta.url).import("./model-config-cost.ts");
const { stripJsonComments } = await createJiti(import.meta.url).import("./mcp-capabilities.ts");
const { validateModelSamplingConfig } = await createJiti(import.meta.url).import("./model-sampling.ts");
const { validateCustomModelLimits, stripModelLimitUiMeta } = await createJiti(import.meta.url).import("./model-limits.ts");
const source = fs.readFileSync("app/api/models-config/route.ts", "utf8");
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

test("deletions are durable, targeted, idempotent and verified before success", async () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "piora-model-delete-"));
  const filename = path.join(directory, "models.json");
  const other = { api: "openai-completions", headers: { "x-test": "keep" }, models: [{ id: "keep" }] };
  let mode = "write", invalidations = 0;
  const modules = {
    "next/server": { NextResponse: Response }, fs, path,
    "@earendil-works/pi-coding-agent": { getAgentDir: () => directory },
    "@/lib/atomic-file": { writePrivateFileAtomicSync: (...args) => {
      if (mode === "fail") throw new Error("ENOSPC");
      if (mode === "write") writePrivateFileAtomicSync(...args);
    } },
    "@/lib/models-cache": { invalidateModelsCache: () => invalidations++ },
    "@/lib/rpc-manager": { invalidateServicesCache: () => invalidations++ },
    "@/lib/model-config-cost": { normalizeModelConfigCosts },
    "@/lib/model-sampling": { validateModelSamplingConfig },
    "@/lib/model-limits": { validateCustomModelLimits, stripModelLimitUiMeta },
    "@/lib/mcp-capabilities": { stripJsonComments },
  };
  const exports = {};
  new Function("require", "exports", js)(id => { assert.ok(id in modules, id); return modules[id]; }, exports);
  const remove = body => exports.DELETE(new Request("http://localhost/api/models-config", { method: "DELETE", body: JSON.stringify(body) }));
  try {
    fs.writeFileSync(filename, JSON.stringify({ extra: { preserved: true }, providers: { primary: { models: [{ id: "remove" }, { id: "keep" }], apiKey: "fixture" }, other } }));
    assert.equal((await remove({ provider: "primary", id: "remove" })).status, 200);
    const saved = JSON.parse(fs.readFileSync(filename, "utf8"));
    assert.deepEqual(saved.providers.primary.models, [{ id: "keep" }]);
    assert.deepEqual(saved.providers.other, other);
    assert.deepEqual(saved.extra, { preserved: true });
    assert.equal(invalidations, 2);
    assert.equal((await remove({ provider: "primary", id: "remove" })).status, 200);
    mode = "fail";
    assert.equal((await remove({ provider: "primary" })).status, 500);
    assert.ok(JSON.parse(fs.readFileSync(filename, "utf8")).providers.primary);
    mode = "noop";
    assert.equal((await remove({ provider: "primary" })).status, 500, "readback detects a write that never reached disk");
    mode = "write";
    assert.equal((await remove({ provider: "primary" })).status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(filename, "utf8")).providers, { other });
    assert.equal((await remove({ provider: "primary" })).status, 200);
    assert.equal((await remove({ provider: "" })).status, 400);
    fs.writeFileSync(filename, "{ broken");
    assert.equal((await exports.GET()).status, 422);
    assert.equal((await remove({ provider: "other" })).status, 500);
    assert.equal(fs.readFileSync(filename, "utf8"), "{ broken");
    for (const malformed of ["null", "[]", '{"providers":[]}', '{"providers":{"test":{"models":[{}]}}}']) {
      fs.writeFileSync(filename, malformed);
      assert.equal((await exports.GET()).status, 422);
      assert.equal(fs.readFileSync(filename, "utf8"), malformed);
    }
    fs.writeFileSync(filename, '\uFEFF{ // SDK-compatible JSON comments\n "providers": {} }');
    assert.equal((await exports.GET()).status, 200);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("saving partial prices produces an SDK-valid file and rejects invalid prices before writing", async () => {
  const { ModelConfig } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/model-config.js");
  const directory = fs.mkdtempSync(path.join(tmpdir(), "piora-model-save-"));
  const filename = path.join(directory, "models.json");
  let invalidations = 0;
  const modules = {
    "next/server": { NextResponse: Response }, fs, path,
    "@earendil-works/pi-coding-agent": { getAgentDir: () => directory },
    "@/lib/atomic-file": { writePrivateFileAtomicSync },
    "@/lib/models-cache": { invalidateModelsCache: () => invalidations++ },
    "@/lib/rpc-manager": { invalidateServicesCache: () => invalidations++ },
    "@/lib/model-config-cost": { normalizeModelConfigCosts },
    "@/lib/model-sampling": { validateModelSamplingConfig },
    "@/lib/model-limits": { validateCustomModelLimits, stripModelLimitUiMeta },
    "@/lib/mcp-capabilities": { stripJsonComments },
  };
  const exports = {};
  new Function("require", "exports", js)(id => { assert.ok(id in modules, id); return modules[id]; }, exports);
  const save = body => exports.PUT(new Request("http://localhost/api/models-config", { method: "PUT", body: JSON.stringify(body) }));
  const config = { providers: { deepseek: {
    api: "openai-completions", baseUrl: "https://example.com/v1", apiKey: "fixture",
    unknownProviderField: { retained: true },
    models: [{ id: "deepseek-flash", contextWindow: 32000, maxTokens: 8192, unknownModelField: [1, 2], samplingParams: { temperature: 0.4, vendor_custom: { enabled: true } }, samplingParamsByThinkingLevel: { high: { top_p: 0.8, vendor_custom: null } }, cost: { input: 2, output: 9, cacheRead: 0 } }, { id: "no-price", contextWindow: 32000, maxTokens: 8192 }],
    modelOverrides: { builtin: { cost: { input: 1 } } },
  } } };
  try {
    fs.writeFileSync(filename, JSON.stringify(config));
    assert.match((await ModelConfig.load(filename)).getError(), /cacheWrite/);
    assert.equal((await save(config)).status, 200);
    assert.equal((await ModelConfig.load(filename)).getError(), undefined);
    const savedText = fs.readFileSync(filename, "utf8");
    const saved = JSON.parse(savedText);
    assert.deepEqual(saved.providers.deepseek.models[0].cost, { input: 2, output: 9, cacheRead: 0, cacheWrite: 0 });
    assert.equal(saved.providers.deepseek.models[1].cost, undefined);
    assert.deepEqual(saved.providers.deepseek.modelOverrides, config.providers.deepseek.modelOverrides);
    assert.deepEqual(saved.providers.deepseek.models[0].samplingParams, config.providers.deepseek.models[0].samplingParams);
    assert.deepEqual(saved.providers.deepseek.models[0].samplingParamsByThinkingLevel, config.providers.deepseek.models[0].samplingParamsByThinkingLevel);
    assert.deepEqual(saved.providers.deepseek.models[0].unknownModelField, [1, 2]);
    const reopened = await (await exports.GET()).json();
    reopened.providers.deepseek.models[0].name = "Renamed";
    assert.equal((await save(reopened)).status, 200);
    assert.deepEqual((await (await exports.GET()).json()).providers.deepseek.models[0].samplingParams, saved.providers.deepseek.models[0].samplingParams);
    for (const invalid of ["{", [], null, { temperature: -1 }, { top_p: "oops" }]) {
      const draft = structuredClone(config); draft.providers.deepseek.models[0].samplingParams = invalid;
      assert.equal((await save(draft)).status, 400);
    }
    fs.writeFileSync(filename, savedText);
    assert.equal(config.providers.deepseek.models[0].cost.cacheWrite, undefined, "normalization must not mutate the caller's draft");
    config.providers.deepseek.models[0].cost.input = "bad";
    assert.equal((await save(config)).status, 400);
    assert.equal((await save(null)).status, 400);
    assert.equal(fs.readFileSync(filename, "utf8"), savedText);
    assert.equal(invalidations, 4);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
