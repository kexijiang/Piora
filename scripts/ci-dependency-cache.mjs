import { createHash } from "node:crypto";
import { appendFile, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function dependencyCacheKey(root, runtime = process) {
  const hash = createHash("sha256");
  // Include the workspace path: npm's desktop workspace link is absolute on Windows.
  hash.update(JSON.stringify([resolve(root), runtime.platform, runtime.arch, runtime.version,
    runtime.versions.modules, runtime.env.ImageOS, runtime.env.ImageVersion]));
  const inputs = ["package.json", "package-lock.json", "desktop/package.json", ".npmrc", ".nvmrc"];
  for (const name of (await readdir(resolve(root, "scripts"))).sort()) {
    if (/^(?:patch-|pi-|branding|prepare-branding|build-brand-icon|brand-build-integrity|ci-dependency-cache)/.test(name)
      && /\.(?:mjs|cjs|json)$/.test(name)) inputs.push(`scripts/${name}`);
  }
  for (const file of inputs) {
    hash.update(file);
    try { hash.update(await readFile(resolve(root, file))); }
    catch (error) { if (error.code !== "ENOENT" || !file.startsWith(".")) throw error; }
  }
  return `piora-installed-v1-${runtime.platform}-${runtime.arch}-${hash.digest("hex")}`;
}

async function main() {
  const root = process.cwd();
  const key = await dependencyCacheKey(root);
  const stamp = resolve(root, "node_modules/.piora-ci-install.json");
  const mode = process.argv[2];
  if (mode === "key") {
    if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
    await appendFile(process.env.GITHUB_OUTPUT, `key=${key}\n`);
  } else if (mode === "record") {
    await writeFile(stamp, JSON.stringify({ key }));
  } else if (mode === "verify") {
    if (JSON.parse(await readFile(stamp, "utf8")).key !== key) throw new Error("Installed dependency cache identity mismatch");
    await readFile(resolve(root, "node_modules/.package-lock.json"));
    if (await realpath(resolve(root, "node_modules/@piora/desktop")) !== await realpath(resolve(root, "desktop"))) {
      throw new Error("Cached desktop workspace link points outside this checkout");
    }
    // Exercise the host ABI before any tests or packaging can consume the cache.
    const { createRequire } = await import("node:module");
    const require = createRequire(resolve(root, "package.json"));
    for (const name of ["sharp", "node-pty", "koffi"]) require(name);
    console.log("Verified exact installed dependency cache and native modules");
  } else throw new Error("Expected key, record or verify");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
