#!/usr/bin/env node

import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn, execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractAll, listPackage } from "@electron/asar";
import { generateLicenseInventory } from "./generate-license-inventory.mjs";
import { generatePackageLicenseBundle } from "./package-license-bundle.mjs";
import { verifyPackagedClipboard } from "./verify-packaged-clipboard.mjs";
import { verifyPackagedShell } from "./verify-packaged-shell.mjs";
import { verifyBrandStartupAssets } from "./verify-brand-startup-assets.mjs";
import {
  createIsolatedProcessEnvironment,
  prepareIsolatedEnvironment,
} from "./isolated-process-env.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const suppliedWebRoot = process.argv.find((argument, index) => index > 1 && !argument.startsWith("--"));
const packagedWebRoot = resolve(
  projectRoot,
  suppliedWebRoot ?? "desktop/release/win-unpacked/resources/web",
);
const requireElectronShell = !suppliedWebRoot || process.argv.includes("--require-electron-shell");
const token = "piora-package-verification";
const fixturePackageName = "@piora/packaged-extension-verification-fixture";
const fixtureCommandName = "packaged-extension-probe";
const fixtureToolName = "packaged_extension_probe";
const fixtureSkillName = "packaged-package-probe";
const fixtureSourceRoot = join(projectRoot, "scripts", "fixtures", "packaged-pi-extension");
const backgroundAssetRoot = "themes/dream-backgrounds";
const backgroundManifestName = "manifest.json";
const expectedBackgroundCount = 37;
const safeBackgroundAsset = /^\/themes\/dream-backgrounds\/[A-Za-z0-9][A-Za-z0-9._-]*\.webp$/;
const bundledPetRelativeRoot = "companion-pets/bundled";
const generatedBuiltinPetAsset = "companion-pets/piora-bot.webp";
const nodeForgeRsaPatchedSha256 = "18ae286c1ef8e00fc6359ffe3280416946c1dfd6684c98c1c6af1590d7f7e9f4";
const expectedBundledPetIds = Object.freeze([
  "azure",
  "corgi-scout",
  "fox",
  "patchi",
  "pekka-pal.codex-pet",
  "penguin",
  "professor-hoot",
  "rabbit",
  "shadow-kit",
]);
const packagedRuntimeArchive = join(packagedWebRoot, "runtime.asar");
const execFileAsync = promisify(execFile);
let activeServerStderr = "";

export function verifyPackagedCoreTools(tools) {
  const required = ["browser", "harmony_control", "piora_room"];
  const optional = ["computer_control"];
  const inspect = (name) => {
    const tool = tools.find((entry) => entry.name === name);
    return { name, loaded: Boolean(tool), active: tool?.active === true };
  };
  const core = required.map(inspect);
  if (core.some((tool) => !tool.loaded)) throw new Error(`Packaged first-party tools failed to load: ${JSON.stringify(core)}`);
  if (core.some((tool) => tool.active !== (
    tool.name === "browser" || tool.name === "harmony_control"
  ))) {
    throw new Error(`Packaged first-party tools do not match the compact coding preset: ${JSON.stringify(core)}`);
  }
  if (tools.some((tool) => tool.name.startsWith("harmony_") && tool.name !== "harmony_control")) {
    throw new Error("Packaged Harmony must register one gateway instead of legacy operation tools");
  }
  const disabled = optional.map(inspect);
  if (disabled.some((tool) => tool.loaded || tool.active)) {
    throw new Error(`Optional extensions should be disabled by default: ${JSON.stringify(disabled)}`);
  }
  return [...core, ...disabled];
}

export const forbiddenPackagedDependencies = Object.freeze([
  "@giscus/react",
  "@lobehub/ui",
  "@splinetool/runtime",
  // Playwright's optional Electron-driver path is not used by Piora's
  // Chromium-only browser extension. Shipping it would duplicate Electron's
  // complete runtime inside the portable payload.
  "electron",
  "@electron/get",
  "@electron-internal/extract-zip",
]);

export const packagedPiAiRuntimeCopies = Object.freeze([
  {
    id: "top-level",
    label: "top-level Pi AI runtime",
    relativePath: "node_modules/@earendil-works/pi-ai",
  },
  {
    id: "coding-agent-nested",
    label: "Pi coding-agent nested AI runtime",
    relativePath: "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai",
  },
]);

const requiredPaths = [
  "server.js",
  "extensions/piora-browser.ts",
  "extensions/piora-file-changes.ts",
  "extensions/piora-harmony.ts",
  ".harmony-worker/harmony/runtime/worker-entry.js",
  "extensions/piora-computer.ts",
  "lib/computer-control.ts",
  "extensions/piora-vision-agent.ts",
  "extensions/piora-automations.ts",
  "extensions/piora-user-input.ts",
  "extensions/piora-room.ts",
  "lib/team-agent-templates.ts",
  "lib/team-prompt-context.ts",
  "lib/team-run-store.ts",
  "lib/team-tool-service.ts",
  ".next/server/app/desktop-pet/page_client-reference-manifest.js",
  ".next/server/app/desktop-clipboard/page_client-reference-manifest.js",
  "node_modules/next/package.json",
  "node_modules/@modelcontextprotocol/sdk/package.json",
  "node_modules/@deveco/deveco-cli/package.json",
  "node_modules/@deveco/deveco-cli/dist/cli.js",
  "node_modules/@earendil-works/pi-agent-core/package.json",
  "node_modules/@earendil-works/pi-ai/package.json",
  "node_modules/@earendil-works/pi-coding-agent/package.json",
  "node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/package.json",
  "node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.cjs",
  "node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/dist/jiti.cjs",
  "node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/dist/babel.cjs",
  "node_modules/@earendil-works/pi-coding-agent/node_modules/@aws-sdk/client-bedrock-runtime/package.json",
  "node_modules/@earendil-works/pi-tui/package.json",
  "node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json",
  "node_modules/rrule/package.json",
  "node_modules/tslib/package.json",
  "node_modules/node-pty/package.json",
  "node_modules/hypium-driver/package.json",
  "node_modules/mediabunny/package.json",
  "node_modules/jszip/package.json",
  "node_modules/@sqlite.org/sqlite-wasm/package.json",
  "node_modules/hypium-driver/build/lib/resource/uitest_agent_v1.2.2.so",
  "node_modules/xmldom/package.json",
];

async function assertFile(path) {
  const entry = await stat(path).catch(() => undefined);
  if (!entry?.isFile()) throw new Error(`Required packaged file is missing: ${path}`);
}

async function assertRegularFile(path, description) {
  const entry = await lstat(path).catch(() => undefined);
  if (!entry || entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error(`${description} must be a regular file: ${path}`);
  }
}

async function listRegularFiles(root, description, current = root) {
  const rootEntry = await lstat(current).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (!rootEntry) {
    throw new Error(`${description} is missing: ${current}`);
  }
  if (rootEntry.isSymbolicLink()) {
    throw new Error(`${description} must not contain symbolic links: ${current}`);
  }
  if (rootEntry.isFile()) return [relative(root, current)];
  if (!rootEntry.isDirectory()) {
    throw new Error(`${description} contains an unsupported filesystem entry: ${current}`);
  }

  const files = [];
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = join(current, entry.name);
    files.push(...await listRegularFiles(root, description, entryPath));
  }
  return files;
}

