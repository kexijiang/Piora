import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, dirname, delimiter, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { createJiti } from "jiti";
import { createWebRuntimeArchive } from "../scripts/archive-web-runtime.mjs";
import { collectRuntimeDependencyAssets } from "../scripts/stage-standalone.mjs";
import { verifyPackagedDevEcoCli, verifyPackagedHarmonyHapPreview } from "../scripts/verify-packaged-web.mjs";
const jiti = createJiti(import.meta.url);
const { harmonyRuntimeAsset } = await jiti.import("./harmony/runtime/asset-path.ts");
const { workerEnvironment } = await jiti.import("./harmony/runtime/worker-client.ts");

test("SQLite error locations run from isolated ASAR sidecars with the actual WASM parser", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "harmony-sqlite-diagnostics-"));
  let worker;
  try {
    const root = join(directory, "source"), archive = join(directory, "runtime.asar");
    const runtime = "lib/harmony/runtime";
    await mkdir(join(root, runtime), { recursive: true });
    for (const asset of ["sqlite-inspector.cjs", "sqlite-error-location.cjs"]) {
      await cp(new URL(`./harmony/runtime/${asset}`, import.meta.url), join(root, runtime, asset));
    }
    const assets = await collectRuntimeDependencyAssets([resolve("node_modules/@sqlite.org/sqlite-wasm")], process.cwd(), root);
    for (const asset of assets) {
      await mkdir(dirname(asset.destination), { recursive: true });
      await cp(asset.source, asset.destination, { recursive: true });
    }
    const databasePath = join(directory, "sample.sqlite");
    const database = new DatabaseSync(databasePath);
    try { database.exec("CREATE TABLE sample(note TEXT); INSERT INTO sample VALUES('original')"); }
    finally { database.close(); }
    const original = await readFile(databasePath);
    await createWebRuntimeArchive(root, archive);
    const sidecar = `${archive}.unpacked`;
    for (const asset of ["dist/node.mjs", "dist/sqlite3.wasm"]) {
      assert.ok((await readFile(join(sidecar, "node_modules/@sqlite.org/sqlite-wasm", asset))).length);
    }
    const sql = "SELECT '中文😀 sample' FRM sample";
    worker = new Worker(join(sidecar, runtime, "sqlite-inspector.cjs"), {
      workerData: { path: databasePath, sql, offset: 0 }, env: { ...process.env, NODE_PATH: "" },
    });
    const result = await new Promise((resolveResult, rejectResult) => {
      worker.once("message", resolveResult);
      worker.once("error", rejectResult);
      worker.once("exit", code => rejectResult(new Error(`Worker exited before responding: ${code}`)));
    });
    assert.equal(result.error, 'near "sample": syntax error');
    assert.equal(result.sqlErrorOffset, Buffer.byteLength(sql.slice(0, sql.lastIndexOf("sample")), "utf8"));
    assert.deepEqual(await readFile(databasePath), original, "diagnostics never change the source database");
  } finally {
    await worker?.terminate();
    await rm(directory, { recursive: true, force: true });
  }
});

