#!/usr/bin/env node

import { cp, lstat, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { patchBundledBraceExpansion, patchBundledUndici } from "./patch-bundled-dependencies.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nextDirectory = join(projectRoot, ".next");
const standaloneDirectory = join(nextDirectory, "standalone");
const buildIdFile = join(nextDirectory, "BUILD_ID");

const assets = [
  {
    name: "public assets",
    source: join(projectRoot, "public"),
    destination: join(standaloneDirectory, "public"),
    required: true,
    rejectSymlinks: true,
  },
  {
    name: "Next.js static assets",
    source: join(nextDirectory, "static"),
    destination: join(standaloneDirectory, ".next", "static"),
    required: true,
    rejectSymlinks: false,
  },
  {
    // Next 16's standalone trace can omit the client reference manifest for
    // this secondary App Router entry. The main page still works, but opening
    // the Electron companion window then returns 500 and crashes its renderer.
    name: "desktop companion client reference manifest",
    source: join(nextDirectory, "server", "app", "desktop-pet", "page_client-reference-manifest.js"),
    destination: join(
      standaloneDirectory,
      ".next",
      "server",
      "app",
      "desktop-pet",
      "page_client-reference-manifest.js",
    ),
    required: true,
    rejectSymlinks: true,
  },
  ...[
    ["Piora browser extension", "extensions/piora-browser.ts"],
    ["Piora file-change extension", "extensions/piora-file-changes.ts"],
    ["Piora Harmony device extension", "extensions/piora-harmony.ts"],
    ["Piora visual-agent extension", "extensions/piora-vision-agent.ts"],
    ["Piora scheduled-task extension", "extensions/piora-automations.ts"],
    ["Piora user-input extension", "extensions/piora-user-input.ts"],
    ["Optional Piora Goals extension", "extensions/piora-goal.ts"],
    ["Optional Piora Plans extension", "extensions/piora-plan.ts"],
    ["Piora collaboration-room extension", "extensions/piora-room.ts"],
    // First-party extensions execute from source at runtime and resolve their
    // relative imports through this tree. Stage the complete Piora library so
    // adding a transitive helper cannot silently break only packaged builds.
    ["Piora runtime support modules", "lib"],
  ].map(([name, relativePath]) => ({
    name,
    source: join(projectRoot, relativePath),
    destination: join(standaloneDirectory, relativePath),
    required: true,
    rejectSymlinks: true,
  })),
  {
    name: "Playwright browser runtime",
    source: join(projectRoot, "node_modules", "playwright-core"),
    destination: join(standaloneDirectory, "node_modules", "playwright-core"),
    required: true,
    rejectSymlinks: true,
  },
  ...[
    {
      name: "top-level Pi AI runtime",
      pathSegments: ["@earendil-works", "pi-ai"],
    },
    {
      // pi-coding-agent ships with its own shrinkwrapped dependency tree. Its
      // imports therefore resolve this nested copy instead of the top-level
      // package, even when both package versions currently match.
      name: "Pi coding-agent nested AI runtime",
      pathSegments: [
        "@earendil-works",
        "pi-coding-agent",
        "node_modules",
        "@earendil-works",
        "pi-ai",
      ],
    },
  ].map(({ name, pathSegments }) => ({
    // pi-ai intentionally hides OAuth and provider implementations behind
    // variable dynamic imports. Next's static output tracing cannot discover
    // those files, so stage both complete package copies as runtime units.
    name,
    source: join(projectRoot, "node_modules", ...pathSegments),
    destination: join(standaloneDirectory, "node_modules", ...pathSegments),
    required: true,
    rejectSymlinks: true,
  })),
  ...[
    // The scheduled-task extension is staged as source and loaded dynamically,
    // so Next's standalone tracer cannot discover this dependency chain.
    ["scheduled-task recurrence runtime", "rrule"],
    ["scheduled-task recurrence runtime helpers", "tslib"],
  ].map(([name, packageName]) => ({
    name,
    source: join(projectRoot, "node_modules", packageName),
    destination: join(standaloneDirectory, "node_modules", packageName),
    required: true,
    rejectSymlinks: true,
  })),
];

async function getPathType(path) {
  try {
    const entry = await stat(path);
    if (entry.isDirectory()) return "directory";
    if (entry.isFile()) return "file";
    return "other";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

function assertInside(parent, child) {
  const childRelativePath = relative(parent, child);
  if (
    childRelativePath === "" ||
    childRelativePath === ".." ||
    childRelativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(childRelativePath)
  ) {
    throw new Error(`Refusing to stage outside ${parent}: ${child}`);
  }
}

function packageNameSegments(packageName) {
  return packageName.startsWith("@") ? packageName.split("/") : [packageName];
}

async function resolveInstalledPackageRoot(packageName, fromDirectory, root) {
  let current = resolve(fromDirectory);
  const resolvedRoot = resolve(root);
  while (true) {
    const candidate = join(current, "node_modules", ...packageNameSegments(packageName));
    if ((await getPathType(join(candidate, "package.json"))) === "file") return candidate;
    if (current === resolvedRoot) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    const parentRelativePath = relative(resolvedRoot, parent);
    if (
      parentRelativePath === ".."
      || parentRelativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      || isAbsolute(parentRelativePath)
    ) {
      return undefined;
    }
    current = parent;
  }
}

/**
 * Collect complete installed package directories for runtime dependencies
 * reached from dynamically loaded source and their transitive production
 * dependency graph. Ordinary statically imported packages remain owned by
 * Next's trace.
 */
export async function collectRuntimeDependencyAssets(
  packageRoots,
  sourceProjectRoot = projectRoot,
  destinationRoot = standaloneDirectory,
) {
  const resolvedProjectRoot = resolve(sourceProjectRoot);
  const pending = packageRoots.map((path) => resolve(path));
  const visited = new Set();
  const collected = [];

  while (pending.length > 0) {
    const packageRoot = pending.shift();
    if (visited.has(packageRoot)) continue;
    const packageRelativePath = relative(resolvedProjectRoot, packageRoot);
    if (
      !packageRelativePath
      || packageRelativePath === ".."
      || packageRelativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      || isAbsolute(packageRelativePath)
    ) {
      throw new Error(`Runtime dependency is outside the project: ${packageRoot}`);
    }
    const manifestPath = join(packageRoot, "package.json");
    if ((await getPathType(manifestPath)) !== "file") {
      throw new Error(`Runtime dependency package manifest is missing: ${manifestPath}`);
    }
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (typeof manifest.name !== "string" || !manifest.name) {
      throw new Error(`Runtime dependency package name is missing: ${manifestPath}`);
    }
    visited.add(packageRoot);
    collected.push({
      name: `dynamic runtime dependency ${manifest.name}`,
      source: packageRoot,
      destination: join(destinationRoot, packageRelativePath),
      required: true,
      rejectSymlinks: true,
      omitNodeModuleBins: true,
    });

    const requiredPeers = Object.fromEntries(
      Object.entries(manifest.peerDependencies ?? {}).filter(([name]) => (
        manifest.peerDependenciesMeta?.[name]?.optional !== true
      )),
    );
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...requiredPeers,
    };
    for (const dependencyName of Object.keys(dependencies).sort()) {
      const dependencyRoot = await resolveInstalledPackageRoot(
        dependencyName,
        packageRoot,
        resolvedProjectRoot,
      );
      if (!dependencyRoot) {
        if (manifest.optionalDependencies?.[dependencyName] !== undefined) continue;
        throw new Error(
          `Runtime dependency ${manifest.name} cannot resolve required package ${dependencyName}`,
        );
      }
      pending.push(dependencyRoot);
    }
  }

  return collected.sort((left, right) => left.destination.localeCompare(right.destination));
}

export async function findSymbolicLinks(root) {
  const rootEntry = await lstat(root).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (!rootEntry) return [];
  if (rootEntry.isSymbolicLink()) return [resolve(root)];
  if (!rootEntry.isDirectory()) return [];

  const links = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      links.push(entryPath);
    } else if (entry.isDirectory()) {
      links.push(...await findSymbolicLinks(entryPath));
    }
  }
  return links;
}

