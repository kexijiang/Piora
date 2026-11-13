import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

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
