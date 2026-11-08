import { createRequire } from "node:module";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fetchReleaseAsset } from "./github-release-download.mjs";

const require = createRequire(import.meta.url);
const { version } = require("electron/package.json");
const checksums = require("electron/checksums.json");
const { downloadArtifact } = await import("@electron/get");
await downloadArtifact({
  version, platform: "win32", arch: "x64", artifactName: "electron", checksums, cacheRoot: process.env.electron_config_cache,
  downloader: { async download(url, path) {
    const response = await fetchReleaseAsset(url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok || !response.body) throw new Error(`Electron download failed: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(path));
  } },
});
// electron-builder verifies the cached archive independently and otherwise
// re-downloads the checksum list. Seed it from Electron's bundled manifest.
const builderCache = process.env.electron_config_cache || join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "electron", "Cache");
await mkdir(builderCache, { recursive: true });
await writeFile(join(builderCache, `SHASUMS256.txt-${version}`), Object.entries(checksums).map(([name, hash]) => `${hash} *${name}`).join("\n") + "\n");
console.log(`Verified Electron ${version} download cache`);
