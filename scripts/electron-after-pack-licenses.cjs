/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder loads afterPack hooks as CommonJS. */
const { cp, lstat, mkdir, readFile, rename, rm, writeFile } = require("node:fs/promises");
const { dirname, join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

async function restorePackagedRuntimePackage(sourceWebRoot, packagedWebRoot, packageName) {
  const packageSegments = packageName.startsWith("@") ? packageName.split("/") : [packageName];
  const source = join(sourceWebRoot, "node_modules", ...packageSegments);
  const destination = join(packagedWebRoot, "node_modules", ...packageSegments);
  const sourceEntry = await lstat(source);
  if (!sourceEntry.isDirectory() || sourceEntry.isSymbolicLink()) {
    throw new Error(`Staged runtime package must be a regular directory: ${source}`);
  }
  const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  if (manifest.name !== packageName || typeof manifest.version !== "string" || !manifest.version) {
    throw new Error(`Staged runtime package has an invalid manifest: ${source}`);
  }
  await rm(destination, { recursive: true, force: true });
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: true, dereference: true });
}

module.exports = async function generatePackagedLicenses(context) {
  const scriptUrl = pathToFileURL(resolve(__dirname, "package-license-bundle.mjs")).href;
  const { generatePackageLicenseBundle } = await import(scriptUrl);
  const resourcesRoot = join(context.appOutDir, "resources");
  const webRoot = join(resourcesRoot, "web");
  if (context.electronPlatformName === "win32") {
    const { verifyStagedPowerShell } = await import("./stage-powershell.mjs");
    await verifyStagedPowerShell(join(resourcesRoot, "powershell"));
  }
  // electron-builder applies package-level `files` allowlists while traversing
  // nested node_modules, even for this extraResources tree. Hypium publishes
  // only `build/` in that allowlist, which strips the root manifest needed by
  // Node resolution and exact license/SBOM identity. Restore the already
  // validated standalone copy before scanning and archiving the final runtime.
  const stagedWebRoot = resolve(__dirname, "..", ".next", "standalone");
  await restorePackagedRuntimePackage(stagedWebRoot, webRoot, "hypium-driver");
  const result = await generatePackageLicenseBundle({
    webRoot,
    outputRoot: join(resourcesRoot, "licenses"),
  });
  console.log(
    `Generated packaged license bundle for ${result.packageCount} package copies ` +
    `(${result.uniqueLicenseTextCount} unique license texts).`,
  );

  // The portable NSIS launcher otherwise has to materialize thousands of tiny
  // files before it can show the application. Keep the complete standalone
  // runtime in one ASAR so ESM packages resolve through their normal ancestor
  // node_modules chain. A tiny external launcher points Next at the archive.
  // Licenses are generated first while the exact loose tree is inspectable.
  const runtimeArchive = join(webRoot, "runtime.asar");
  const temporaryArchive = join(resourcesRoot, `.web-runtime-${process.pid}.asar`);
  const originalServerSource = await readFile(join(webRoot, "server.js"), "utf8");
  const launcherSource = originalServerSource.replace(
    "const dir = path.join(__dirname)",
    "const dir = path.join(__dirname, 'runtime.asar');process.env.PIORA_WEB_RUNTIME_ROOT=process.env.PIORA_WEB_RUNTIME_ROOT||dir;if(process.platform==='win32')require('../powershell/bootstrap.cjs')",
  );
  if (launcherSource === originalServerSource) {
    throw new Error("Unable to create the packaged ASAR server launcher");
  }
  const { createWebRuntimeArchive } = await import(pathToFileURL(join(__dirname, "archive-web-runtime.mjs")).href);
  await rm(temporaryArchive, { force: true });
  // Keep the entire PTY package together: Windows loads sibling ConPTY DLLs
  // and starts a worker by filename, neither of which can run inside ASAR.
  await createWebRuntimeArchive(webRoot, temporaryArchive);
  const archiveEntry = await lstat(temporaryArchive);
  if (!archiveEntry.isFile() || archiveEntry.size < 1_000_000) {
    throw new Error(`Packaged web runtime archive is missing or unexpectedly small: ${temporaryArchive}`);
  }
  await rm(webRoot, { recursive: true, force: true });
  await mkdir(webRoot, { recursive: true });
  await rename(temporaryArchive, runtimeArchive);
  await rename(`${temporaryArchive}.unpacked`, `${runtimeArchive}.unpacked`);
  await writeFile(join(webRoot, "server.js"), launcherSource, "utf8");
  console.log(`Archived the packaged web runtime into runtime.asar (${archiveEntry.size} bytes).`);
};