/**
 * pi-ai deliberately hides provider and OAuth implementations behind
 * bundler-opaque dynamic imports. Verify both installed package copies as
 * complete, byte-identical runtime units instead of trusting Next's trace.
 */
export async function verifyPackagedPiAiRuntime(
  webRootInput,
  sourceProjectRootInput = projectRoot,
) {
  const webRoot = resolve(webRootInput);
  const sourceProjectRoot = resolve(sourceProjectRootInput);
  const copies = [];

  for (const copy of packagedPiAiRuntimeCopies) {
    const pathSegments = copy.relativePath.split("/");
    const sourcePackageRoot = join(sourceProjectRoot, ...pathSegments);
    const packagedPackageRoot = join(webRoot, ...pathSegments);
    const [sourceFiles, packagedFiles] = await Promise.all([
      listRegularFiles(sourcePackageRoot, `Source ${copy.label}`),
      listRegularFiles(packagedPackageRoot, `Packaged ${copy.label}`),
    ]);
    const normalizedSourceFiles = sourceFiles.map((path) => path.replaceAll("\\", "/")).sort();
    const normalizedPackagedFiles = packagedFiles.map((path) => path.replaceAll("\\", "/")).sort();
    if (JSON.stringify(normalizedSourceFiles) !== JSON.stringify(normalizedPackagedFiles)) {
      const sourceSet = new Set(normalizedSourceFiles);
      const packagedSet = new Set(normalizedPackagedFiles);
      const missing = normalizedSourceFiles.filter((path) => !packagedSet.has(path));
      const unexpected = normalizedPackagedFiles.filter((path) => !sourceSet.has(path));
      throw new Error(
        `Packaged ${copy.label} file set differs from source ` +
        `(missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"})`,
      );
    }

    for (const relativePath of normalizedSourceFiles) {
      const relativeSegments = relativePath.split("/");
      const [sourceBytes, packagedBytes] = await Promise.all([
        readFile(join(sourcePackageRoot, ...relativeSegments)),
        readFile(join(packagedPackageRoot, ...relativeSegments)),
      ]);
      if (!sourceBytes.equals(packagedBytes)) {
        throw new Error(`Packaged ${copy.label} file differs from source: ${relativePath}`);
      }
    }
    copies.push({ id: copy.id, fileCount: normalizedSourceFiles.length });
  }

  return {
    copyCount: copies.length,
    fileCount: copies.reduce((total, copy) => total + copy.fileCount, 0),
    copies,
  };
}

/**
 * Import every provider/API/auth module without starting a login or making a
 * network request. This catches missing transitive runtime dependencies, then
 * explicitly resolves every OAuth loader used by subscription sign-ins.
 */
export async function verifyPackagedPiAiModuleSurface(webRootInput) {
  const webRoot = resolve(webRootInput);
  const copies = [];

  // ModelRuntime is exported by pi-coding-agent, so Node resolves all built-in
  // provider execution through its shrinkwrapped nested pi-ai copy. The
  // top-level copy is still verified byte-for-byte above for direct SDK and
  // extension imports, but importing its entire optional provider surface
  // would incorrectly require dependencies that the app never resolves there.
  const providerRuntimeCopies = packagedPiAiRuntimeCopies.filter((copy) => (
    copy.id === "coding-agent-nested"
  ));
  for (const copy of providerRuntimeCopies) {
    const packageRoot = join(webRoot, ...copy.relativePath.split("/"));
    const moduleRoots = ["api", "auth", "providers"].map((directory) => (
      join(packageRoot, "dist", directory)
    ));
    const modulePaths = [];
    for (const moduleRoot of moduleRoots) {
      const relativeFiles = await listRegularFiles(moduleRoot, `Packaged ${copy.label} modules`);
      modulePaths.push(...relativeFiles
        .filter((path) => path.endsWith(".js"))
        .map((path) => join(moduleRoot, ...path.replaceAll("\\", "/").split("/"))));
    }

    for (const modulePath of modulePaths) {
      try {
        await import(pathToFileURL(modulePath).href);
      } catch (cause) {
        throw new Error(
          `Packaged ${copy.label} module failed to load: ${relative(packageRoot, modulePath)}`,
          { cause },
        );
      }
    }

    const providerCatalog = await import(pathToFileURL(join(
      packageRoot,
      "dist",
      "providers",
      "all.js",
    )).href);
    if (typeof providerCatalog.builtinProviders !== "function") {
      throw new Error(`Packaged ${copy.label} does not export builtinProviders()`);
    }
    const providers = providerCatalog.builtinProviders();
    const oauthProviderIds = providers
      .filter((provider) => provider.auth?.oauth)
      .map((provider) => provider.id)
      .sort();
    const subscriptionProviderIds = providers
      .filter((provider) => provider.auth?.oauth?.isSubscription === true)
      .map((provider) => provider.id)
      .sort();
    if (oauthProviderIds.length === 0 || subscriptionProviderIds.length === 0) {
      throw new Error(`Packaged ${copy.label} did not expose OAuth subscription providers`);
    }

    const oauthLoaders = await import(pathToFileURL(join(
      packageRoot,
      "dist",
      "auth",
      "oauth",
      "load.js",
    )).href);
    const loaderEntries = Object.entries(oauthLoaders)
      .filter(([name, value]) => /^load.*OAuth$/u.test(name) && typeof value === "function")
      .sort(([left], [right]) => left.localeCompare(right));
    if (loaderEntries.length === 0) {
      throw new Error(`Packaged ${copy.label} did not expose OAuth flow loaders`);
    }
    for (const [loaderName, load] of loaderEntries) {
      let flow;
      try {
        flow = await load({
          name: "Packaged Radius verification",
          gateway: "https://example.invalid",
        });
      } catch (cause) {
        throw new Error(`Packaged ${copy.label} OAuth loader failed: ${loaderName}`, { cause });
      }
      for (const method of ["login", "refresh", "toAuth"]) {
        if (typeof flow?.[method] !== "function") {
          throw new Error(
            `Packaged ${copy.label} OAuth loader ${loaderName} is missing ${method}()`,
          );
        }
      }
    }

    copies.push({
      id: copy.id,
      moduleCount: modulePaths.length,
      oauthProviderIds,
      subscriptionProviderIds,
      oauthLoaders: loaderEntries.map(([name]) => name),
    });
  }

  return { copyCount: copies.length, copies };
}

/**
 * Verify the final packaged theme manifest and every declared preset image
 * byte-for-byte against the reviewed source assets. This runs against the
 * copied web payload, so a stale or incomplete Electron artifact cannot pass.
 */
