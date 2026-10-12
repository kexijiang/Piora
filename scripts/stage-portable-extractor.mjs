import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { EnvHttpProxyAgent, fetch } from "undici";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const extractorManifest = JSON.parse(await readFile(join(root, "third_party/7zip/manifest.json"), "utf8"));
export async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function check(path, expected) {
  if (await hashFile(path) !== expected) throw new Error(`Portable extractor SHA-256 mismatch: ${path}`);
}
export async function verifyStagedPortableExtractor(directory) {
  const m = extractorManifest;
  const rootEntry = await lstat(directory);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) throw new Error("Portable extractor must be a regular directory");
  const expectedNames = ["7za.exe", "License.txt", "COPYING", m.sourceAsset, "SOURCE.md", "manifest.json"].sort();
  if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(expectedNames)) throw new Error("Portable extractor file set mismatch");
  for (const name of expectedNames) {
    const entry = await lstat(join(directory, name));
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Portable extractor file must be regular: ${name}`);
  }
  for (const [name, expected] of [["7za.exe", m.executableSha256], ["License.txt", m.licenseSha256], ["COPYING", m.copyingSha256], [m.sourceAsset, m.sourceSha256]]) {
    await check(join(directory, name), expected);
  }
  if ((await readFile(join(directory, "SOURCE.md"), "utf8")) !== await readFile(join(root, "third_party/7zip/SOURCE.md"), "utf8")) throw new Error("Portable extractor source notice mismatch");
  if (JSON.stringify(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"))) !== JSON.stringify(m)) throw new Error("Portable extractor pin manifest mismatch");
}
export async function stagePortableExtractor(projectRoot = root) {
  const build = join(projectRoot, "desktop/build");
  const destination = join(build, "portable-extractor");
  try { await verifyStagedPortableExtractor(destination); return destination; } catch { /* Regenerate incomplete staging. */ }
  await mkdir(build, { recursive: true });
  const temporary = await mkdtemp(join(build, ".portable-extractor-"));
  const staged = join(temporary, "staged");
  const dispatcher = new EnvHttpProxyAgent();
  try {
    await mkdir(staged);
    const m = extractorManifest;
    for (const [url, path, sha] of [[m.url, join(temporary, m.asset), m.sha256], [m.sourceUrl, join(staged, m.sourceAsset), m.sourceSha256], [m.copyingUrl, join(staged, "COPYING"), m.copyingSha256]]) {
      const response = await fetch(url, { dispatcher, signal: AbortSignal.timeout(180_000) });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`7-Zip download failed: HTTP ${response.status}`); }
      await pipeline(Readable.fromWeb(response.body), createWriteStream(path));
      await check(path, sha);
    }
    const require = createRequire(import.meta.url);
    const { getPath7za } = require("app-builder-lib/out/toolsets/7zip");
    const bootstrap = await getPath7za();
    await promisify(execFile)(bootstrap, ["x", join(temporary, m.asset), `-o${join(temporary, "upstream")}`, "-y"], { windowsHide: true, timeout: 60_000 });
    await copyFile(join(temporary, "upstream/x64/7za.exe"), join(staged, "7za.exe"));
    await copyFile(join(temporary, "upstream/License.txt"), join(staged, "License.txt"));
    await copyFile(join(root, "third_party/7zip/SOURCE.md"), join(staged, "SOURCE.md"));
    await writeFile(join(staged, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
    await verifyStagedPortableExtractor(staged);
    await rm(destination, { recursive: true, force: true });
    await rename(staged, destination);
    return destination;
  } finally {
    await dispatcher.destroy();
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stagePortableExtractor().then(path => console.log(`Staged 7-Zip ${extractorManifest.version}: ${path}`)).catch(error => { console.error(error); process.exitCode = 1; });
}
