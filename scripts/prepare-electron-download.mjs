import { createRequire } from "node:module";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fetchReleaseAsset } from "./github-release-download.mjs";

const require = createRequire(import.meta.url);
const { version } = require("electron/package.json");
const checksums = require("electron/checksums.json");
const { downloadArtifact } = await import("@electron/get");
const archive = await downloadArtifact({
  version, platform: "win32", arch: "x64", artifactName: "electron", checksums, cacheRoot: process.env.electron_config_cache,
  downloader: { async download(url, path) {
    const response = await fetchReleaseAsset(url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok || !response.body) throw new Error(`Electron download failed: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(path));
  } },
});
// electron-builder can depend on a different @electron/get major version,
// whose Windows cache key differs. Seed that cache using the verified bytes;
// its own checksum validation still runs before accepting the copy.
const builderRequire = createRequire(require.resolve("app-builder-lib/package.json"));
const builderGet = builderRequire("@electron/get");
await builderGet.downloadArtifact({
  version, platform: "win32", arch: "x64", artifactName: "electron", checksums, cacheRoot: process.env.electron_config_cache,
  downloader: { async download(_url, path) { await copyFile(archive, path); } },
});
// electron-builder verifies the cached archive independently and otherwise
// re-downloads the checksum list. Seed it from Electron's bundled manifest.
const builderCache = process.env.electron_config_cache || join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "electron", "Cache");
await mkdir(builderCache, { recursive: true });
await writeFile(join(builderCache, `SHASUMS256.txt-${version}`), Object.entries(checksums).map(([name, hash]) => `${hash} *${name}`).join("\n") + "\n");
console.log(`Verified Electron ${version} download cache`);