export async function verifyPackagedBackgroundAssets(
  webRootInput,
  sourcePublicRootInput = join(projectRoot, "public"),
) {
  const webRoot = resolve(webRootInput);
  const sourcePublicRoot = resolve(sourcePublicRootInput);
  const sourceBackgroundRoot = join(sourcePublicRoot, backgroundAssetRoot);
  const packagedBackgroundRoot = join(webRoot, "public", backgroundAssetRoot);
  const sourceManifestPath = join(sourceBackgroundRoot, backgroundManifestName);
  const packagedManifestPath = join(packagedBackgroundRoot, backgroundManifestName);

  await assertRegularFile(sourceManifestPath, "Source background manifest");
  await assertRegularFile(packagedManifestPath, "Packaged background manifest");
  const [sourceManifestBytes, packagedManifestBytes] = await Promise.all([
    readFile(sourceManifestPath),
    readFile(packagedManifestPath),
  ]);
  if (!sourceManifestBytes.equals(packagedManifestBytes)) {
    throw new Error("Packaged background manifest differs from the source manifest");
  }

  let manifest;
  try {
    manifest = JSON.parse(sourceManifestBytes.toString("utf8"));
  } catch (error) {
    throw new Error("Source background manifest is not valid JSON", { cause: error });
  }
  if (manifest?.artworkStatus !== "complete" || !Array.isArray(manifest.presets)) {
    throw new Error("Source background manifest must declare a complete presets array");
  }
  if (manifest.presets.length !== expectedBackgroundCount) {
    throw new Error(
      `Source background manifest must declare exactly ${expectedBackgroundCount} presets`,
    );
  }

  const presetIds = new Set();
  const assetNames = new Set();
  for (const preset of manifest.presets) {
    if (typeof preset?.id !== "string" || !preset.id || presetIds.has(preset.id)) {
      throw new Error("Source background manifest contains a missing or duplicate preset id");
    }
    presetIds.add(preset.id);
    if (preset.artworkStatus !== "available" || !safeBackgroundAsset.test(preset.asset)) {
      throw new Error(`Background preset ${preset.id} does not reference a safe available WebP asset`);
    }
    const assetName = preset.asset.slice("/themes/dream-backgrounds/".length);
    if (assetNames.has(assetName)) {
      throw new Error(`Source background manifest contains a duplicate asset: ${assetName}`);
    }
    assetNames.add(assetName);
    const sourceAssetPath = join(sourceBackgroundRoot, assetName);
    const packagedAssetPath = join(packagedBackgroundRoot, assetName);
    await assertRegularFile(sourceAssetPath, "Source background asset");
    await assertRegularFile(packagedAssetPath, "Packaged background asset");
    const [sourceBytes, packagedBytes] = await Promise.all([
      readFile(sourceAssetPath),
      readFile(packagedAssetPath),
    ]);
    if (!sourceBytes.equals(packagedBytes)) {
      throw new Error(`Packaged background asset differs from source: ${assetName}`);
    }
  }

  const packagedEntries = await readdir(packagedBackgroundRoot, { withFileTypes: true });
  for (const entry of packagedEntries) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Packaged background directory must not contain symlinks: ${entry.name}`);
    }
  }
  const packagedWebpNames = packagedEntries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".webp"))
    .map((entry) => entry.name)
    .sort();
  const expectedWebpNames = [...assetNames].sort();
  if (JSON.stringify(packagedWebpNames) !== JSON.stringify(expectedWebpNames)) {
    throw new Error(
      `Packaged background WebP set differs from the ${expectedBackgroundCount} manifest assets`,
    );
  }

  return { backgroundCount: expectedBackgroundCount };
}

export async function verifyPackagedCompanionAssets(
  webRootInput,
  sourcePublicRootInput = join(projectRoot, "public"),
) {
  const webRoot = resolve(webRootInput);
  const sourcePublicRoot = resolve(sourcePublicRootInput);
  const sourcePetRoot = join(sourcePublicRoot, bundledPetRelativeRoot);
  const packagedPetRoot = join(webRoot, "public", bundledPetRelativeRoot);
  const sourceBuiltinArt = join(sourcePublicRoot, generatedBuiltinPetAsset);
  const packagedBuiltinArt = join(webRoot, "public", generatedBuiltinPetAsset);

  await assertRegularFile(sourceBuiltinArt, "Source built-in companion artwork");
  await assertRegularFile(packagedBuiltinArt, "Packaged built-in companion artwork");
  const [sourceBuiltinBytes, packagedBuiltinBytes] = await Promise.all([
    readFile(sourceBuiltinArt),
    readFile(packagedBuiltinArt),
  ]);
  if (!sourceBuiltinBytes.equals(packagedBuiltinBytes)) {
    throw new Error("Packaged built-in companion artwork differs from source");
  }

  const [sourceEntries, packagedEntries] = await Promise.all([
    readdir(sourcePetRoot, { withFileTypes: true }),
    readdir(packagedPetRoot, { withFileTypes: true }),
  ]);
  for (const entry of [...sourceEntries, ...packagedEntries]) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Bundled companion directory must not contain symlinks: ${entry.name}`);
    }
  }
  const sourcePetIds = sourceEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const packagedPetIds = packagedEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const expectedIds = [...expectedBundledPetIds].sort();
  if (JSON.stringify(sourcePetIds) !== JSON.stringify(expectedIds)) {
    throw new Error(`Source bundled companion set must contain exactly ${expectedIds.length} reviewed pets`);
  }
  if (JSON.stringify(packagedPetIds) !== JSON.stringify(expectedIds)) {
    throw new Error("Packaged bundled companion set differs from the reviewed source set");
  }

  let spritesheetBytes = 0;
  for (const petId of expectedIds) {
    const sourceManifestPath = join(sourcePetRoot, petId, "pet.json");
    const packagedManifestPath = join(packagedPetRoot, petId, "pet.json");
    await assertRegularFile(sourceManifestPath, `Source bundled pet manifest (${petId})`);
    await assertRegularFile(packagedManifestPath, `Packaged bundled pet manifest (${petId})`);
    const [sourceManifestBytes, packagedManifestBytes] = await Promise.all([
      readFile(sourceManifestPath),
      readFile(packagedManifestPath),
    ]);
    if (!sourceManifestBytes.equals(packagedManifestBytes)) {
      throw new Error(`Packaged bundled pet manifest differs from source: ${petId}`);
    }

    let manifest;
    try {
      manifest = JSON.parse(sourceManifestBytes.toString("utf8"));
    } catch (error) {
      throw new Error(`Source bundled pet manifest is not valid JSON: ${petId}`, { cause: error });
    }
    if (
      manifest?.id !== petId
      || typeof manifest?.spritesheetPath !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|webp)$/i.test(manifest.spritesheetPath)
    ) {
      throw new Error(`Bundled companion manifest is not safe or does not match its folder: ${petId}`);
    }

    const sourceSpritesheetPath = join(sourcePetRoot, petId, manifest.spritesheetPath);
    const packagedSpritesheetPath = join(packagedPetRoot, petId, manifest.spritesheetPath);
    await assertRegularFile(sourceSpritesheetPath, `Source bundled pet spritesheet (${petId})`);
    await assertRegularFile(packagedSpritesheetPath, `Packaged bundled pet spritesheet (${petId})`);
    const [sourceSpritesheetBytes, packagedSpritesheetBytes] = await Promise.all([
      readFile(sourceSpritesheetPath),
      readFile(packagedSpritesheetPath),
    ]);
    if (!sourceSpritesheetBytes.equals(packagedSpritesheetBytes)) {
      throw new Error(`Packaged bundled pet asset differs from source: ${petId}`);
    }
    spritesheetBytes += packagedSpritesheetBytes.length;
  }

  return {
    ids: expectedIds,
    petCount: expectedIds.length + 1,
    spritesheetBytes,
    builtInArtBytes: packagedBuiltinBytes.length,
  };
}

