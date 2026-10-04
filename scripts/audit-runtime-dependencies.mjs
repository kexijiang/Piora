#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE_FORGE_RSA_PATCHED_SHA256 = "18ae286c1ef8e00fc6359ffe3280416946c1dfd6684c98c1c6af1590d7f7e9f4";
const reviewedReplacements = [
  { name: "brace-expansion", lockedVersion: "5.0.9", installedVersion: "5.0.12" },
  { name: "undici", lockedVersion: "8.9.0", installedVersion: "8.11.2" },
];

async function fingerprint(directory) {
  const entries = [];
  async function visit(path, relativePath = "") {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`Audit refuses a symbolic link: ${path}`);
    if (stat.isFile()) {
      entries.push([relativePath, createHash("sha256").update(await readFile(path)).digest("hex")]);
    } else if (stat.isDirectory()) {
      entries.push([relativePath, "directory"]);
      for (const name of (await readdir(path)).sort()) {
        await visit(join(path, name), `${relativePath}/${name}`);
      }
    } else {
      throw new Error(`Audit refuses a special filesystem entry: ${path}`);
    }
  }
  await visit(directory);
  return JSON.stringify(entries);
}

// npm audit uses the pre-postinstall lock. Audit a temporary derived lock only
// after checking both the reviewed identities and every byte of each replacement.
// No advisory is suppressed: npm evaluates current advisories against the final
// versions, including any future advisory affecting these reviewed versions.
export async function createVerifiedAuditLock(root = projectRoot) {
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  if (lock.lockfileVersion !== 3 || !lock.packages) throw new Error("Expected npm lockfileVersion 3");
  const effectiveLock = structuredClone(lock);
  const replacements = [];
  for (const { name, lockedVersion, installedVersion } of reviewedReplacements) {
    const sourcePath = `node_modules/${name}`;
    const targetPath = `node_modules/@earendil-works/pi-coding-agent/node_modules/${name}`;
    const source = lock.packages[sourcePath];
    const target = lock.packages[targetPath];
    if (!target) continue;
    if (source?.version !== installedVersion || target.version !== lockedVersion
      || source.resolved !== `https://registry.npmjs.org/${name}/-/${name}-${installedVersion}.tgz`
      || !/^sha512-/.test(source.integrity ?? "")) {
      throw new Error(`Review the ${name} audit replacement after a lockfile change`);
    }
    const sourceDirectory = join(root, sourcePath);
    const targetDirectory = join(root, targetPath);
    for (const directory of [sourceDirectory, targetDirectory]) {
      const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (manifest.name !== name || manifest.version !== installedVersion) {
        throw new Error(`Unpatched or unexpected ${name} at ${directory}; run npm ci`);
      }
    }
    if (await fingerprint(sourceDirectory) !== await fingerprint(targetDirectory)) {
      throw new Error(`Bundled ${name} differs from its integrity-locked replacement`);
    }
    effectiveLock.packages[targetPath] = { ...source, dev: target.dev, optional: target.optional };
    replacements.push({ path: targetPath, from: lockedVersion, to: installedVersion });
  }
  const forgePath = "node_modules/node-forge";
  const forge = lock.packages[forgePath];
  if (forge?.version !== "1.4.0"
    || forge.resolved !== "https://registry.npmjs.org/node-forge/-/node-forge-1.4.0.tgz"
    || !/^sha512-/.test(forge.integrity ?? "")) {
    throw new Error("Review the node-forge audit patch after a lockfile change");
  }
  const forgeManifest = JSON.parse(await readFile(join(root, forgePath, "package.json"), "utf8"));
  const rsaBytes = await readFile(join(root, forgePath, "lib", "rsa.js"));
  const rsaSha256 = createHash("sha256").update(rsaBytes).digest("hex");
  if (forgeManifest.name !== "node-forge" || forgeManifest.version !== "1.4.0"
    || rsaSha256 !== NODE_FORGE_RSA_PATCHED_SHA256) {
    throw new Error("Installed node-forge does not contain the reviewed DigestAlgorithm patch");
  }
  // npm's advisory database can only compare package versions. The installed
  // bytes remain integrity-locked node-forge 1.4.0 plus the exact reviewed
  // postinstall patch above; represent that effective code as the next patch
  // version only in this temporary audit lock.
  effectiveLock.packages[forgePath] = { ...forge, version: "1.4.1-piora.1" };
  const nodeForgePatch = { path: forgePath, from: "1.4.0", effective: "1.4.1-piora.1", rsaSha256 };
  return { lock: effectiveLock, replacements, nodeForgePatch };
}

async function main() {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("Run this check with npm run audit:runtime");
  const { lock, replacements, nodeForgePatch } = await createVerifiedAuditLock();
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "piora-runtime-audit-"));
  try {
    const manifest = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
    delete manifest.workspaces;
    delete lock.packages[""].workspaces;
    await writeFile(join(temporaryDirectory, "package.json"), JSON.stringify(manifest));
    await writeFile(join(temporaryDirectory, "package-lock.json"), JSON.stringify(lock));
    console.log(JSON.stringify({ verifiedRuntimeReplacements: replacements, verifiedRuntimePatches: [nodeForgePatch] }));
    const result = spawnSync(process.execPath, [npmCli, "audit", "--omit=dev", "--audit-level=high",
      "--registry=https://registry.npmjs.org/", "--workspaces=false"], {
      cwd: temporaryDirectory, stdio: "inherit", windowsHide: true,
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
