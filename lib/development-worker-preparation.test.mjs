import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { prepareDevelopmentWorker } from "../scripts/prepare-development.mjs";

test("incremental dev preparation reuses, updates and repairs worker entry points", async t => {
  const parent = resolve(import.meta.dirname, "../.verification");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, "dev-worker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = resolve(root, "lib/harmony/runtime");
  await mkdir(source, { recursive: true });
  await writeFile(resolve(root, "package.json"), '{"private":true}');
  await writeFile(resolve(root, "tsconfig.harmony-worker.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "Node16", rootDir: "lib", outDir: ".harmony-worker", types: [], noEmitOnError: true },
    include: ["lib/harmony/runtime/worker-entry.ts", "lib/harmony/runtime/device-lock.ts"],
  }));
  const lock = resolve(source, "device-lock.ts");
  await writeFile(lock, "export const generation = 1;");
  await writeFile(resolve(source, "worker-entry.ts"), 'export { generation } from "./device-lock.js";');
  await prepareDevelopmentWorker(root);
  const output = resolve(root, ".harmony-worker/harmony/runtime/device-lock.js");
  const before = (await stat(output)).mtimeMs;
  await prepareDevelopmentWorker(root);
  assert.equal((await stat(output)).mtimeMs, before, "unchanged workers must not be rewritten");
  await writeFile(lock, "export const generation = 2;");
  await prepareDevelopmentWorker(root);
  assert.match(await readFile(output, "utf8"), /generation = 2/);
  await rm(output);
  await prepareDevelopmentWorker(root);
  assert.match(await readFile(output, "utf8"), /generation = 2/, "missing emits must be repaired despite a warm incremental cache");
  await writeFile(lock, "export const broken: number = 'type error';");
  await assert.rejects(prepareDevelopmentWorker(root), /Harmony worker preparation failed/);
});