/**
 * Find forbidden packages at every nested node_modules boundary without
 * following symlinks. The walk is intentionally rooted at the packaged web
 * tree so it cannot inspect or reject dependencies from the developer checkout.
 */
export async function findForbiddenPackagedDependencies(
  root,
  dependencyNames = forbiddenPackagedDependencies,
) {
  const matches = [];
  const archivePath = join(resolve(root), "node_modules.asar");
  const archiveEntry = await stat(archivePath).catch(() => undefined);
  if (archiveEntry?.isFile()) {
    const archivePaths = new Set(
      listPackage(archivePath).map((entry) => entry.replace(/^[/\\]+/, "").replaceAll("\\", "/")),
    );
    for (const dependency of dependencyNames) {
      const match = [...archivePaths].find(
        (entry) => entry === dependency || entry.endsWith(`/node_modules/${dependency}`),
      );
      if (match) matches.push({ dependency, path: `${archivePath}!/${match}` });
    }
  }

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const entryPath = join(directory, entry.name);
      if (entry.name === "node_modules") {
        for (const dependency of dependencyNames) {
          const dependencyPath = join(entryPath, ...dependency.split("/"));
          const dependencyEntry = await stat(dependencyPath).catch(() => undefined);
          if (dependencyEntry?.isDirectory()) {
            matches.push({ dependency, path: dependencyPath });
          }
        }
      }
      await walk(entryPath);
    }
  }

  await walk(resolve(root));
  return matches;
}

async function inspectElectronShell(webRoot, required) {
  // Supplying a web root explicitly verifies the standalone payload only.
  // Pass --require-electron-shell (or use the default path) to also require
  // app.asar, the platform executable, and bundled license notices.
  if (!required) return { checked: false, executable: null, executablePath: null };

  const resourcesRoot = dirname(webRoot);
  const unpackedRoot = dirname(resourcesRoot);
  const appAsarPath = join(resourcesRoot, "app.asar");
  const isWindowsPackage = /(^|-)win(?:32)?-unpacked$/i.test(unpackedRoot.split(/[\\/]/).at(-1) ?? "");
  const trayIconPath = join(resourcesRoot, isWindowsPackage ? "tray-icon.ico" : "tray-icon.png");
  const appAsar = await stat(appAsarPath).catch(() => undefined);

  if (!appAsar?.isFile()) {
    throw new Error(`Electron app.asar is missing beside the packaged web tree: ${appAsarPath}`);
  }
  await assertFile(trayIconPath);
  await verifyBrandStartupAssets(projectRoot, resourcesRoot);
  if (isWindowsPackage) {
    const winappRoot = join(resourcesRoot, "winappcli");
    const sourceRoot = join(projectRoot, "node_modules", "@microsoft", "winappcli");
    for (const fileName of ["winapp.exe", "libHarfBuzzSharp.dll", "libSkiaSharp.dll"]) {
      const [sourcePath, packagedPath] = [join(sourceRoot, "bin", "win-x64", fileName), join(winappRoot, fileName)];
      await assertFile(packagedPath);
      const [sourceBytes, packagedBytes] = await Promise.all([readFile(sourcePath), readFile(packagedPath)]);
      if (!sourceBytes.equals(packagedBytes)) throw new Error(`Packaged winapp CLI file differs from locked dependency: ${fileName}`);
    }
    const [sourceLicense, packagedLicense] = await Promise.all([
      readFile(join(sourceRoot, "LICENSE")), readFile(join(resourcesRoot, "licenses", "winappcli-LICENSE")),
    ]);
    if (!sourceLicense.equals(packagedLicense)) throw new Error("Packaged winapp CLI license differs from locked dependency");
    const options = { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024, env: { ...process.env, WINAPP_CLI_TELEMETRY_OPTOUT: "1" } };
    const { stdout: version } = await execFileAsync(join(winappRoot, "winapp.exe"), ["--version"], options);
    if (version.trim().split(/\s+/).at(-1) !== "0.7.0") throw new Error(`Packaged winapp CLI version mismatch: ${version.slice(-100)}`);
    const { stdout: windows } = await execFileAsync(join(winappRoot, "winapp.exe"), ["ui", "list-windows", "--json"], options);
    if (!Array.isArray(JSON.parse(windows))) throw new Error("Packaged winapp CLI could not list Windows windows");
  }

  await generateLicenseInventory({ projectRoot, check: true });
  for (const fileName of ["LICENSE", "NOTICE", "THIRD_PARTY_LICENSES.md"]) {
    const sourcePath = join(projectRoot, fileName);
    const packagedPath = join(resourcesRoot, "licenses", fileName);
    await assertFile(packagedPath);
    const [sourceBytes, packagedBytes] = await Promise.all([
      readFile(sourcePath),
      readFile(packagedPath),
    ]);
    if (!sourceBytes.equals(packagedBytes)) {
      throw new Error(`Packaged project license material is stale or modified: ${fileName}`);
    }
  }
  const codexAttributionRoot = join(projectRoot, "third_party", "openai-codex");
  const packagedCodexAttributionRoot = join(resourcesRoot, "licenses", "openai-codex");
  for (const fileName of ["LICENSE", "NOTICE", "SOURCE.md"]) {
    const sourcePath = join(codexAttributionRoot, fileName);
    const packagedPath = join(packagedCodexAttributionRoot, fileName);
    await assertFile(sourcePath);
    await assertFile(packagedPath);
    const [sourceBytes, packagedBytes] = await Promise.all([
      readFile(sourcePath),
      readFile(packagedPath),
    ]);
    if (!sourceBytes.equals(packagedBytes)) {
      throw new Error(`Packaged OpenAI Codex attribution is stale or modified: ${fileName}`);
    }
  }
  const openPetsAttributionRoot = join(projectRoot, "third_party", "openpets");
  const packagedOpenPetsAttributionRoot = join(resourcesRoot, "licenses", "openpets");
  for (const fileName of ["LICENSE", "SOURCE.md"]) {
    const sourcePath = join(openPetsAttributionRoot, fileName);
    const packagedPath = join(packagedOpenPetsAttributionRoot, fileName);
    await assertFile(sourcePath);
    await assertFile(packagedPath);
    const [sourceBytes, packagedBytes] = await Promise.all([
      readFile(sourcePath),
      readFile(packagedPath),
    ]);
    if (!sourceBytes.equals(packagedBytes)) {
      throw new Error(`Packaged OpenPets attribution is stale or modified: ${fileName}`);
    }
  }
  for (const fileName of ["LICENSE", "SOURCE.md"]) {
    const source = await readFile(join(projectRoot, "third_party", "mediabunny", fileName));
    const packaged = await readFile(join(resourcesRoot, "licenses", "mediabunny", fileName));
    if (!source.equals(packaged)) throw new Error(`Packaged Mediabunny attribution is stale: ${fileName}`);
  }
  const mediaSource = await readFile(join(projectRoot, "node_modules", "mediabunny", "src", "index.ts"));
  if (!mediaSource.equals(await readFile(join(resourcesRoot, "licenses", "mediabunny", "source", "index.ts")))) throw new Error("Packaged MPL source is missing or stale");
  for (const licensePath of [
    join(unpackedRoot, "LICENSE.electron.txt"),
    join(unpackedRoot, "LICENSES.chromium.html"),
  ]) {
    await assertFile(licensePath);
  }

  const packageLicenses = await generatePackageLicenseBundle({
    webRoot,
    outputRoot: join(resourcesRoot, "licenses"),
    check: true,
  });

  const executableCandidates = (await readdir(unpackedRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && (isWindowsPackage ? entry.name.toLowerCase().endsWith(".exe") : true))
    .map((entry) => entry.name);
  const expectedExecutable = isWindowsPackage ? "piora.exe" : "piora";
  const executable = executableCandidates.find((name) => name.toLowerCase() === expectedExecutable);
  if (!executable) {
    throw new Error(`The packaged Piora application executable was not found in ${unpackedRoot}`);
  }
  const clipboard = isWindowsPackage ? await verifyPackagedClipboard(unpackedRoot) : null;

  return {
    checked: true,
    executable,
    executablePath: join(unpackedRoot, executable),
    packageLicenses,
    clipboard,
  };
}

async function fetchJson(origin, path, init = {}) {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "X-Pi-Desktop-Token": token,
      ...init.headers,
    },
  });
  const responseText = await response.text();
  let body;
  try {
    body = JSON.parse(responseText);
  } catch {
    body = { error: responseText || "Response did not contain JSON" };
  }
  if (!response.ok) {
    throw new Error(
      `${path} returned HTTP ${response.status}: ${JSON.stringify(body)}` +
      (activeServerStderr ? `\nPackaged server stderr:\n${activeServerStderr}` : ""),
    );
  }
  return { response, body };
}

