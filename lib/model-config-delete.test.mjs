import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import ts from "typescript";
import { createJiti } from "jiti";
const { writePrivateFileAtomicSync } = await createJiti(import.meta.url).import("./atomic-file.ts");
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
    assert.equal((await remove({ provider: "other" })).status, 500);
    assert.equal(fs.readFileSync(filename, "utf8"), "{ broken");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
