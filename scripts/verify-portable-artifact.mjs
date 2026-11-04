#!/usr/bin/env node

import { open, readdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBranding } from "./branding-config.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STRICT_VERSION = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:alpha|beta)\.(0|[1-9]\d*))?$/;
const MINIMUM_PORTABLE_BYTES = 50 * 1024 * 1024;

export function normalizePortableVersion(value) {
  const match = STRICT_VERSION.exec(value ?? "");
  if (!match) throw new Error(`Expected version must match X.Y.Z[-beta.N] or vX.Y.Z[-beta.N]: ${value ?? ""}`);
  return value.startsWith("v") ? value.slice(1) : value;
}

export async function findPortableArtifact(releaseRoot, expectedVersion, artifactPrefix = "Piora") {
  const version = normalizePortableVersion(expectedVersion);
  const expectedName = `${artifactPrefix}-${version}-win-x64-portable.exe`;
  const entries = await readdir(releaseRoot, { withFileTypes: true });
  const candidates = entries.filter((entry) => entry.isFile() && /-portable\.exe$/i.test(entry.name));
  if (candidates.length !== 1 || candidates[0].name !== expectedName) {
    throw new Error(`Expected only ${expectedName} in ${releaseRoot}; found ${candidates.map((entry) => entry.name).join(", ") || "none"}.`);
  }
  return resolve(releaseRoot, expectedName);
}

export async function verifyPortableArtifact(path, expectedVersion) {
  normalizePortableVersion(expectedVersion);
  const info = await stat(path);
  if (!info.isFile() || info.size < MINIMUM_PORTABLE_BYTES) {
    throw new Error(`Portable artifact is missing or unexpectedly small: ${path} (${info.size} bytes).`);
  }

  const handle = await open(path, "r");
  try {
    const dos = Buffer.alloc(64);
    await handle.read(dos, 0, dos.length, 0);
    if (dos.toString("ascii", 0, 2) !== "MZ") throw new Error("Portable artifact has no DOS/PE header.");
    const peOffset = dos.readUInt32LE(0x3c);
    if (peOffset < 64 || peOffset > Math.min(info.size - 4, 16 * 1024 * 1024)) {
      throw new Error(`Portable artifact has an invalid PE offset: ${peOffset}.`);
    }
    const signature = Buffer.alloc(4);
    await handle.read(signature, 0, signature.length, peOffset);
    if (!signature.equals(Buffer.from([0x50, 0x45, 0x00, 0x00]))) {
      throw new Error("Portable artifact has an invalid PE signature.");
    }
  } finally {
    await handle.close();
  }

  return { path, bytes: info.size, pe: true };
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const versionIndex = arguments_.indexOf("--expected-version");
  if (versionIndex < 0 || !arguments_[versionIndex + 1]) {
    throw new Error("--expected-version requires X.Y.Z or vX.Y.Z");
  }
  const expectedVersion = arguments_[versionIndex + 1];
  const brand = await loadBranding(projectRoot);
  const suppliedPath = arguments_.find((argument, index) =>
    !argument.startsWith("--") && index !== versionIndex + 1
  );
  const path = suppliedPath
    ? resolve(projectRoot, suppliedPath)
    : await findPortableArtifact(resolve(projectRoot, "desktop", "release"), expectedVersion, brand.artifactPrefix);
  console.log(JSON.stringify(await verifyPortableArtifact(path, expectedVersion)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
