import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dependencyCacheKey } from "../scripts/ci-dependency-cache.mjs";
import { load } from "js-yaml";

test("installed cache separates lockfiles, install patches, host ABI, runner images and checkout locations", async t => {
  const root = await mkdtemp(join(tmpdir(), "piora-ci-install-key-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "desktop")); await mkdir(join(root, "scripts"));
  for (const name of ["package.json", "package-lock.json", "desktop/package.json"]) await writeFile(join(root, name), "{}");
  const runtime = { platform: "win32", arch: "x64", version: "v22.19.0", versions: { modules: "127" }, env: { ImageVersion: "one" } };
  const baseline = await dependencyCacheKey(root, runtime);
  for (const changed of [{ ...runtime, arch: "arm64" }, { ...runtime, version: "v24.0.0" }, { ...runtime, versions: { modules: "137" } }, { ...runtime, env: { ImageVersion: "two" } }]) {
    assert.notEqual(await dependencyCacheKey(root, changed), baseline);
  }
  await writeFile(join(root, "scripts/patch-bundled-dependencies.mjs"), "export const patch = 1;");
  const patched = await dependencyCacheKey(root, runtime); assert.notEqual(patched, baseline);
  await writeFile(join(root, "package-lock.json"), '{"lockfileVersion":3}');
  assert.notEqual(await dependencyCacheKey(root, runtime), patched);
  const second = `${root}-relocated`;
  t.after(() => rm(second, { recursive: true, force: true }));
  await cp(root, second, { recursive: true });
  assert.notEqual(await dependencyCacheKey(root, runtime), await dependencyCacheKey(second, runtime));
});

test("installer benchmark builds both commits and retains real installation, metadata and runtime verification", async () => {
  const workflow = load(await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  const job = workflow.jobs["installer-benchmark"];
  assert.match(job.if, /workflow_dispatch.*inputs.packaging_benchmark/);
  assert.deepEqual(job.strategy.matrix.variant, ["before", "after"]);
  assert.equal(job.strategy["fail-fast"], false);
  assert.equal(job.permissions.contents, "read");
  assert.ok(job.steps.some(step => step.run === "npm run dist:win:preview"));
  assert.ok(job.steps.some(step => step.run?.includes("verify-windows-update-artifacts.mjs")));
  assert.ok(job.steps.some(step => step.run === "node scripts/verify-preview-artifacts.mjs" && !step.if));
  assert.ok(!job.steps.some(step => /gh release|git push/.test(step.run ?? "")));
});
