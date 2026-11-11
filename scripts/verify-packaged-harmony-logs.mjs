import { stat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const HARMONY_LOG_RUNTIME_FILES = [
  ...["log-library", "log-storage", "log-worker", "log-archive", "log-encoding", "log-package", "log-parser", "log-query", "log-rar", "log-management", "session-search", "session-search-storage", "logs", "log-limits"].map(name => `lib/harmony/log-library/vendor/${name}.mjs`),
  "node_modules/yauzl/index.js", "node_modules/yauzl/crc32.js", "node_modules/yauzl/fd-slicer.js", "node_modules/yauzl/package.json",
  "node_modules/pend/index.js", "node_modules/pend/package.json",
  "node_modules/7z-bin/dist/index.mjs", "node_modules/7z-bin/package.json",
  "node_modules/7z-bin/bin/win/x64/7z.exe", "node_modules/7z-bin/bin/win/x64/7z.dll", "node_modules/7z-bin/bin/win/x64/License.txt",
];

/** Checks the actual sidecar too: extracting ASAR alone can mask missing workers. */
export async function verifyPackagedHarmonyLogAssets(webRoot, sidecarRoot = webRoot) {
  for (const root of new Set([webRoot, sidecarRoot])) {
    for (const file of HARMONY_LOG_RUNTIME_FILES) {
      const info = await stat(join(root, file)).catch(() => undefined);
      if (!info?.isFile() || !info.size) throw new Error(`Packaged Harmony log runtime is missing: ${join(root, file)}`);
    }
    const zip = JSON.parse(await readFile(join(root, "node_modules/yauzl/package.json"), "utf8"));
    const rar = JSON.parse(await readFile(join(root, "node_modules/7z-bin/package.json"), "utf8"));
    if (zip.version !== "3.4.0" || rar.version !== "26.4.0") throw new Error("Packaged log archive dependencies do not match the reviewed versions");
  }
  return { runtimeFiles: HARMONY_LOG_RUNTIME_FILES.length, zip: "yauzl@3.4.0", rar: "7z-bin@26.4.0", realSidecar: true };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2]) throw new Error("Pass the extracted web runtime and optional ASAR sidecar directory");
  console.log(JSON.stringify(await verifyPackagedHarmonyLogAssets(resolve(process.argv[2]), process.argv[3] ? resolve(process.argv[3]) : undefined)));
}
