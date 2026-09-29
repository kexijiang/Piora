import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, dirname, delimiter, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
import { createWebRuntimeArchive } from "../scripts/archive-web-runtime.mjs";
import { collectRuntimeDependencyAssets } from "../scripts/stage-standalone.mjs";
const jiti = createJiti(import.meta.url);
const { harmonyRuntimeAsset } = await jiti.import("./harmony/runtime/asset-path.ts");
const { workerEnvironment } = await jiti.import("./harmony/runtime/worker-client.ts");

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

test("Harmony executables and device resources survive ASAR as real sidecar files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harmony-runtime-archive-"));
  const previous = process.env.PIORA_WEB_RUNTIME_ROOT;
  try {
    const root = join(directory, "source"), archive = join(directory, "runtime.asar");
    const paths = [".harmony-worker/harmony/runtime/worker-entry.js", "lib/harmony/audio/acoustic-provider.ps1", "node_modules/hypium-driver/build/lib/resource/uitest_agent_v1.2.2.so", "node_modules/hypium-driver/package.json"];
    for (const path of paths) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), path); }
    await createWebRuntimeArchive(root, archive);
    process.env.PIORA_WEB_RUNTIME_ROOT = archive;
    for (const path of paths) assert.equal(await readFile(harmonyRuntimeAsset(...path.split("/")), "utf8"), path);
    const env = workerEnvironment("hdc", { PIORA_WEB_RUNTIME_ROOT: archive, NODE_PATH: "existing" });
    assert.deepEqual(env.NODE_PATH.split(delimiter), [join(`${archive}.unpacked`, "node_modules"), join(archive, "node_modules"), "existing"]);
  } finally { if (previous === undefined) delete process.env.PIORA_WEB_RUNTIME_ROOT; else process.env.PIORA_WEB_RUNTIME_ROOT = previous; await rm(directory, { recursive: true, force: true }); }
});
