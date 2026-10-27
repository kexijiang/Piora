import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { collectNodeModulesWithLogging, collectionMatchesAppDependencies, resolveFirstMatchingCollection } = require("app-builder-lib/out/util/appFileCopier.js");
const { getCollectorByPackageManager, PM } = require("app-builder-lib/out/node-module-collector/index.js");
const { TmpDir } = require("temp-file");

async function writePackage(directory, manifest) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ version: "1.0.0", main: "index.js", ...manifest }));
  await writeFile(join(directory, "index.js"), "module.exports = {};\n");
}

async function workspace(t, overlap = true) {
  const root = await mkdtemp(join(tmpdir(), "piora-builder-workspace-"));
  const appDir = join(root, "desktop");
  const tempDirManager = new TmpDir();
  t.after(async () => { await tempDirManager.cleanup(); await rm(root, { recursive: true, force: true }); });
  const dependencies = { "electron-updater": "1.0.0", koffi: "1.0.0" };
  await writePackage(root, {
    name: "web-root", private: true, workspaces: ["desktop"],
    dependencies: { "web-only": "1.0.0", ...(overlap ? { koffi: "1.0.0" } : {}) },
  });
  await writePackage(appDir, { name: "@piora/desktop", dependencies, devDependencies: { "dev-only": "1.0.0" } });
  for (const [name, manifest] of Object.entries({
    "electron-updater": { dependencies: { "updater-leaf": "1.0.0" }, optionalDependencies: { "optional-leaf": "1.0.0", "not-installed": "1.0.0" } },
    koffi: {}, "updater-leaf": {}, "optional-leaf": {}, "web-only": {}, "dev-only": {},
  })) await writePackage(join(root, "node_modules", name), { name, ...manifest });
  const collect = (pm, dir, packageName = "@piora/desktop") => getCollectorByPackageManager(pm, dir, tempDirManager).getNodeModules({ packageName });
  return { root, appDir, dependencies, tempDirManager, collect };
}

function assertDesktopClosure(modules, root) {
  assert.deepEqual(modules.map(dependency => dependency.name).sort(), ["electron-updater", "koffi", "optional-leaf", "updater-leaf"]);
  for (const dependency of modules) assert.equal(dependency.dir, join(root, "node_modules", dependency.name));
}

test("reviewed builder traverses the hoisted desktop closure without root web/dev dependencies", async t => {
  assert.equal(require("app-builder-lib/package.json").version, "26.18.0");
  const f = await workspace(t);
  const modules = await collectNodeModulesWithLogging({ info: {
    appDir: f.appDir, projectDir: f.root, tempDirManager: f.tempDirManager,
    getWorkspaceRoot: async () => f.root, getPackageManager: async () => PM.NPM,
    originalMetadata: { dependencies: f.dependencies }, nodePackageName: "@piora/desktop",
    config: { allowMissingDependencies: false },
  } });
  assertDesktopClosure(modules, f.root);
});

test("upstream one-dependency overlap is not proof of the full desktop closure", async t => {
  const f = await workspace(t);
  // Run the real npm collector on the root package, reproducing the wrong-root
  // result that workspace fallback can encounter. These are disk packages, not
  // a stubbed collector implementation or source-string assertion.
  const rootCollection = await f.collect(PM.NPM, f.root, "web-root");
  assert.deepEqual(rootCollection.nodeModules.map(dependency => dependency.name).sort(), ["koffi", "web-only"]);
  assert.equal(collectionMatchesAppDependencies(rootCollection.nodeModules, f.dependencies), true);
  const chosen = await resolveFirstMatchingCollection({
    pmApproaches: [PM.NPM, PM.TRAVERSAL], searchDirectories: [f.appDir], dependencies: f.dependencies,
    run: (pm, dir) => pm === PM.NPM ? rootCollection : f.collect(pm, dir),
  });
  assert.equal(chosen, rootCollection, "upstream accepts partial overlap before trying traversal");
  assertDesktopClosure((await f.collect(PM.TRAVERSAL, f.appDir)).nodeModules, f.root);
});

test("upstream rejects an unrelated npm root tree and falls back to real hoisted traversal", async t => {
  const f = await workspace(t, false);
  const rootCollection = await f.collect(PM.NPM, f.root, "web-root");
  assert.deepEqual(rootCollection.nodeModules.map(dependency => dependency.name), ["web-only"]);
  assert.equal(collectionMatchesAppDependencies(rootCollection.nodeModules, f.dependencies), false);
  const attempts = [];
  const chosen = await resolveFirstMatchingCollection({
    pmApproaches: [PM.NPM, PM.TRAVERSAL], searchDirectories: [f.appDir], dependencies: f.dependencies,
    run: (pm, dir) => { attempts.push(pm); return pm === PM.NPM ? rootCollection : f.collect(pm, dir); },
  });
  assert.deepEqual(attempts, [PM.NPM, PM.TRAVERSAL]);
  assertDesktopClosure(chosen.nodeModules, f.root);
});

test("npm collection failure still reaches the real traversal fallback", { timeout: 30000 }, async t => {
  const f = await workspace(t);
  const attempts = [];
  const chosen = await resolveFirstMatchingCollection({
    pmApproaches: [PM.NPM, PM.TRAVERSAL], searchDirectories: [f.appDir], dependencies: f.dependencies,
    run: (pm, dir) => { attempts.push(pm); return f.collect(pm, pm === PM.NPM ? join(f.root, "missing-directory") : dir); },
  });
  assert.deepEqual(attempts, [PM.NPM, PM.TRAVERSAL]);
  assertDesktopClosure(chosen.nodeModules, f.root);
});
