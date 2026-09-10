import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";
import { listPackage } from "@electron/asar";
import { extractVersionNotes } from "./create-release-notes.mjs";

const VERSION_PATTERN = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/;

function normalizeVersion(value) {
  const match = String(value ?? "").trim().match(VERSION_PATTERN);
  if (!match) throw new Error(`Expected a stable semantic version, received: ${value}`);
  return `${match[1]}.${match[2]}.${match[3]}${match[4] === undefined ? "" : `-beta.${match[4]}`}`;
}

async function sha512Base64(path) {
  const hash = createHash("sha512");
  await new Promise((resolveHash, rejectHash) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", resolveHash);
  });
  return hash.digest("base64");
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a YAML object.`);
  }
  return value;
}

export function normalizeAsarEntry(entry) {
  return entry.replaceAll("\\", "/");
}

export function verifyUpdateReleaseNotes(metadata, expected, label = "update metadata") {
  if (typeof metadata.releaseNotes !== "string" || !metadata.releaseNotes.trim()) {
    throw new Error(`${label} is missing releaseNotes; the in-app update dialog would have no change list.`);
  }
  if (expected !== undefined && metadata.releaseNotes.trim() !== expected.trim()) {
    throw new Error(`${label} releaseNotes do not match the tagged CHANGELOG section.`);
  }
}

export async function verifyWindowsUpdateArtifacts(releaseRoot, requestedVersion, expectedReleaseNotes) {
  const root = resolve(releaseRoot);
  const version = normalizeVersion(requestedVersion);
  const channel = version.includes("-beta.") ? "beta" : "latest";
  const installerName = `Piora-${version}-win-x64-setup.exe`;
  const installerPath = join(root, installerName);
  const blockmapPath = `${installerPath}.blockmap`;
  const metadataName = `${channel}.yml`;
  const metadataPath = join(root, metadataName);
  const runtimeConfigPath = join(root, "win-unpacked", "resources", "app-update.yml");
  const applicationAsarPath = join(root, "win-unpacked", "resources", "app.asar");

  const [installerStat, blockmapStat, metadataText, runtimeConfigText] = await Promise.all([
    stat(installerPath),
    stat(blockmapPath),
    readFile(metadataPath, "utf8"),
    readFile(runtimeConfigPath, "utf8"),
  ]);
  if (!installerStat.isFile() || installerStat.size < 10 * 1024 * 1024) {
    throw new Error(`${installerName} is missing or unexpectedly small.`);
  }
  if (!blockmapStat.isFile() || blockmapStat.size < 100) {
    throw new Error(`${basename(blockmapPath)} is missing or unexpectedly small.`);
  }

  const metadata = requireObject(parseYaml(metadataText), metadataName);
  if (metadata.version !== version) {
    throw new Error(`${metadataName} version ${metadata.version} does not match ${version}.`);
  }
  verifyUpdateReleaseNotes(metadata, expectedReleaseNotes, metadataName);
  if (!Array.isArray(metadata.files) || metadata.files.length !== 1) {
    throw new Error(`${metadataName} must describe exactly one Windows installer.`);
  }
  const file = requireObject(metadata.files[0], `${metadataName} files[0]`);
  if (file.url !== installerName) {
    throw new Error(`${metadataName} points at ${file.url} instead of ${installerName}.`);
  }
  if (file.size !== installerStat.size) {
    throw new Error(`${metadataName} size for ${installerName} does not match the installer.`);
  }
  const actualSha512 = await sha512Base64(installerPath);
  if (file.sha512 !== actualSha512) {
    throw new Error(`${metadataName} SHA-512 does not match ${installerName}.`);
  }

  const runtimeConfig = requireObject(parseYaml(runtimeConfigText), "app-update.yml");
  if (runtimeConfig.provider !== "github" || runtimeConfig.owner !== "kexijiang" || runtimeConfig.repo !== "Piora") {
    throw new Error("The packaged updater is not configured for kexijiang/Piora GitHub Releases.");
  }
  if (channel === "beta" && runtimeConfig.channel !== "beta") {
    throw new Error("The packaged preview updater is not configured for the beta channel.");
  }
  const applicationEntries = new Set(listPackage(applicationAsarPath).map(normalizeAsarEntry));
  for (const requiredEntry of [
    "/node_modules/electron-updater/out/main.js",
    "/node_modules/builder-util-runtime/out/index.js",
  ]) {
    if (!applicationEntries.has(requiredEntry)) {
      throw new Error(`The packaged desktop runtime is missing ${requiredEntry}.`);
    }
  }

  return {
    version,
    installerName,
    installerSize: installerStat.size,
    blockmapName: basename(blockmapPath),
    metadataName,
    updaterRuntimeVerified: true,
    sha512: actualSha512,
  };
}

async function main() {
  const [releaseRoot, requestedVersion] = process.argv.slice(2);
  if (!releaseRoot) {
    throw new Error("Usage: node scripts/verify-windows-update-artifacts.mjs <release-root> [version-or-tag]");
  }
  const version = requestedVersion ?? JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ).version;
  const changelog = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  const result = await verifyWindowsUpdateArtifacts(releaseRoot, version, extractVersionNotes(changelog, version));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
