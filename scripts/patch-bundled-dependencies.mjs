#!/usr/bin/env node

import { cp, lstat, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function assertInside(parent, child, label) {
  const childRelativePath = relative(parent, child);
  if (
    !childRelativePath
    || childRelativePath === ".."
    || childRelativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    || isAbsolute(childRelativePath)
  ) {
    throw new Error(`${label} escapes the expected directory: ${child}`);
  }
}

async function readPackage(path) {
  return JSON.parse(await readFile(join(path, "package.json"), "utf8"));
}

async function patchBundledPackage({
  root,
  sourceRoot,
  packageName,
  patchedVersion,
  acceptedBundledVersions,
}) {
  const modulesRoot = join(root, "node_modules");
  const sourceModulesRoot = join(sourceRoot, "node_modules");
  const source = join(sourceModulesRoot, packageName);
  const targetParent = join(
    modulesRoot,
    "@earendil-works",
    "pi-coding-agent",
    "node_modules",
  );
  const target = join(targetParent, packageName);

  assertInside(sourceModulesRoot, source, "Patch source");
  assertInside(modulesRoot, target, "Patch target");

  const [sourceEntry, targetEntry] = await Promise.all([
    lstat(source),
    lstat(target).catch((error) => error?.code === "ENOENT" ? undefined : Promise.reject(error)),
  ]);
  if (!sourceEntry.isDirectory() || sourceEntry.isSymbolicLink()) {
    throw new Error(`Expected a real directory at ${source}`);
  }
  if (!targetEntry) {
    return { patched: false, reason: "bundled-copy-absent" };
  }
  if (!targetEntry.isDirectory() || targetEntry.isSymbolicLink()) {
    throw new Error(`Refusing to replace a non-directory or symlink at ${target}`);
  }

  const [sourcePackage, targetPackage] = await Promise.all([
    readPackage(source),
    readPackage(target),
  ]);
  if (sourcePackage.name !== packageName || sourcePackage.version !== patchedVersion) {
    throw new Error(
      `Expected locked ${packageName} ${patchedVersion}, found ${sourcePackage.name}@${sourcePackage.version}`,
    );
  }
  if (
    targetPackage.name !== packageName
    || !acceptedBundledVersions.has(targetPackage.version)
  ) {
    throw new Error(
      `Refusing to replace unexpected bundled package ${targetPackage.name}@${targetPackage.version}`,
    );
  }

  const [sourceModulesRealPath, targetModulesRealPath, sourceRealPath, targetParentRealPath] = await Promise.all([
    realpath(sourceModulesRoot),
    realpath(modulesRoot),
    realpath(source),
    realpath(targetParent),
  ]);
  assertInside(sourceModulesRealPath, sourceRealPath, "Resolved patch source");
  assertInside(targetModulesRealPath, targetParentRealPath, "Resolved patch target parent");

  if (targetPackage.version === patchedVersion) {
    return { patched: false, reason: "already-patched", version: patchedVersion };
  }

  const temporaryDirectory = await mkdtemp(
    join(targetParentRealPath, `.${packageName}-patch-`),
  );
  assertInside(targetParentRealPath, temporaryDirectory, "Patch temporary directory");
  try {
    await cp(source, temporaryDirectory, {
      recursive: true,
      dereference: false,
      // mkdtemp above guarantees a fresh unique destination, so errorOnExist
      // would only reject the directory mkdtemp just created (Node >=22.15
      // honours the option and makes every patch fail with EEXIST).
      force: false,
    });
    await rm(target, { recursive: true, force: false });
    await rename(temporaryDirectory, target);
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }

  const installedPackage = await readPackage(target);
  if (installedPackage.name !== packageName || installedPackage.version !== patchedVersion) {
    throw new Error(`Bundled dependency patch verification failed at ${target}`);
  }
  return {
    patched: true,
    from: targetPackage.version,
    to: installedPackage.version,
  };
}

export async function patchBundledBraceExpansion(root = projectRoot, sourceRoot = root) {
  return patchBundledPackage({
    root,
    sourceRoot,
    packageName: "brace-expansion",
    patchedVersion: "5.0.9",
    acceptedBundledVersions: new Set(["5.0.7", "5.0.9"]),
  });
}

export async function patchBundledUndici(root = projectRoot, sourceRoot = root) {
  return patchBundledPackage({
    root,
    sourceRoot,
    packageName: "undici",
    patchedVersion: "8.9.0",
    acceptedBundledVersions: new Set(["8.5.0", "8.9.0"]),
  });
}

export async function patchElectronBuilderWorkspaceCollector(root = projectRoot) {
  const packageRoot = join(root, "node_modules", "app-builder-lib");
  const packageManifest = await readPackage(packageRoot);
  if (packageManifest.name !== "app-builder-lib" || packageManifest.version !== "26.15.3") {
    throw new Error(
      `Expected locked app-builder-lib 26.15.3, found ${packageManifest.name}@${packageManifest.version}`,
    );
  }

  const collectorPath = join(packageRoot, "out", "util", "appFileCopier.js");
  const source = await readFile(collectorPath, "utf8");
  const packageManagerFirst = "const pmApproaches = [await packager.getPackageManager(), node_module_collector_1.PM.TRAVERSAL];";
  const traversalFirst = "const pmApproaches = [node_module_collector_1.PM.TRAVERSAL, await packager.getPackageManager()];";
  if (source.includes(traversalFirst)) {
    return { patched: false, reason: "already-patched", version: packageManifest.version };
  }
  const occurrences = source.split(packageManagerFirst).length - 1;
  if (occurrences !== 1) {
    throw new Error(`Expected one electron-builder workspace collector hook, found ${occurrences}.`);
  }
  await writeFile(collectorPath, source.replace(packageManagerFirst, traversalFirst), "utf8");
  const verified = await readFile(collectorPath, "utf8");
  if (!verified.includes(traversalFirst) || verified.includes(packageManagerFirst)) {
    throw new Error("electron-builder workspace collector patch verification failed.");
  }
  return { patched: true, version: packageManifest.version };
}

export async function patchNodePtyShutdown(root = projectRoot) {
  const packageRoot = join(root, "node_modules", "node-pty");
  const manifest = await readPackage(packageRoot);
  if (manifest.version !== "1.1.0") throw new Error("Review node-pty shutdown patch when upgrading from 1.1.0");
  const file = join(packageRoot, "lib", "windowsPtyAgent.js");
  const source = await readFile(file, "utf8");
  const marker = "// Piora: drain even when a quiet ConPTY emits no final data (node-pty#887).";
  if (source.includes(marker)) return { patched: false, reason: "already-patched" };
  const before = "this._inSocket.destroy();\n                this._ptyNative.kill(this._pty, this._useConptyDll);";
  const normalized = source.replaceAll("\r\n", "\n");
  if (normalized.split(before).length !== 2) throw new Error("Unexpected node-pty shutdown implementation");
  await writeFile(file, normalized.replace(before, `${before}\n                ${marker}\n                this._conoutSocketWorker.dispose();`));
  return { patched: true, version: manifest.version };
}

async function main() {
  const patches = await Promise.all([
    patchBundledBraceExpansion().then((result) => ({ package: "brace-expansion", ...result })),
    patchBundledUndici().then((result) => ({ package: "undici", ...result })),
    patchElectronBuilderWorkspaceCollector().then((result) => ({ package: "app-builder-lib", ...result })),
    patchNodePtyShutdown().then((result) => ({ package: "node-pty", ...result })),
  ]);
  console.log(JSON.stringify({ bundledDependencyPatches: patches }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
