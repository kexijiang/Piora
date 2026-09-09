import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import { createWebRuntimeArchive } from "../scripts/archive-web-runtime.mjs";
import { collectRuntimeDependencyAssets } from "../scripts/stage-standalone.mjs";
const require = createRequire(import.meta.url);

test("packaged sharp decodes images under Electron using its complete native dependency sidecar", { skip: process.platform !== "win32", timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "piora-image-package-"));
  t.after(async () => { assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}piora-image-package-`)); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const source = join(root, "source");
  const archive = join(root, "runtime.asar");
  await mkdir(source, { recursive: true });
  const assets = await collectRuntimeDependencyAssets([resolve("node_modules/sharp")], process.cwd(), source);
  assert.ok(assets.some((asset) => asset.name.includes("@img/sharp-win32")));
  for (const asset of assets) await cp(asset.source, asset.destination, { recursive: true });
  await writeFile(join(source, "probe.cjs"), `
    const sharp = require('sharp');
    (async () => {
      const image = await sharp({create:{width:3,height:2,channels:4,background:'#123456'}}).png().toBuffer();
      const metadata = await sharp(image).metadata();
      console.log(JSON.stringify({width:metadata.width,height:metadata.height,format:metadata.format}));
    })().catch(error => { console.error(error); process.exitCode=1; });
  `);
  await createWebRuntimeArchive(source, archive);
  assert.ok(resolve(source).startsWith(`${resolve(root)}${sep}`));
  await rm(source, { recursive: true, force: true });
  const output = await new Promise((done, reject) => {
    const child = spawn(require("electron"), [join(archive, "probe.cjs")], { cwd: root, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_PATH: "" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Packaged image decoding timed out")); }, 15000);
    child.stdout.on("data", (data) => { stdout += data; }); child.stderr.on("data", (data) => { stderr += data; });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code) => { clearTimeout(timeout); if (code) reject(new Error(stderr || `Exit ${code}`)); else done(stdout.trim()); });
  });
  assert.deepEqual(JSON.parse(output), { width: 3, height: 2, format: "png" });
});