test("isolated media runtime includes both Node require and ESM entry points", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harmony-media-staging-"));
  try {
    const assets = await collectRuntimeDependencyAssets([resolve("node_modules/mediabunny")], process.cwd(), directory);
    for (const asset of assets) { await mkdir(dirname(asset.destination), { recursive: true }); await cp(asset.source, asset.destination, { recursive: true }); }
    const require = createRequire(join(directory, "probe.cjs"));
    const commonjs = require("mediabunny");
    assert.equal(typeof commonjs.Output, "function");
    assert.equal(typeof commonjs.EncodedVideoPacketSource, "function");
    const esm = await import(pathToFileURL(join(directory, "node_modules/mediabunny/dist/modules/src/index.js")).href);
    assert.equal(typeof esm.Mp4OutputFormat, "function");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("packaged Harmony device text includes its codec dependency", async () => {
  const staging = await readFile(new URL("../scripts/stage-standalone.mjs", import.meta.url), "utf8");
  assert.match(staging, /collectRuntimeDependencyAssets\(\[[\s\S]*join\(projectRoot, "node_modules", "iconv-lite"\)/);
  const directory = await mkdtemp(join(tmpdir(), "harmony-codec-staging-"));
  try {
    const assets = await collectRuntimeDependencyAssets([resolve("node_modules/iconv-lite")], process.cwd(), directory);
    for (const asset of assets) { await mkdir(dirname(asset.destination), { recursive: true }); await cp(asset.source, asset.destination, { recursive: true }); }
    const isolatedRequire = createRequire(join(directory, "probe.cjs"));
    assert.equal(isolatedRequire("iconv-lite").decode(isolatedRequire("iconv-lite").encode("中文", "gb18030"), "gb18030"), "中文");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("isolated source-loaded HAP preview needs JSZip's complete Node dependency closure", { timeout: 30000 }, async () => {
  const staging = await readFile(new URL("../scripts/stage-standalone.mjs", import.meta.url), "utf8");
  assert.match(staging, /collectRuntimeDependencyAssets\(\[[\s\S]*join\(projectRoot, "node_modules", "jszip"\)/);
  assert.match(staging, /piCodingAgentJitiRuntimeRoot/);
  const directory = await mkdtemp(join(tmpdir(), "harmony-hap-staging-"));
  try {
    for (const relative of ["lib/harmony/errors.ts", "lib/harmony/runtime/hap-preview.ts", "lib/harmony/runtime/bounded-file.ts", "lib/harmony/runtime/path-safety.ts"]) {
      await mkdir(dirname(join(directory, relative)), { recursive: true });
      await cp(resolve(relative), join(directory, relative));
    }
    const stage = async roots => {
      const assets = await collectRuntimeDependencyAssets(roots, process.cwd(), directory);
      for (const asset of assets) { await mkdir(dirname(asset.destination), { recursive: true }); await cp(asset.source, asset.destination, { recursive: true }); }
      return assets;
    };
    const requireFromPi = createRequire(resolve("node_modules/@earendil-works/pi-coding-agent/package.json"));
    await stage([dirname(requireFromPi.resolve("jiti/package.json"))]);
    await assert.rejects(verifyPackagedHarmonyHapPreview(directory), /Cannot find module 'jszip'/);
    const assets = await stage([resolve("node_modules/jszip")]);
    assert.ok(assets.some(asset => asset.name === "dynamic runtime dependency pako"));
    assert.ok(assets.some(asset => asset.name === "dynamic runtime dependency readable-stream"));
    assert.deepEqual(await verifyPackagedHarmonyHapPreview(directory), {
      bundleName: "dev.piora.packagedpreview", versionCode: 7, compressed: true, unchanged: true,
    });
    const pako = assets.find(asset => asset.name === "dynamic runtime dependency pako");
    await rm(pako.destination, { recursive: true, force: true });
    await assert.rejects(verifyPackagedHarmonyHapPreview(directory), /Cannot find module 'pako'/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("isolated DevEco 1.3.6 closure launches with overridden Axios and patched node-forge", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "harmony-deveco-staging-"));
  try {
    const assets = await collectRuntimeDependencyAssets([
      resolve("node_modules/@deveco/deveco-cli"),
      resolve("node_modules/@deveco/deveco-cli-common"),
    ], process.cwd(), directory);
    for (const name of ["@deveco/deveco-cli-common", "@deveco/deveco-cli-knowledgebase", "axios", "node-forge", "ui-verification-mcp"]) {
      assert.ok(assets.some(asset => asset.name === `dynamic runtime dependency ${name}`), name);
    }
    for (const asset of assets) {
      await mkdir(dirname(asset.destination), { recursive: true });
      await cp(asset.source, asset.destination, { recursive: true });
    }
    assert.deepEqual(await verifyPackagedDevEcoCli(directory), {
      version: "1.3.6", axiosVersion: "1.20.0", nodeForgeVersion: "1.4.0",
      rsaSha256: "18ae286c1ef8e00fc6359ffe3280416946c1dfd6684c98c1c6af1590d7f7e9f4",
    });
    // A vulnerable nested copy must fail even when the root copy is patched.
    const nestedForge = join(directory, "node_modules/@deveco/deveco-cli-common/node_modules/node-forge");
    await mkdir(join(nestedForge, "lib"), { recursive: true });
    await writeFile(join(nestedForge, "package.json"), JSON.stringify({ name: "node-forge", version: "1.4.0" }));
    await writeFile(join(nestedForge, "lib/rsa.js"), "unpatched nested RSA source");
    await assert.rejects(verifyPackagedDevEcoCli(directory), /reviewed node-forge patch/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Harmony executables and device resources survive ASAR as real sidecar files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harmony-runtime-archive-"));
  const previous = process.env.PIORA_WEB_RUNTIME_ROOT;
  try {
    const root = join(directory, "source"), archive = join(directory, "runtime.asar");
    const paths = [".harmony-worker/harmony/runtime/worker-entry.js", "lib/harmony/audio/acoustic-provider.ps1", "node_modules/hypium-driver/build/lib/resource/uitest_agent_v1.2.2.so", "node_modules/hypium-driver/package.json", "node_modules/@deveco/deveco-cli/cli.js", "node_modules/@deveco/deveco-cli-common/dist/cli.js", "node_modules/@deveco/deveco-cli-knowledgebase/docs.zip"];
    for (const path of paths) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), path); }
    await createWebRuntimeArchive(root, archive);
    process.env.PIORA_WEB_RUNTIME_ROOT = archive;
    for (const path of paths) assert.equal(await readFile(harmonyRuntimeAsset(...path.split("/")), "utf8"), path);
    const env = workerEnvironment("hdc", { PIORA_WEB_RUNTIME_ROOT: archive, NODE_PATH: "existing" });
    assert.deepEqual(env.NODE_PATH.split(delimiter), [join(`${archive}.unpacked`, "node_modules"), join(archive, "node_modules"), "existing"]);
  } finally { if (previous === undefined) delete process.env.PIORA_WEB_RUNTIME_ROOT; else process.env.PIORA_WEB_RUNTIME_ROOT = previous; await rm(directory, { recursive: true, force: true }); }
});