async function postJson(origin, path, body) {
  return fetchJson(origin, path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify(body),
  });
}

async function patchJson(origin, path, body) {
  return fetchJson(origin, path, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify(body),
  });
}

function requireArrayEntry(items, predicate, description) {
  const match = items.find(predicate);
  if (!match) throw new Error(`Packaged Pi capability was not discovered: ${description}`);
  return match;
}

async function allocatePort() {
  return new Promise((resolvePort, rejectPort) => {
    const socket = createServer();
    socket.unref();
    socket.once("error", rejectPort);
    socket.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = socket.address();
      if (!address || typeof address === "string") {
        socket.close();
        rejectPort(new Error("Unable to allocate a verification port"));
        return;
      }
      socket.close((error) => error ? rejectPort(error) : resolvePort(address.port));
    });
  });
}

async function waitForHealth(origin, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/health`, {
        headers: { "X-Pi-Desktop-Token": token },
      });
      if (response.ok) return response;
      lastError = new Error(`Health endpoint returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  }
  throw new Error("Packaged server did not become healthy", { cause: lastError });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((resolveDelay) => setTimeout(() => resolveDelay(false), 3_000)),
  ]);
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      exited,
      new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000)),
    ]);
  }
}

export async function verifyPackagedBundledDependencies(runtimeWebRoot) {
  const patchedBundledDependencies = [
    { name: "brace-expansion", version: "5.0.12" },
    { name: "undici", version: "8.11.2" },
  ];
  for (const expected of patchedBundledDependencies) {
    const manifestPath = join(runtimeWebRoot, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", expected.name, "package.json");
    await assertFile(manifestPath);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest?.name !== expected.name || manifest?.version !== expected.version) {
      throw new Error(`Packaged Pi runtime must contain the reviewed ${expected.name}@${expected.version}.`);
    }
  }
  const nodeForgeRoot = join(runtimeWebRoot, "node_modules", "node-forge");
  const nodeForgeManifestPath = join(nodeForgeRoot, "package.json");
  const nodeForgeRsaPath = join(nodeForgeRoot, "lib", "rsa.js");
  await Promise.all([assertFile(nodeForgeManifestPath), assertFile(nodeForgeRsaPath)]);
  const [nodeForgeManifest, nodeForgeRsa] = await Promise.all([
    readFile(nodeForgeManifestPath, "utf8").then(JSON.parse),
    readFile(nodeForgeRsaPath),
  ]);
  const nodeForgeRsaSha256 = createHash("sha256").update(nodeForgeRsa).digest("hex");
  if (nodeForgeManifest?.name !== "node-forge" || nodeForgeManifest?.version !== "1.4.0"
    || nodeForgeRsaSha256 !== nodeForgeRsaPatchedSha256) {
    throw new Error("Packaged runtime must contain the reviewed node-forge DigestAlgorithm patch.");
  }
  return patchedBundledDependencies;
}

export async function verifyPackagedHarmonyHapPreview(runtimeWebRoot) {
  const probe = join(runtimeWebRoot, ".piora-hap-preview-smoke.cjs");
  const fixture = join(runtimeWebRoot, ".piora-hap-preview-fixture.hap");
  await writeFile(probe, `
const { createRequire } = require("node:module");
const { createHash } = require("node:crypto");
const { readFile, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
(async () => {
  const requireFromPi = createRequire(join(__dirname, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"));
  const { createJiti } = requireFromPi("jiti");
  const { previewHapArtifact } = await createJiti(__filename, { fsCache: false, moduleCache: false })
    .import("./lib/harmony/runtime/hap-preview.ts");
  const JSZip = require("jszip");
  const zip = new JSZip();
  zip.file("module.json", JSON.stringify({
    app: { bundleName: "dev.piora.packagedpreview", versionName: "1.0", versionCode: 7 },
    module: { name: "entry", type: "entry", deviceTypes: ["phone"], abilities: [{ name: "PreviewAbility" }] },
  }));
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const path = join(__dirname, ".piora-hap-preview-fixture.hap");
  await writeFile(path, bytes, { flag: "wx" });
  const preview = await previewHapArtifact(path);
  process.stdout.write(JSON.stringify({
    preview, originalSha256: createHash("sha256").update(bytes).digest("hex"),
    unchanged: bytes.equals(await readFile(path)),
    jitiPath: requireFromPi.resolve("jiti"),
    jszipPath: require.resolve("jszip"),
    pakoPath: createRequire(require.resolve("jszip")).resolve("pako"),
  }));
})().catch(error => { console.error(error); process.exitCode = 1; });
`, { flag: "wx", mode: 0o600 });
  try {
    const { stdout } = await execFileAsync(process.execPath, [probe], {
      cwd: runtimeWebRoot, timeout: 30000, maxBuffer: 1024 * 1024,
      env: { ...process.env, NODE_PATH: "" },
    });
    const result = JSON.parse(stdout.trim());
    for (const dependencyPath of [result.jitiPath, result.jszipPath, result.pakoPath]) {
      const path = relative(runtimeWebRoot, dependencyPath);
      if (!path || path === ".." || path.startsWith("../") || path.startsWith("..\\") || isAbsolute(path)) {
        throw new Error("Packaged HAP preview resolved a dependency outside its runtime");
      }
    }
    const preview = result.preview;
    if (preview?.bundleName !== "dev.piora.packagedpreview" || preview.versionCode !== 7
      || preview.moduleName !== "entry" || preview.signature !== "unverified"
      || preview.sha256 !== result.originalSha256 || result.unchanged !== true) {
      throw new Error("Packaged HAP preview failed compressed metadata or read-only verification");
    }
    return { bundleName: preview.bundleName, versionCode: preview.versionCode, compressed: true, unchanged: true };
  } finally {
    await rm(probe, { force: true });
    await rm(fixture, { force: true });
  }
}

