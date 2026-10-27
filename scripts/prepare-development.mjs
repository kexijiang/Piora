import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadBranding } from "./branding-config.mjs";
import { brandBuildFingerprint } from "./brand-build-integrity.mjs";

const sourceRoot = resolve(import.meta.dirname, "..");

export async function prepareDevelopmentBranding(root = sourceRoot) {
  const brand = await loadBranding(root);
  const hash = createHash("sha256").update(JSON.stringify(brand));
  const inputs = [
    resolve(root, "branding/offline.template.html"),
    resolve(root, "desktop/electron-builder.yml"),
    ...Object.values(brand.assets),
    ...["prepare-development.mjs", "prepare-branding.mjs", "branding-config.mjs", "build-brand-icon.mjs", "brand-build-integrity.mjs"]
      .map((file) => fileURLToPath(new URL(file, import.meta.url))),
  ];
  for (const file of inputs) hash.update(file).update(await readFile(file));
  const fingerprint = hash.digest("hex");
  const cacheFile = resolve(root, ".branding/development.json");
  try {
    const cache = JSON.parse(await readFile(cacheFile, "utf8"));
    if (cache.inputs === fingerprint && cache.outputs === await brandBuildFingerprint(root)) {
      return { reused: true, brand: brand.displayName };
    }
  } catch { /* Missing, stale or modified generated resources are regenerated. */ }
  const { prepareBranding } = await import("./prepare-branding.mjs");
  await prepareBranding(root);
  await mkdir(resolve(root, ".branding"), { recursive: true });
  await writeFile(cacheFile, JSON.stringify({ inputs: fingerprint, outputs: await brandBuildFingerprint(root) }));
  return { reused: false, brand: brand.displayName };
}

export async function prepareDevelopment(root = sourceRoot) {
  const started = performance.now();
  const brand = await prepareDevelopmentBranding(root);
  console.log(`[dev:prepare] ${brand.brand} branding ${brand.reused ? "unchanged; reusing resources" : "prepared"}`);
  await prepareDevelopmentWorker(root);
  console.log(`[dev:prepare] ready in ${Math.round(performance.now() - started)}ms`);
}

export async function prepareDevelopmentWorker(root = sourceRoot) {
  const infoFile = resolve(root, ".harmony-worker/development.tsbuildinfo");
  // TypeScript's incremental state may otherwise claim success after a caller
  // removes emitted files. Rebuild if either worker entry point is missing.
  try {
    for (const file of ["worker-entry.js", "device-lock.js"]) await stat(resolve(root, ".harmony-worker/harmony/runtime", file));
  } catch { await unlink(infoFile).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
  const require = createRequire(resolve(root, "package.json"));
  const compiler = resolve(require.resolve("@typescript/native/package.json"), "../lib/tsc.js");
  const result = spawnSync(process.execPath, [compiler, "-p", "tsconfig.harmony-worker.json", "--incremental", "--tsBuildInfoFile", infoFile], {
    cwd: root, stdio: "inherit", windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Harmony worker preparation failed (${result.status ?? result.signal})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  prepareDevelopment().catch((error) => { console.error(error); process.exitCode = 1; });
}