export function isNodeModulesBinPath(root, candidate) {
  const segments = relative(root, candidate).split(/[\\/]+/);
  return segments.some((segment, index) => segment === "node_modules" && segments[index + 1] === ".bin");
}

async function isNonEmptyDirectory(path) {
  const type = await getPathType(path);
  if (type !== "directory") return false;
  return (await readdir(path)).length > 0;
}

async function main() {
  // A production `next build` always writes .next/BUILD_ID. A dev-server or
  // interrupted build leaves it missing; staging such a tree produces a
  // portable EXE whose HTML loads but whose JS/CSS 404 — a black window.
  // Fail fast instead of silently packaging a broken app.
  if ((await getPathType(buildIdFile)) !== "file") {
    throw new Error(
      `Production build marker .next/BUILD_ID was not found. ` +
      `The .next directory looks polluted (a dev server or failed build). ` +
      `Stop npm run dev, delete .next, then run \`next build\` again.`,
    );
  }
  if (!(await isNonEmptyDirectory(join(nextDirectory, "static")))) {
    throw new Error(
      `.next/static is missing or empty; the production build output is incomplete. ` +
      `Delete .next and run \`next build\` again before packaging.`,
    );
  }

  if ((await getPathType(standaloneDirectory)) !== "directory") {
    throw new Error(
      `Standalone output not found at ${standaloneDirectory}. Run a Next.js build first.`,
    );
  }

  const serverEntry = join(standaloneDirectory, "server.js");
  if ((await getPathType(serverEntry)) !== "file") {
    throw new Error(`Standalone server entry not found at ${serverEntry}.`);
  }

  // Next traces the SDK's bundled dependency before the root postinstall
  // replacement is applied to the standalone tree. Apply the same reviewed
  // replacement to the exact runtime that Electron will ship.
  const runtimePatches = await Promise.all([
    patchBundledBraceExpansion(standaloneDirectory, projectRoot)
      .then((result) => ({ package: "brace-expansion", ...result })),
    patchBundledUndici(standaloneDirectory, projectRoot)
      .then((result) => ({ package: "undici", ...result })),
  ]);
  console.log(JSON.stringify({ standaloneRuntimePatches: runtimePatches }));

  // playwright-core supports driving Electron applications, but Piora only
  // launches Chromium. Next's broad trace follows Playwright's optional
  // `require("electron")` path and would embed a second full Electron runtime
  // inside resources/web (hundreds of megabytes). It is not reachable through
  // Piora's browser extension, so remove the complete optional package family
  // before packaging and verify that it stays absent downstream.
  for (const optionalPackage of ["electron", "@electron", "@electron-internal"]) {
    await rm(join(standaloneDirectory, "node_modules", optionalPackage), { recursive: true, force: true });
  }

  // Next's file tracer can follow the packaged-app verification helpers back
  // into desktop/release. Keeping that generated directory creates a recursive
  // package-within-a-package (and made a local candidate exceed 4 GB). Release
  // outputs are never runtime inputs, so remove only this exact traced subtree.
  const tracedDesktopRelease = join(standaloneDirectory, "desktop", "release");
  assertInside(standaloneDirectory, tracedDesktopRelease);
  await rm(tracedDesktopRelease, { recursive: true, force: true });

  const tracedGitDirectory = join(standaloneDirectory, ".git");
  assertInside(standaloneDirectory, tracedGitDirectory);
  await rm(tracedGitDirectory, { recursive: true, force: true });

  const tracedNextDirectory = join(standaloneDirectory, ".next");
  for (const entry of await readdir(tracedNextDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || (entry.name !== "dev" && !entry.name.startsWith("dev-stale-"))) continue;
    const tracedDevelopmentOutput = join(tracedNextDirectory, entry.name);
    assertInside(standaloneDirectory, tracedDevelopmentOutput);
    await rm(tracedDevelopmentOutput, { recursive: true, force: true });
  }

  // Stage complete production dependency closures for source-loaded runtimes.
  // Opaque Pi providers and the lazy Hypium driver can add dependencies or
  // native agents without becoming visible to Next's static output trace.
  const piAiProviderRuntimeRoot = join(
    projectRoot,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "node_modules",
    "@earendil-works",
    "pi-ai",
  );
  const hypiumRuntimeRoot = join(projectRoot, "node_modules", "hypium-driver");
  const dependencyAssets = await collectRuntimeDependencyAssets([
    piAiProviderRuntimeRoot,
    hypiumRuntimeRoot,
  ]);
  const runtimeAssetsByDestination = new Map(
    assets.map((asset) => [resolve(asset.destination), asset]),
  );
  for (const asset of dependencyAssets) {
    runtimeAssetsByDestination.set(resolve(asset.destination), asset);
  }
  const runtimeAssets = [...runtimeAssetsByDestination.values()];

  const stagedAssets = [];
  for (const asset of runtimeAssets) {
    assertInside(standaloneDirectory, asset.destination);
    const sourceType = await getPathType(asset.source);
    if (sourceType === "missing" && !asset.required) {
      stagedAssets.push({ ...asset, sourceType });
      continue;
    }
    if (sourceType !== "directory" && sourceType !== "file") {
      throw new Error(`Expected ${asset.name} at ${asset.source}.`);
    }
    if (asset.rejectSymlinks) {
      const symbolicLinks = (await findSymbolicLinks(asset.source)).filter((path) => (
        !asset.omitNodeModuleBins || !isNodeModulesBinPath(asset.source, path)
      ));
      if (symbolicLinks.length > 0) {
        throw new Error(
          `Refusing to stage ${asset.name} containing symbolic links:\n${symbolicLinks.join("\n")}`,
        );
      }
    }
    stagedAssets.push({ ...asset, sourceType });
  }

  for (const asset of stagedAssets) {
    await rm(asset.destination, { recursive: true, force: true });
    if (asset.sourceType === "missing") {
      console.log(`Skipped ${asset.name}; source directory does not exist.`);
      continue;
    }
    await mkdir(dirname(asset.destination), { recursive: true });
    await cp(asset.source, asset.destination, {
      recursive: true,
      force: true,
      dereference: true,
      ...(asset.omitNodeModuleBins
        ? { filter: (source) => !isNodeModulesBinPath(asset.source, source) }
        : {}),
    });
    const destinationType = await getPathType(asset.destination);
    if ((asset.sourceType === "directory" && !await isNonEmptyDirectory(asset.destination)) || (asset.sourceType === "file" && destinationType !== "file")) {
      throw new Error(`Staging ${asset.name} produced an invalid destination at ${asset.destination}.`);
    }
    console.log(`Staged ${asset.name} at ${asset.destination}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