async function main() {
  await assertFile(packagedRuntimeArchive);
  await assertFile(join(packagedWebRoot, "server.js"));
  await assertFile(join(dirname(packagedWebRoot), "harmony-tools", "PioraHapSigner.java"));
  for (const relativePath of [
    "build-profile.json5",
    "oh-package.json5",
    "hvigorfile.ts",
    "hvigor/hvigor-config.json5",
    "AppScope/app.json5",
    "entry/build-profile.json5",
    "entry/oh-package.json5",
    "entry/hvigorfile.ts",
    "entry/src/main/module.json5",
  ]) {
    await assertFile(join(dirname(packagedWebRoot), "harmony-tools", "signing-project", relativePath));
  }
  const packagedWebEntries = (await readdir(packagedWebRoot)).sort();
  if (JSON.stringify(packagedWebEntries) !== JSON.stringify(["runtime.asar", "runtime.asar.unpacked", "server.js"])) {
    throw new Error(`Packaged web container must contain the launcher, runtime archive and native sidecar: ${packagedWebEntries.join(", ")}`);
  }
  await assertFile(join(`${packagedRuntimeArchive}.unpacked`, "node_modules", "node-pty", "package.json"));
  for (const name of ["store-worker.cjs", "history-import.cjs", "integration.ps1", "integration.bash", "integration.zsh"]) {
    await assertFile(join(`${packagedRuntimeArchive}.unpacked`, "lib", "shell", "runtime", name));
  }
  await assertFile(join(`${packagedRuntimeArchive}.unpacked`, "lib", "harmony", "runtime", "sqlite-inspector.cjs"));
  await assertFile(join(`${packagedRuntimeArchive}.unpacked`, "lib", "harmony", "runtime", "sqlite-error-location.cjs"));
  for (const asset of ["node.mjs", "sqlite-wasm/jswasm/sqlite3-node.mjs", "sqlite-wasm/jswasm/sqlite3.wasm"]) {
    await assertFile(join(`${packagedRuntimeArchive}.unpacked`, "node_modules", "@sqlite.org", "sqlite-wasm", asset));
  }
  const launcherSource = await readFile(join(packagedWebRoot, "server.js"), "utf8");
  if (
    !launcherSource.includes("const dir = path.join(__dirname, 'runtime.asar')")
    || !launcherSource.includes("process.env.PIORA_WEB_RUNTIME_ROOT")
  ) {
    throw new Error("Packaged web launcher does not point Next and Piora capabilities at runtime.asar");
  }
  const inspectionDirectory = await mkdtemp(join(tmpdir(), "piora-runtime-inspection-"));
  const runtimeWebRoot = join(inspectionDirectory, "web");
  await extractAll(packagedRuntimeArchive, runtimeWebRoot);
  try {
  for (const requiredPath of requiredPaths) {
    await assertFile(join(runtimeWebRoot, requiredPath));
  }
  const requirePackagedRuntime = createRequire(join(runtimeWebRoot, "package.json"));
  const packagedMedia = requirePackagedRuntime("mediabunny");
  if (typeof packagedMedia.Output !== "function" || typeof packagedMedia.EncodedVideoPacketSource !== "function") throw new Error("Packaged owned-recording muxer is unavailable");
  const packagedHypium = requirePackagedRuntime("hypium-driver");
  if (typeof packagedHypium?.UiDriver?.connect !== "function" || typeof packagedHypium?.BY?.text !== "function") {
    throw new Error("Packaged Hypium runtime does not expose the required UiDriver/BY API");
  }
  const packagedXmlDom = JSON.parse(await readFile(join(runtimeWebRoot, "node_modules", "xmldom", "package.json"), "utf8"));
  if (packagedXmlDom.name !== "@xmldom/xmldom" || packagedXmlDom.version !== "0.9.12") {
    throw new Error("Packaged Hypium runtime does not use the reviewed xmldom 0.9.12 override");
  }
  for (const relative of [".harmony-worker/harmony/runtime/worker-entry.js", "lib/harmony/audio/acoustic-provider.ps1", "node_modules/hypium-driver/build/lib/resource/uitest_agent_v1.2.2.so"]) {
    await assertFile(join(`${packagedRuntimeArchive}.unpacked`, relative));
  }
  const packagedPiAiRuntime = await verifyPackagedPiAiRuntime(runtimeWebRoot);
  const packagedPiAiModules = await verifyPackagedPiAiModuleSurface(runtimeWebRoot);
  const patchedBundledDependencies = await verifyPackagedBundledDependencies(runtimeWebRoot);
  const harmonyHapPreview = await verifyPackagedHarmonyHapPreview(runtimeWebRoot);
  const looseNodeModules = await stat(join(packagedWebRoot, "node_modules")).catch(() => undefined);
  if (looseNodeModules) {
    throw new Error("Packaged web dependencies must be archived; loose node_modules would regress portable startup");
  }
  await assertFile(join(fixtureSourceRoot, "package.json"));
  await assertFile(join(fixtureSourceRoot, "extensions", "package-probe.js"));
  await assertFile(join(fixtureSourceRoot, "skills", "package-probe", "SKILL.md"));
  const packagedBackgrounds = await verifyPackagedBackgroundAssets(runtimeWebRoot);
  const packagedCompanion = await verifyPackagedCompanionAssets(runtimeWebRoot);

  const electronShell = await inspectElectronShell(packagedWebRoot, requireElectronShell);
  const forbiddenDependencyCopies = await findForbiddenPackagedDependencies(runtimeWebRoot);
  if (forbiddenDependencyCopies.length > 0) {
    throw new Error(
      `Packaged output contains development-only dependencies:\n${forbiddenDependencyCopies
        .map(({ dependency, path }) => `- ${dependency}: ${path}`)
        .join("\n")}`,
    );
  }

  const temporaryRoot = resolve(tmpdir());
  const temporaryDirectory = await mkdtemp(join(temporaryRoot, "piora-package-"));
  const temporaryRelativePath = relative(temporaryRoot, temporaryDirectory);
  if (
    !temporaryRelativePath
    || temporaryRelativePath === ".."
    || temporaryRelativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    || isAbsolute(temporaryRelativePath)
  ) {
    throw new Error(`Refusing to use an unsafe verification directory: ${temporaryDirectory}`);
  }

  const isolatedWebRoot = join(temporaryDirectory, "web");
  let child;
  let stderr = "";
  try {
    await prepareIsolatedEnvironment(temporaryDirectory);
    await cp(packagedWebRoot, isolatedWebRoot, {
      recursive: true,
      dereference: true,
      force: true,
    });
    if (process.platform === "win32") {
      const { verifyStagedPortableExtractor } = await import("./stage-portable-extractor.mjs");
      await verifyStagedPortableExtractor(join(dirname(packagedWebRoot), "portable-extractor"));
      const { verifyPayload } = createRequire(import.meta.url)("./portable-payload.cjs");
      const expectedVersion = JSON.parse(await readFile(join(projectRoot, "desktop/package.json"), "utf8")).version;
      await verifyPayload(dirname(dirname(packagedWebRoot)), join(projectRoot, "desktop/build/portable-payload-x64.json"), expectedVersion);
      const { verifyStagedPowerShell } = await import("./stage-powershell.mjs");
      const shellRoot = join(temporaryDirectory, "powershell");
      await cp(join(dirname(packagedWebRoot), "powershell"), shellRoot, { recursive: true });
      await verifyStagedPowerShell(shellRoot);
      const { verifyStagedSpeech } = await import("./stage-speech.mjs");
      const speechRoot = join(temporaryDirectory, "speech");
      await cp(join(dirname(packagedWebRoot), "speech"), speechRoot, { recursive: true });
      await verifyStagedSpeech(speechRoot);
    }
    const isolatedAgentDir = join(temporaryDirectory, "agent");
    const isolatedHomeDir = join(temporaryDirectory, "home");
    const isolatedProjectDir = join(temporaryDirectory, "project");
    const isolatedFixturePackage = join(temporaryDirectory, "external-pi-package");
    const extensionMarker = join(temporaryDirectory, "extension-loaded.marker");
    await Promise.all([
      mkdir(isolatedAgentDir, { recursive: true }),
      mkdir(isolatedHomeDir, { recursive: true }),
      mkdir(isolatedProjectDir, { recursive: true }),
    ]);
    await cp(fixtureSourceRoot, isolatedFixturePackage, {
      recursive: true,
      dereference: true,
      force: true,
    });
    await writeFile(
      join(isolatedAgentDir, "settings.json"),
      `${JSON.stringify({
        enableSkillCommands: true,
        packages: [isolatedFixturePackage],
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(join(isolatedProjectDir, "README.md"), "# Package verification project\n", "utf8");

    const port = await allocatePort();
    const origin = `http://127.0.0.1:${port}`;
    const fixtureRuntimeExecutable = electronShell.executablePath ?? process.execPath;
    const fixtureRuntime = electronShell.executablePath
      ? "packaged-electron-run-as-node"
      : "host-node";
    child = spawn(fixtureRuntimeExecutable, ["server.js"], {
      cwd: isolatedWebRoot,
      env: createIsolatedProcessEnvironment(temporaryDirectory, {
        ...(electronShell.executablePath ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        HOSTNAME: "127.0.0.1",
        PORT: String(port),
        NODE_ENV: "production",
        NODE_PATH: join(isolatedWebRoot, "runtime.asar", "node_modules"),
        NEXT_TELEMETRY_DISABLED: "1",
        HOME: isolatedHomeDir,
        USERPROFILE: isolatedHomeDir,
        PIORA_HOME: isolatedHomeDir,
        PI_CODING_AGENT_DIR: isolatedAgentDir,
        PI_PACKAGE_VERIFY_MARKER: extensionMarker,
        PI_WEB_ALLOWED_HOSTS: "127.0.0.1",
        PI_WEB_HOSTNAME: "127.0.0.1",
        PI_WEB_NO_OPEN: "1",
        PI_WEB_PASSWORD: "",
        PI_DESKTOP_TOKEN: token,
      }),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stderr = (stderr + `[stdout] ${chunk}`).slice(-16_384);
      activeServerStderr = stderr;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-16_384);
      activeServerStderr = stderr;
    });

    const earlyExit = new Promise((_, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", (code, signal) => {
        rejectExit(new Error(
          `Packaged server exited early (code=${String(code)}, signal=${String(signal)})\n${stderr}`,
        ));
      });
    });
    await Promise.race([waitForHealth(origin, 30_000), earlyExit]);

    const unauthorized = await fetch(`${origin}/api/health`);
    if (unauthorized.status !== 403) {
      throw new Error(`Health endpoint without a desktop token returned ${unauthorized.status}`);
    }
    const rootResponse = await fetch(`${origin}/`, {
      headers: { "X-Pi-Desktop-Token": token },
    });
    if (!rootResponse.ok) throw new Error(`Packaged root page returned ${rootResponse.status}`);
    const companionPageResponse = await fetch(`${origin}/desktop-pet`, {
      headers: { "X-Pi-Desktop-Token": token },
    });
    if (!companionPageResponse.ok) {
      throw new Error(`Packaged companion page returned ${companionPageResponse.status}`);
    }
    if (process.platform === "win32") {
      const headers = { "X-Pi-Desktop-Token": token };
      const speech = await fetch(`${origin}/api/speech/settings`, { headers }).then(response => response.json());
      if (!speech.installed || !speech.bundled) throw new Error("Packaged offline speech is not discoverable");
      const enabled = await fetch(`${origin}/api/speech/settings`, {
        method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ enabled: true }),
      });
      if (!enabled.ok) throw new Error("Unable to enable bundled offline speech");
      const { createJiti } = await import("jiti");
      const { encodePcm16Wav } = await createJiti(import.meta.url).import("../lib/voice-audio.ts");
      const samples = Float32Array.from({ length: 8_000 }, (_, index) => Math.sin(index * 0.1) * 0.05);
      const decoded = await fetch(`${origin}/api/speech/transcribe?language=zh`, {
        method: "POST", headers: { ...headers, "content-type": "audio/wav" }, body: encodePcm16Wav(samples), signal: AbortSignal.timeout(60_000),
      });
      if (!decoded.ok || typeof (await decoded.json()).text !== "string") throw new Error("Packaged offline speech inference failed");
    }
    const clipboardPageStatuses = {};
    for (const surface of ["quick", "shelf"]) {
      const response = await fetch(`${origin}/desktop-clipboard?surface=${surface}`, { headers: { "X-Pi-Desktop-Token": token } });
      if (!response.ok) throw new Error(`Packaged clipboard ${surface} page returned ${response.status}`);
      clipboardPageStatuses[surface] = response.status;
    }

    const { response: newSessionResponse, body: newSession } = await postJson(
      origin,
      "/api/agent/new",
      { cwd: isolatedProjectDir, type: "ensure_session" },
    );
    if (typeof newSession.sessionId !== "string" || !newSession.sessionId) {
      throw new Error(`Packaged agent session did not return a session id: ${JSON.stringify(newSession)}`);
    }

    await assertFile(extensionMarker);
    let smartShell;
    try {
      smartShell = await verifyPackagedShell({ origin, cwd: isolatedProjectDir, token, bundledPowerShell: process.platform === "win32" ? join(temporaryDirectory, "powershell", "pwsh.exe") : undefined });
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.stack ?? error.message : String(error)}` +
        (activeServerStderr ? `\nPackaged server output:\n${activeServerStderr}` : ""),
      );
    }

    const { body: plugins } = await fetchJson(
      origin,
      `/api/plugins?cwd=${encodeURIComponent(isolatedProjectDir)}`,
    );
    const fixturePackage = requireArrayEntry(
      Array.isArray(plugins.packages) ? plugins.packages : [],
      (entry) => entry.packageName === fixturePackageName,
      `Pi package ${fixturePackageName}`,
    );
    if (fixturePackage.status !== "loaded") {
      throw new Error(`Fixture Pi package was discovered but is not loaded: ${JSON.stringify(fixturePackage)}`);
    }
    if (fixturePackage.counts?.extensions !== 1 || fixturePackage.counts?.skills !== 1) {
      throw new Error(`Fixture Pi package resource counts are incorrect: ${JSON.stringify(fixturePackage.counts)}`);
    }

    const { body: skills } = await fetchJson(
      origin,
      `/api/skills?cwd=${encodeURIComponent(isolatedProjectDir)}`,
    );
    requireArrayEntry(
      Array.isArray(skills.skills) ? skills.skills : [],
      (entry) => entry.name === fixtureSkillName,
      `Pi package skill ${fixtureSkillName}`,
    );

    const { body: extensionInventory } = await fetchJson(
      origin,
      `/api/extensions?cwd=${encodeURIComponent(isolatedProjectDir)}`,
    );
    const extensionDiagnostics = Array.isArray(extensionInventory.diagnostics)
      ? extensionInventory.diagnostics
      : [];
    if (extensionDiagnostics.length > 0) {
      throw new Error(`Packaged first-party extensions failed to load: ${JSON.stringify(extensionDiagnostics)}`);
    }

    const agentPath = `/api/agent/${encodeURIComponent(newSession.sessionId)}`;
    const { body: commandResult } = await postJson(origin, agentPath, { type: "get_commands" });
    const commands = Array.isArray(commandResult.data?.commands) ? commandResult.data.commands : [];
    requireArrayEntry(
      commands,
      (entry) => entry.name === fixtureCommandName && entry.source === "extension",
      `extension command /${fixtureCommandName}`,
    );
    requireArrayEntry(
      commands,
      (entry) => entry.name === `skill:${fixtureSkillName}` && entry.source === "skill",
      `skill command /skill:${fixtureSkillName}`,
    );

    const { body: initialToolResult } = await postJson(origin, agentPath, { type: "get_tools" });
    const initialTools = Array.isArray(initialToolResult.data) ? initialToolResult.data : [];
    const initialFixtureTool = requireArrayEntry(
      initialTools,
      (entry) => entry.name === fixtureToolName,
      `extension tool ${fixtureToolName}`,
    );
    if (initialFixtureTool.active) {
      throw new Error(`Fixture extension tool must respect the default compact coding preset: ${JSON.stringify(initialFixtureTool)}`);
    }

    const coreExtensionTools = verifyPackagedCoreTools(initialTools);

    const { body: projectTools } = await fetchJson(
      origin,
      `/api/project-tools?cwd=${encodeURIComponent(isolatedProjectDir)}`,
    );
    const capabilities = projectTools.capabilities;
    const capabilityItems = Array.isArray(capabilities?.items) ? capabilities.items : [];
    const fixtureCapability = requireArrayEntry(
      capabilityItems,
      (entry) => entry.id === `tool:${fixtureToolName}`,
      `project tool ${fixtureToolName}`,
    );
    if (fixtureCapability.enabled || fixtureCapability.activeToolNames?.length > 0) {
      throw new Error(`Fixture extension project tool must start disabled: ${JSON.stringify(fixtureCapability)}`);
    }
    const enabledCapabilityIds = [
      ...new Set([
        ...(Array.isArray(capabilities?.policy?.enabledCapabilityIds)
          ? capabilities.policy.enabledCapabilityIds
          : []),
        fixtureCapability.id,
      ]),
    ];
    const { body: updatedProjectTools } = await patchJson(origin, "/api/project-tools", {
      cwd: isolatedProjectDir,
      preset: "custom",
      enabledCapabilityIds,
      expectedRevision: capabilities?.policy?.revision,
    });
    if (updatedProjectTools.managed !== true || updatedProjectTools.appliedSessions !== 1) {
      throw new Error(`Project tool selection was not applied to the packaged Session: ${JSON.stringify(updatedProjectTools)}`);
    }
    const { body: activeToolResult } = await postJson(origin, agentPath, { type: "get_tools" });
    const activeTools = Array.isArray(activeToolResult.data) ? activeToolResult.data : [];
    const activeFixtureTool = requireArrayEntry(
      activeTools,
      (entry) => entry.name === fixtureToolName,
      `enabled extension tool ${fixtureToolName}`,
    );
    if (!activeFixtureTool.active) {
      throw new Error(`Fixture extension tool did not activate through project settings: ${JSON.stringify(activeFixtureTool)}`);
    }

    const pioraOwnedSubagentEntries = [...commands, ...activeTools].filter((entry) => (
      typeof entry.name === "string" && /^(?:pi[-_]?gui)[-_]?sub[-_]?agents?$/i.test(entry.name)
    ));
    if (pioraOwnedSubagentEntries.length > 0) {
      throw new Error(`Unexpected Piora-owned SubAgent capability: ${JSON.stringify(pioraOwnedSubagentEntries)}`);
    }

    console.log(JSON.stringify({
      isolated: true,
      smartShell,
      dependencyChecks: requiredPaths.length,
      packagedPiAiRuntime,
      packagedPiAiModules,
      harmonyHapPreview,
      patchedBundledDependencies: patchedBundledDependencies.map(({ name, version }) => `${name}@${version}`),
      forbiddenDependencyChecks: forbiddenPackagedDependencies.length,
      packagedBackgrounds: packagedBackgrounds.backgroundCount,
      packagedCompanion,
      electronShellChecked: electronShell.checked,
      executable: electronShell.executable,
      fixtureRuntime,
      licensedPackageCopies: electronShell.packageLicenses?.packageCount ?? null,
      uniquePackagedLicenseTexts: electronShell.packageLicenses?.uniqueLicenseTextCount ?? null,
      unauthorizedStatus: unauthorized.status,
      healthStatus: 200,
      rootStatus: rootResponse.status,
      companionPageStatus: companionPageResponse.status,
      clipboardPageStatuses,
      clipboardNative: electronShell.clipboard ?? null,
      agentSessionStatus: newSessionResponse.status,
      piPackage: fixturePackageName,
      extensionCommand: fixtureCommandName,
      extensionTool: fixtureToolName,
      extensionToolInitiallyActive: false,
      extensionToolActivatedByProjectSettings: true,
      coreExtensionTools,
      skill: fixtureSkillName,
      pioraOwnedSubagentFeatures: 0,
    }));
  } finally {
    if (child) await stopChild(child);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  } finally {
    await rm(inspectionDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
