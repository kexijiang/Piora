import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";
import { collectRuntimeDependencyAssets } from "../scripts/stage-standalone.mjs";
import { createWebRuntimeArchive } from "../scripts/archive-web-runtime.mjs";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { default: nextConfig } = await createJiti(import.meta.url).import("../next.config.ts");

test("production webpack compiles the shared ESM analytics store and preserves durable SQLite records", async () => {
  const directory = mkdtempSync(join(tmpdir(), "piora-analytics-bundle-"));
  let store;
  try {
    const config = nextConfig.webpack({
      mode: "production", target: "node", devtool: false,
      optimization: { minimize: false },
      entry: join(root, "desktop/src/analytics-store.mts"),
      output: { path: directory, filename: "analytics.cjs", library: { type: "commonjs2" } },
      resolve: { extensions: [".mts", ".js"] },
      module: { rules: [] }, externals: [],
    }, { isServer: true, dev: false });
    const compiler = webpack(config);
    await new Promise((resolveBuild, reject) => compiler.run((error, stats) => {
      compiler.close(closeError => {
        if (error || closeError) return reject(error || closeError);
        if (stats.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })));
        resolveBuild();
      });
    }));
    const { AnalyticsStore, DEFAULT_ANALYTICS_POLICY } = require(join(directory, "analytics.cjs"));
    store = new AnalyticsStore(join(directory, "state"));
    const id = store.record("desktop.started", "bundle-launch", { reason: "manual" });
    store.close();
    store = new AnalyticsStore(join(directory, "state"));
    assert.equal(store.record("desktop.started", "bundle-launch", { reason: "manual" }), id);
    const batch = store.batch(DEFAULT_ANALYTICS_POLICY);
    assert.equal(batch.length, 1);
    assert.equal(batch[0].event_id, id);
  } finally {
    store?.close();
    assert.match(relative(resolve(tmpdir()), resolve(directory)), /^piora-analytics-bundle-[\w-]+$/);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("source-loaded analytics resolves its shared store and diff outside the development dependency tree", async () => {
  const directory = mkdtempSync(join(tmpdir(), "piora-analytics-bundle-"));
  const archiveDirectory = mkdtempSync(join(tmpdir(), "piora-analytics-bundle-"));
  try {
    const staging = readFileSync(join(root, "scripts/stage-standalone.mjs"), "utf8");
    assert.match(staging, /\["Piora analytics shared store", "desktop\/src\/analytics-store\.mts"\]/);
    assert.match(staging, /collectRuntimeDependencyAssets\(\[[\s\S]*join\(projectRoot, "node_modules", "diff"\)/);
    for (const file of ["lib/analytics-telemetry.ts", "desktop/src/analytics-store.mts"]) {
      mkdirSync(dirname(join(directory, file)), { recursive: true });
      cpSync(join(root, file), join(directory, file));
    }
    const stage = async packageRoot => {
      const assets = await collectRuntimeDependencyAssets([packageRoot], root, directory);
      for (const asset of assets) {
        mkdirSync(dirname(asset.destination), { recursive: true });
        cpSync(asset.source, asset.destination, { recursive: true });
      }
    };
    await stage(join(root, "node_modules/jiti"));
    const isolatedRequire = createRequire(join(directory, "probe.cjs"));
    const { createJiti: isolatedJiti } = isolatedRequire("jiti");
    const load = () => isolatedJiti(join(directory, "probe.cjs"), { fsCache: false, moduleCache: false });
    await assert.rejects(load().import(join(directory, "lib/analytics-telemetry.ts")), /Cannot find (?:module|package) 'diff'/);
    await stage(join(root, "node_modules/diff"));
    const telemetry = await load().import(join(directory, "lib/analytics-telemetry.ts"));
    assert.equal(typeof telemetry.installAnalyticsModelObserver, "function");
    assert.equal(typeof telemetry.installAnalyticsFileObserver, "function");
    assert.equal(telemetry.normalizeAnalyticsUsage(undefined).usage_status, "unavailable");
    assert.equal(isolatedRequire("diff").diffLines("before\n", "after\n").length, 2);
    const archive = join(archiveDirectory, "runtime.asar");
    await createWebRuntimeArchive(directory, archive);
    const probe = join(archiveDirectory, "probe.cjs");
    writeFileSync(probe, [
      'const assert = require("node:assert/strict");',
      'const path = require("node:path");',
      'const archive = process.argv[2];',
      'const { createJiti } = require(path.join(archive, "node_modules/jiti"));',
      'createJiti(path.join(archive, "probe.cjs"), { fsCache: false, moduleCache: false }).import(path.join(archive, "lib/analytics-telemetry.ts")).then(t => { assert.equal(typeof t.installAnalyticsFileObserver, "function"); assert.equal(t.normalizeAnalyticsUsage().usage_status, "unavailable"); console.log("ASAR_ANALYTICS_OK"); }).catch(e => { console.error(e); process.exitCode = 1; });',
    ].join("\n"));
    const child = spawnSync(require("electron"), [probe, archive], {
      cwd: archiveDirectory, windowsHide: true, encoding: "utf8", timeout: 30000,
      env: { ...process.env, NODE_PATH: "", ELECTRON_RUN_AS_NODE: "1" },
    });
    assert.equal(child.status, 0, child.error?.message ?? child.stderr);
    assert.match(child.stdout, /ASAR_ANALYTICS_OK/);
  } finally {
    for (const path of [directory, archiveDirectory]) {
      assert.match(relative(resolve(tmpdir()), resolve(path)), /^piora-analytics-bundle-[\w-]+$/);
      rmSync(path, { recursive: true, force: true });
    }
  }
});
