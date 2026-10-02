#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { extractAll } from "@electron/asar";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), "..");
const DEFAULT_WEB_ROOT = resolve(projectRoot, "desktop/release/win-unpacked/resources/web");
const PACKAGE_MANIFEST_LIMIT = 2 * 1024 * 1024;
const PACKAGE_LOCK_LIMIT = 32 * 1024 * 1024;
const LICENSE_FILE_LIMIT = 4 * 1024 * 1024;
const LICENSE_BUNDLE_LIMIT = 64 * 1024 * 1024;
const PACKAGE_COUNT_LIMIT = 10_000;
const NODE_MODULES_COUNT_LIMIT = 10_000;
const LICENSE_FILES_PER_PACKAGE_LIMIT = 16;
const UNIQUE_LICENSE_TEXT_COUNT_LIMIT = 10_000;
const LICENSE_NAME = /^(?:(?:un)?licen[cs]es?|copying|notice)(?:[._-].*)?$/i;
const LICENSE_TEXT_NAME = /^(?:(?:un)?licen[cs]es?|copying)(?:[._-].*)?$/i;

const REVIEWED_RUNTIME_REPLACEMENTS = Object.freeze([
  Object.freeze({
    // The immutable npm artifact is published as 6.1.210, but its own
    // package.json declares 6.1.0210. Record both identities instead of
    // rewriting third-party bytes or losing the exact packaged SBOM entity.
    lockPath: "node_modules/hypium-driver",
    lockedName: "hypium-driver",
    lockedVersion: "6.1.210",
    lockedIntegrity: "sha512-YWvIWwl3tedNUV9FI2ZMD28AER+OXRofdvOe/v7sneOQcfrh3RPmzbAz2BKXi+VOXf4lj8HBOc4lRER0TCKjAw==",
    installedName: "hypium-driver",
    installedVersion: "6.1.0210",
    mechanism: "published-tarball-manifest",
  }),
  Object.freeze({
    lockPath: "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion",
    lockedName: "brace-expansion",
    lockedVersion: "5.0.9",
    installedName: "brace-expansion",
    installedVersion: "5.0.12",
    mechanism: "scripts/patch-bundled-dependencies.mjs",
  }),
  Object.freeze({
    lockPath: "node_modules/@earendil-works/pi-coding-agent/node_modules/undici",
    lockedName: "undici",
    lockedVersion: "8.10.2",
    installedName: "undici",
    installedVersion: "8.11.2",
    mechanism: "scripts/patch-bundled-dependencies.mjs",
  }),
]);
const REVIEWED_RUNTIME_REPLACEMENT_BY_PATH = new Map(
  REVIEWED_RUNTIME_REPLACEMENTS.map((replacement) => [replacement.lockPath, replacement]),
);

const REVIEWED_LICENSE_FALLBACKS = Object.freeze([
  Object.freeze({
    name: "rehype-katex",
    version: "7.0.1",
    declaredLicense: "MIT",
    upstreamCommit: "88a9497e1ede93b958237c85edbf5651faeca7af",
    upstreamLicenseUrl:
      "https://github.com/remarkjs/remark-math/blob/88a9497e1ede93b958237c85edbf5651faeca7af/license",
    licensePath: "third_party/remark-math/LICENSE",
    provenancePath: "third_party/remark-math/SOURCE.md",
    licenseSha256: "cb992262f361a5359e6771c28740d33c7041e15332ae8537fae40538992591a9",
    provenanceSha256: "72aab2559c65795359db5e65bbc370b88e54030cb94b52b0ff8b518697b1e90a",
  }),
  Object.freeze({
    name: "remark-math",
    version: "6.0.0",
    declaredLicense: "MIT",
    upstreamCommit: "d5d0660b150810a535bbb07eac6cc96a4510aa24",
    upstreamLicenseUrl:
      "https://github.com/remarkjs/remark-math/blob/d5d0660b150810a535bbb07eac6cc96a4510aa24/license",
    licensePath: "third_party/remark-math/LICENSE",
    provenancePath: "third_party/remark-math/SOURCE.md",
    licenseSha256: "cb992262f361a5359e6771c28740d33c7041e15332ae8537fae40538992591a9",
    provenanceSha256: "72aab2559c65795359db5e65bbc370b88e54030cb94b52b0ff8b518697b1e90a",
  }),
  Object.freeze({
    name: "format",
    version: "0.2.2",
    declaredLicense: "MIT",
    upstreamCommit: "91b6bd78af9b061c90010b86d83caa051edeb1ea",
    upstreamLicenseUrl:
      "https://github.com/samsonjs/format/blob/91b6bd78af9b061c90010b86d83caa051edeb1ea/License.md",
    licensePath: "third_party/format/LICENSE.md",
    provenancePath: "third_party/format/SOURCE.md",
    licenseSha256: "0b2c94863590ca2aed327e89642b7e74b1608ec423bfec1d8f1beba2945fc4ba",
    provenanceSha256: "fb937cd4b4290274e316281adb88163df6f58b20e1365c9ffc5ead1b902674e0",
  }),
  Object.freeze({
    name: "khroma",
    version: "2.1.0",
    declaredLicense: "MIT",
    upstreamCommit: "4968165afb0d3d09be66497e7985a34f7bfe6d42",
    upstreamLicenseUrl:
      "https://github.com/fabiospampinato/khroma/blob/4968165afb0d3d09be66497e7985a34f7bfe6d42/license",
    licensePath: "third_party/khroma/LICENSE",
    provenancePath: "third_party/khroma/SOURCE.md",
    licenseSha256: "66b333b0f66759a0b710459e03f7029abe17f4358114a128d2c972e642961b49",
    provenanceSha256: "63cb2cbfe8f700e79fcf3facc3d850e225f4e20dd857a4e1f43ea423f285299c",
  }),
]);
const LICENSE_TEXT_REQUIRED_PACKAGE_NAMES = new Set([
  "format",
  "khroma",
  "rehype-katex",
  "remark-math",
]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function portablePath(path) {
  return path.replaceAll("\\", "/");
}

function assertInside(parent, child, description) {
  const childRelativePath = relative(parent, child);
  if (
    !childRelativePath ||
    childRelativePath === ".." ||
    childRelativePath.startsWith("../") ||
    childRelativePath.startsWith("..\\") ||
    isAbsolute(childRelativePath)
  ) {
    throw new Error(`${description} must stay inside its expected root`);
  }
}

async function readBounded(path, limit, description) {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error(`${description} must be a regular file: ${path}`);
  }
  if (entry.size > limit) {
    throw new Error(`${description} exceeds the ${limit}-byte limit: ${path}`);
  }
  return readFile(path);
}

function normalizeLicense(manifest) {
  const value = manifest.license ?? manifest.licenses;
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && typeof value.type === "string" && value.type.trim()) {
    return value.type.trim();
  }
  if (Array.isArray(value)) {
    const values = [...new Set(value.flatMap((item) => {
      if (typeof item === "string" && item.trim()) return [item.trim()];
      if (item && typeof item.type === "string" && item.type.trim()) return [item.type.trim()];
      return [];
    }))].sort(compareText);
    if (values.length > 0) return values.join(" OR ");
  }
  return "UNDECLARED";
}

function packageNameFromInstallPath(installPath) {
  const normalized = portablePath(installPath);
  const marker = "node_modules/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const segments = normalized.slice(markerIndex + marker.length).split("/").filter(Boolean);
  if (segments.length === 0) return null;
  return segments[0].startsWith("@") && segments.length > 1
    ? `${segments[0]}/${segments[1]}`
    : segments[0];
}

function runtimeIdentityFromLockEntry(installPath, metadata) {
  const normalizedPath = portablePath(installPath);
  const installedName = packageNameFromInstallPath(normalizedPath);
  const lockedName = typeof metadata.name === "string" && metadata.name.trim()
    ? metadata.name.trim()
    : installedName;
  if (!lockedName) return null;
  const replacement = REVIEWED_RUNTIME_REPLACEMENT_BY_PATH.get(normalizedPath);
  if (!replacement) return { name: lockedName, version: metadata.version };
  if (lockedName !== replacement.lockedName) {
    throw new Error(`Reviewed runtime replacement has an unexpected package name at ${normalizedPath}`);
  }
  if (!replacement.lockedIntegrity && metadata.version === replacement.installedVersion) {
    return { name: replacement.installedName, version: replacement.installedVersion };
  }
  if (metadata.version !== replacement.lockedVersion) {
    throw new Error(
      `Reviewed runtime replacement expected ${replacement.lockedName}@${replacement.lockedVersion} ` +
      `at ${normalizedPath}, found ${lockedName}@${metadata.version}`,
    );
  }
  if (replacement.lockedIntegrity && metadata.integrity !== replacement.lockedIntegrity) {
    throw new Error(
      `Reviewed runtime replacement expected integrity ${replacement.lockedIntegrity} ` +
      `at ${normalizedPath}, found ${metadata.integrity ?? "missing"}`,
    );
  }
  return {
    name: replacement.installedName,
    version: replacement.installedVersion,
    reviewedReplacement: {
      lockPath: normalizedPath,
      lockedName: replacement.lockedName,
      lockedVersion: replacement.lockedVersion,
      ...(replacement.lockedIntegrity ? { lockedIntegrity: replacement.lockedIntegrity } : {}),
      installedName: replacement.installedName,
      installedVersion: replacement.installedVersion,
      mechanism: replacement.mechanism,
    },
  };
}

async function assertRealPathInside(rootRealPath, path, description) {
  const resolved = await realpath(path);
  const relativePath = relative(rootRealPath, resolved);
  if (
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("..\\") ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`${description} resolves outside its expected root: ${path}`);
  }
}

async function directPackageRoots(nodeModulesPath, webRootRealPath) {
  const nodeModulesEntry = await lstat(nodeModulesPath);
  if (nodeModulesEntry.isSymbolicLink() || !nodeModulesEntry.isDirectory()) {
    throw new Error(`node_modules must be a regular directory: ${nodeModulesPath}`);
  }
  await assertRealPathInside(webRootRealPath, nodeModulesPath, "node_modules");

  const roots = [];
  const entries = (await readdir(nodeModulesPath, { withFileTypes: true }))
    .sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    if (entry.name === ".bin" || entry.name === ".package-lock.json") continue;
    const entryPath = join(nodeModulesPath, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Symlinked package content is not allowed in the license scan: ${entryPath}`);
    }
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith("@")) {
      roots.push(entryPath);
      if (roots.length > PACKAGE_COUNT_LIMIT) {
        throw new Error(`A node_modules directory exceeds ${PACKAGE_COUNT_LIMIT} package roots`);
      }
      continue;
    }

    const scopeEntries = (await readdir(entryPath, { withFileTypes: true }))
      .sort((left, right) => compareText(left.name, right.name));
    for (const scopedEntry of scopeEntries) {
      const scopedPath = join(entryPath, scopedEntry.name);
      if (scopedEntry.isSymbolicLink()) {
        throw new Error(`Symlinked package content is not allowed in the license scan: ${scopedPath}`);
      }
      if (scopedEntry.isDirectory()) {
        roots.push(scopedPath);
        if (roots.length > PACKAGE_COUNT_LIMIT) {
          throw new Error(`A node_modules directory exceeds ${PACKAGE_COUNT_LIMIT} package roots`);
        }
      }
    }
  }
  return roots;
}

async function optionalDirectory(path) {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) throw new Error(`Symlinked node_modules is not allowed: ${path}`);
    return entry.isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function packagePurl(name, version) {
  if (name.startsWith("@") && name.includes("/")) {
    const [scope, packageName] = name.slice(1).split("/", 2);
    return `pkg:npm/%40${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}@${encodeURIComponent(version)}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

async function readApplicationVersion(webRoot) {
  try {
    const bytes = await readBounded(join(webRoot, "package.json"), PACKAGE_MANIFEST_LIMIT, "Application package.json");
    const manifest = JSON.parse(bytes.toString("utf8"));
    return typeof manifest.version === "string" && manifest.version ? manifest.version : "0.0.0";
  } catch (error) {
    if (error?.code === "ENOENT") return "0.0.0";
    throw error;
  }
}

async function collectLicenseFiles(packageRoot) {
  const licensePaths = [];
  const packageEntries = (await readdir(packageRoot, { withFileTypes: true }))
    .sort((left, right) => compareText(left.name, right.name));
  const licenseEntries = packageEntries.filter((entry) => LICENSE_NAME.test(entry.name));
  for (const entry of licenseEntries) {
    const licensePath = join(packageRoot, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Package license material must be a regular file: ${licensePath}`);
    }
    if (entry.isFile()) {
      licensePaths.push({ path: licensePath, sourceName: entry.name });
    } else if (entry.isDirectory()) {
      const children = (await readdir(licensePath, { withFileTypes: true }))
        .sort((left, right) => compareText(left.name, right.name));
      for (const child of children) {
        const childPath = join(licensePath, child.name);
        if (child.isSymbolicLink() || !child.isFile()) {
          throw new Error(`Package license directory entries must be regular files: ${childPath}`);
        }
        licensePaths.push({ path: childPath, sourceName: `${entry.name}/${child.name}` });
      }
    } else {
      throw new Error(`Package license material must be a regular file or directory: ${licensePath}`);
    }
    if (licensePaths.length > LICENSE_FILES_PER_PACKAGE_LIMIT) {
      throw new Error(
        `Package contains more than ${LICENSE_FILES_PER_PACKAGE_LIMIT} license files: ${packageRoot}`,
      );
    }
  }
  const files = [];
  for (const licenseFile of licensePaths) {
    const bytes = await readBounded(licenseFile.path, LICENSE_FILE_LIMIT, "Package license material");
    files.push({
      sourceName: licenseFile.sourceName,
      sha256: sha256(bytes),
      size: bytes.length,
      bytes,
    });
  }
  return files;
}

async function readSourceDependencyContext(sourceRootInput) {
  const sourceRoot = resolve(sourceRootInput);
  const sourceRootRealPath = await realpath(sourceRoot);
  const lockBytes = await readBounded(
    join(sourceRoot, "package-lock.json"),
    PACKAGE_LOCK_LIMIT,
    "Source package-lock.json",
  );
  const lock = JSON.parse(lockBytes.toString("utf8"));
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== "object") {
    throw new Error("Source package-lock.json must use npm lockfileVersion 3");
  }

  const entries = Object.entries(lock.packages)
    .filter(([installPath, metadata]) => installPath.includes("node_modules/") && metadata?.version)
    .sort(([left], [right]) => compareText(left, right));
  const packageRoots = [{ root: sourceRoot, realPath: sourceRootRealPath }];
  const stagedStandaloneRoot = join(sourceRoot, ".next", "standalone");
  if (await optionalDirectory(stagedStandaloneRoot)) {
    packageRoots.push({
      root: stagedStandaloneRoot,
      realPath: await realpath(stagedStandaloneRoot),
    });
  }
  return { sourceRoot, lock, entries, packageRoots };
}

function collectRuntimeSourceClosure(lock) {
  const runtimePackages = new Map();
  const entries = Object.entries(lock.packages)
    .filter(([, metadata]) => metadata?.dev !== true)
    .sort(([left], [right]) => compareText(left, right));
  for (const [installPath, metadata] of entries) {
    if (!installPath.includes("node_modules/") || typeof metadata?.version !== "string") continue;
    const identity = runtimeIdentityFromLockEntry(installPath, metadata);
    if (!identity) continue;
    const key = `${identity.name}@${identity.version}`;
    const declaredLicense = normalizeLicense(metadata);
    const existing = runtimePackages.get(key);
    if (existing) {
      existing.optional &&= Boolean(metadata.optional);
      existing.lockPaths.push(portablePath(installPath));
      if (identity.reviewedReplacement) {
        existing.reviewedReplacements ??= [];
        existing.reviewedReplacements.push(identity.reviewedReplacement);
      }
      if (existing.declaredLicense === "UNDECLARED" && declaredLicense !== "UNDECLARED") {
        existing.declaredLicense = declaredLicense;
      }
      continue;
    }
    runtimePackages.set(key, {
      scope: "runtime-source-closure",
      name: identity.name,
      version: identity.version,
      declaredLicense,
      optional: Boolean(metadata.optional),
      lockPaths: [portablePath(installPath)],
      ...(identity.reviewedReplacement
        ? { reviewedReplacements: [identity.reviewedReplacement] }
        : {}),
      sourceInstalled: false,
      sourcePackageJsonSha256: [],
      licenseMaterialStatus: "source-package-unavailable",
      licenseFiles: [],
    });
  }
  return [...runtimePackages.values()].sort(
    (left, right) => compareText(left.name, right.name) || compareText(left.version, right.version),
  );
}

async function sourceLicenseCatalog(context, targetKeys) {
  const { entries, packageRoots } = context;

  const catalog = new Map();
  for (const [installPath, metadata] of entries) {
    const identity = runtimeIdentityFromLockEntry(installPath, metadata);
    if (!identity || !targetKeys.has(`${identity.name}@${identity.version}`)) continue;
    let foundCandidate = false;
    for (const packageSource of packageRoots) {
      const packageRoot = resolve(packageSource.root, installPath);
      assertInside(packageSource.root, packageRoot, "Installed source package");
      let packageEntry;
      try {
        packageEntry = await lstat(packageRoot);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      if (packageEntry.isSymbolicLink() || !packageEntry.isDirectory()) continue;
      await assertRealPathInside(packageSource.realPath, packageRoot, "Installed source package");
      const manifestPath = join(packageRoot, "package.json");
      let manifestBytes;
      try {
        manifestBytes = await readBounded(manifestPath, PACKAGE_MANIFEST_LIMIT, "Source package manifest");
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      const manifest = JSON.parse(manifestBytes.toString("utf8"));
      if (manifest.name !== identity.name || manifest.version !== identity.version) {
        if (identity.reviewedReplacement) {
          throw new Error(
            `Reviewed runtime replacement at ${installPath} must contain ` +
            `${identity.reviewedReplacement.installedName}@${identity.reviewedReplacement.installedVersion}, ` +
            `found ${manifest.name}@${manifest.version}`,
          );
        }
        continue;
      }
      const key = `${manifest.name}@${manifest.version}`;
      const candidates = catalog.get(key) ?? [];
      candidates.push({
        packageJsonSha256: sha256(manifestBytes),
        declaredLicense: normalizeLicense(manifest),
        licenseFiles: await collectLicenseFiles(packageRoot),
      });
      catalog.set(key, candidates);
      foundCandidate = true;
      break;
    }
    if (!foundCandidate && identity.reviewedReplacement) {
      throw new Error(
        `Reviewed runtime replacement is missing or invalid after postinstall: ${installPath}`,
      );
    }
  }
  return catalog;
}

async function reviewedLicenseFallbackCatalog(sourceRoot, targetKeys) {
  const fallbacks = new Map();
  for (const fallback of REVIEWED_LICENSE_FALLBACKS) {
    const key = `${fallback.name}@${fallback.version}`;
    if (!targetKeys.has(key)) continue;
    const licensePath = resolve(sourceRoot, fallback.licensePath);
    const provenancePath = resolve(sourceRoot, fallback.provenancePath);
    assertInside(sourceRoot, licensePath, "Reviewed fallback license");
    assertInside(sourceRoot, provenancePath, "Reviewed fallback provenance");
    const [licenseBytes, provenanceBytes] = await Promise.all([
      readBounded(licensePath, LICENSE_FILE_LIMIT, "Reviewed fallback license"),
      readBounded(provenancePath, LICENSE_FILE_LIMIT, "Reviewed fallback provenance"),
    ]);
    if (sha256(licenseBytes) !== fallback.licenseSha256) {
      throw new Error(`Reviewed fallback license is stale or modified: ${fallback.licensePath}`);
    }
    if (sha256(provenanceBytes) !== fallback.provenanceSha256) {
      throw new Error(`Reviewed fallback provenance is stale or modified: ${fallback.provenancePath}`);
    }
    const provenance = provenanceBytes.toString("utf8");
    if (
      !provenance.includes(key)
      || !provenance.includes(fallback.upstreamCommit)
      || !provenance.includes(fallback.upstreamLicenseUrl)
    ) {
      throw new Error(`Reviewed fallback provenance is incomplete for ${key}`);
    }
    fallbacks.set(key, {
      metadata: {
        licensePath: fallback.licensePath,
        provenancePath: fallback.provenancePath,
        declaredLicense: fallback.declaredLicense,
        upstreamCommit: fallback.upstreamCommit,
        upstreamLicenseUrl: fallback.upstreamLicenseUrl,
      },
      files: [
        {
          sourceName: fallback.licensePath,
          sha256: sha256(licenseBytes),
          size: licenseBytes.length,
          bytes: licenseBytes,
        },
        {
          sourceName: fallback.provenancePath,
          sha256: sha256(provenanceBytes),
          size: provenanceBytes.length,
          bytes: provenanceBytes,
        },
      ],
    });
  }
  return fallbacks;
}

function createLicenseTextRegistry() {
  return { licenseTexts: new Map(), totalLicenseBytes: 0 };
}

function attachLicenseFiles(entry, material, registry) {
  const uniqueMaterial = new Map();
  for (const licenseFile of material) {
    const materialKey = `${licenseFile.sourceName}\0${licenseFile.sha256}`;
    uniqueMaterial.set(materialKey, licenseFile);
    if (!registry.licenseTexts.has(licenseFile.sha256)) {
      if (registry.licenseTexts.size >= UNIQUE_LICENSE_TEXT_COUNT_LIMIT) {
        throw new Error(`Unique license material exceeds ${UNIQUE_LICENSE_TEXT_COUNT_LIMIT} files`);
      }
      registry.totalLicenseBytes += licenseFile.bytes.length;
      if (registry.totalLicenseBytes > LICENSE_BUNDLE_LIMIT) {
        throw new Error(`Unique license material exceeds ${LICENSE_BUNDLE_LIMIT} bytes`);
      }
      registry.licenseTexts.set(licenseFile.sha256, licenseFile.bytes);
    }
  }
  entry.licenseFiles = [...uniqueMaterial.values()]
    .sort((left, right) => compareText(left.sourceName, right.sourceName) || compareText(left.sha256, right.sha256))
    .map(({ sourceName, sha256: digest, size }) => ({
      sourceName,
      bundlePath: `texts/${digest}.txt`,
      sha256: digest,
      size,
    }));
}

function hasCompleteLicenseText(material) {
  return material.some((licenseFile) => {
    const sourceName = portablePath(licenseFile.sourceName).split("/").at(-1) ?? "";
    return LICENSE_TEXT_NAME.test(sourceName);
  });
}

function attachPackagedLicenseMaterial(
  packages,
  finalLicenseFiles,
  catalog,
  reviewedFallbacks,
  registry,
) {
  for (const entry of packages) {
    const key = `${entry.name}@${entry.version}`;
    const candidates = catalog.get(key);
    if (!candidates?.length) {
      throw new Error(`No installed source package matches distributed dependency ${key}`);
    }
    const exactCandidates = candidates.filter(
      (candidate) => candidate.packageJsonSha256 === entry.packageJsonSha256,
    );
    const selectedCandidates = exactCandidates.length > 0 ? exactCandidates : candidates;
    const reviewedFallback = reviewedFallbacks.get(key);
    if (reviewedFallback) {
      if (entry.declaredLicense === "UNDECLARED") {
        entry.declaredLicense = reviewedFallback.metadata.declaredLicense;
      } else if (entry.declaredLicense !== reviewedFallback.metadata.declaredLicense) {
        throw new Error(`Reviewed license declaration disagrees with distributed dependency ${key}`);
      }
    }
    const material = [
      ...(finalLicenseFiles.get(entry.path) ?? []),
      ...selectedCandidates.flatMap((candidate) => candidate.licenseFiles),
      ...(reviewedFallback?.files ?? []),
    ];
    if (LICENSE_TEXT_REQUIRED_PACKAGE_NAMES.has(entry.name) && !hasCompleteLicenseText(material)) {
      throw new Error(`No complete license text is available for distributed dependency ${key}`);
    }
    if (entry.declaredLicense === "UNDECLARED") {
      throw new Error(`Distributed dependency has no declared or reviewed license: ${key}`);
    }
    attachLicenseFiles(entry, material, registry);
    entry.licenseMaterialStatus = reviewedFallback
      ? "reviewed-fallback"
      : entry.licenseFiles.length > 0
        ? "available"
        : "not-published";
    if (reviewedFallback) entry.reviewedLicenseFallback = reviewedFallback.metadata;
  }
}

function attachRuntimeSourceLicenseMaterial(runtimeSourceClosure, catalog, reviewedFallbacks, registry) {
  for (const entry of runtimeSourceClosure) {
    const key = `${entry.name}@${entry.version}`;
    const candidates = catalog.get(key) ?? [];
    if (candidates.length === 0 && !entry.optional) {
      throw new Error(`No installed source package matches runtime source dependency ${key}`);
    }
    entry.sourceInstalled = candidates.length > 0;
    entry.sourcePackageJsonSha256 = [...new Set(
      candidates.map((candidate) => candidate.packageJsonSha256),
    )].sort(compareText);
    if (entry.declaredLicense === "UNDECLARED") {
      const declaredLicenses = [...new Set(
        candidates
          .map((candidate) => candidate.declaredLicense)
          .filter((license) => license !== "UNDECLARED"),
      )].sort(compareText);
      if (declaredLicenses.length > 0) entry.declaredLicense = declaredLicenses.join(" OR ");
    }
    const reviewedFallback = reviewedFallbacks.get(key);
    if (reviewedFallback) {
      if (entry.declaredLicense === "UNDECLARED") {
        entry.declaredLicense = reviewedFallback.metadata.declaredLicense;
      } else if (entry.declaredLicense !== reviewedFallback.metadata.declaredLicense) {
        throw new Error(`Reviewed license declaration disagrees with runtime source dependency ${key}`);
      }
    }
    const material = [
      ...candidates.flatMap((candidate) => candidate.licenseFiles),
      ...(reviewedFallback?.files ?? []),
    ];
    if (LICENSE_TEXT_REQUIRED_PACKAGE_NAMES.has(entry.name) && !hasCompleteLicenseText(material)) {
      throw new Error(`No complete license text is available for runtime source dependency ${key}`);
    }
    if (entry.declaredLicense === "UNDECLARED") {
      throw new Error(`Runtime source dependency has no declared or reviewed license: ${key}`);
    }
    attachLicenseFiles(entry, material, registry);
    entry.licenseMaterialStatus = reviewedFallback
      ? "reviewed-fallback"
      : !entry.sourceInstalled
      ? "source-package-unavailable"
      : entry.licenseFiles.length > 0
        ? "available"
        : "not-published";
    if (reviewedFallback) entry.reviewedLicenseFallback = reviewedFallback.metadata;
  }
}

export async function inspectPackagedNpmDependencies(
  webRootInput,
  { licenseSourceRoot = projectRoot } = {},
) {
  const webRoot = resolve(webRootInput);
  const webRootEntry = await lstat(webRoot);
  if (webRootEntry.isSymbolicLink() || !webRootEntry.isDirectory()) {
    throw new Error(`Packaged web root must be a regular directory: ${webRoot}`);
  }
  const webRootRealPath = await realpath(webRoot);
  const rootNodeModules = join(webRoot, "node_modules");
  if (!(await optionalDirectory(rootNodeModules))) {
    throw new Error(`Packaged node_modules directory is missing: ${rootNodeModules}`);
  }

  const nodeModulesQueue = [rootNodeModules];
  const visitedNodeModules = new Set();
  const packages = [];
  const finalLicenseFiles = new Map();

  while (nodeModulesQueue.length > 0) {
    const nodeModulesPath = nodeModulesQueue.shift();
    const nodeModulesRealPath = await realpath(nodeModulesPath);
    if (visitedNodeModules.has(nodeModulesRealPath)) continue;
    visitedNodeModules.add(nodeModulesRealPath);
    if (visitedNodeModules.size > NODE_MODULES_COUNT_LIMIT) {
      throw new Error(`Packaged dependency tree exceeds ${NODE_MODULES_COUNT_LIMIT} node_modules directories`);
    }

    const packageRoots = await directPackageRoots(nodeModulesPath, webRootRealPath);
    for (const packageRoot of packageRoots) {
      if (packages.length >= PACKAGE_COUNT_LIMIT) {
        throw new Error(`Packaged dependency tree exceeds ${PACKAGE_COUNT_LIMIT} package copies`);
      }
      await assertRealPathInside(webRootRealPath, packageRoot, "Package");
      const nestedNodeModules = join(packageRoot, "node_modules");
      if (await optionalDirectory(nestedNodeModules)) nodeModulesQueue.push(nestedNodeModules);
      const manifestPath = join(packageRoot, "package.json");
      let manifestBytes;
      try {
        manifestBytes = await readBounded(manifestPath, PACKAGE_MANIFEST_LIMIT, "Package manifest");
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      let manifest;
      try {
        manifest = JSON.parse(manifestBytes.toString("utf8"));
      } catch (error) {
        throw new Error(`Invalid package.json in packaged dependency: ${manifestPath}`, { cause: error });
      }
      if (typeof manifest.name !== "string" || !manifest.name || typeof manifest.version !== "string" || !manifest.version) {
        throw new Error(`Packaged dependency has no valid name/version: ${manifestPath}`);
      }

      const packageRelativePath = portablePath(relative(webRoot, packageRoot));
      finalLicenseFiles.set(packageRelativePath, await collectLicenseFiles(packageRoot));

      packages.push({
        scope: "packaged-node-modules",
        path: packageRelativePath,
        name: manifest.name,
        version: manifest.version,
        declaredLicense: normalizeLicense(manifest),
        packageJsonSha256: sha256(manifestBytes),
        licenseFiles: [],
      });
    }
  }

  packages.sort((left, right) => compareText(left.path, right.path));
  const sourceContext = await readSourceDependencyContext(licenseSourceRoot);
  const runtimeSourceClosure = collectRuntimeSourceClosure(sourceContext.lock);
  const targetKeys = new Set([
    ...packages.map((entry) => `${entry.name}@${entry.version}`),
    ...runtimeSourceClosure.map((entry) => `${entry.name}@${entry.version}`),
  ]);
  const catalog = await sourceLicenseCatalog(sourceContext, targetKeys);
  const reviewedFallbacks = await reviewedLicenseFallbackCatalog(sourceContext.sourceRoot, targetKeys);
  const registry = createLicenseTextRegistry();
  attachPackagedLicenseMaterial(
    packages,
    finalLicenseFiles,
    catalog,
    reviewedFallbacks,
    registry,
  );
  attachRuntimeSourceLicenseMaterial(runtimeSourceClosure, catalog, reviewedFallbacks, registry);
  return {
    webRoot,
    applicationVersion: await readApplicationVersion(webRoot),
    packages,
    runtimeSourceClosure,
    licenseTexts: registry.licenseTexts,
  };
}

export async function inspectRuntimeSourceNpmDependencies(
  sourceRootInput = projectRoot,
  { packageNames } = {},
) {
  const sourceContext = await readSourceDependencyContext(sourceRootInput);
  const completeRuntimeSourceClosure = collectRuntimeSourceClosure(sourceContext.lock);
  const requestedNames = packageNames ? new Set(packageNames) : null;
  const runtimeSourceClosure = requestedNames
    ? completeRuntimeSourceClosure.filter((entry) => requestedNames.has(entry.name))
    : completeRuntimeSourceClosure;
  const targetKeys = new Set(
    runtimeSourceClosure.map((entry) => `${entry.name}@${entry.version}`),
  );
  const catalog = await sourceLicenseCatalog(sourceContext, targetKeys);
  const reviewedFallbacks = await reviewedLicenseFallbackCatalog(sourceContext.sourceRoot, targetKeys);
  const registry = createLicenseTextRegistry();
  attachRuntimeSourceLicenseMaterial(runtimeSourceClosure, catalog, reviewedFallbacks, registry);
  return { runtimeSourceClosure, licenseTexts: registry.licenseTexts };
}

function componentLicense(entry) {
  return entry.declaredLicense === "UNDECLARED"
    ? {}
    : { licenses: [{ license: { name: entry.declaredLicense } }] };
}

function buildArtifacts({ applicationVersion, packages, runtimeSourceClosure, licenseTexts }) {
  const packageInventoryBytes = Buffer.from(json({ packages, runtimeSourceClosure }), "utf8");
  const totalLicenseTextBytes = [...licenseTexts.values()].reduce((sum, bytes) => sum + bytes.length, 0);
  const manifest = {
    schema: "piora-third-party-packages-v3",
    source: "resources/web/node_modules",
    runtimeSource: "effective package-lock.json dev !== true closure after reviewed postinstall replacements",
    packageCount: packages.length,
    runtimeSourcePackageCount: runtimeSourceClosure.length,
    uniqueLicenseTextCount: licenseTexts.size,
    totalLicenseTextBytes,
    inventorySha256: sha256(packageInventoryBytes),
    packages,
    runtimeSourceClosure,
  };
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      component: {
        type: "application",
        name: "Piora packaged web",
        version: applicationVersion,
      },
    },
    components: [
      ...packages.map((entry) => ({
        type: "library",
        "bom-ref": `urn:piora:npm-location:${sha256(Buffer.from(entry.path, "utf8"))}`,
        name: entry.name,
        version: entry.version,
        purl: packagePurl(entry.name, entry.version),
        ...componentLicense(entry),
        properties: [
          { name: "Piora:evidenceScope", value: entry.scope },
          { name: "Piora:distributionPath", value: entry.path },
          { name: "Piora:packageJsonSha256", value: entry.packageJsonSha256 },
          { name: "Piora:licenseMaterialStatus", value: entry.licenseMaterialStatus },
          { name: "Piora:licenseFileCount", value: String(entry.licenseFiles.length) },
          ...(entry.reviewedLicenseFallback
            ? [{
                name: "Piora:reviewedLicenseFallback",
                value: JSON.stringify(entry.reviewedLicenseFallback),
              }]
            : []),
        ],
      })),
      ...runtimeSourceClosure.map((entry) => ({
        type: "library",
        "bom-ref": `urn:piora:npm-runtime-source:${sha256(Buffer.from(`${entry.name}@${entry.version}`, "utf8"))}`,
        name: entry.name,
        version: entry.version,
        purl: packagePurl(entry.name, entry.version),
        ...componentLicense(entry),
        properties: [
          { name: "Piora:evidenceScope", value: entry.scope },
          { name: "Piora:lockInstallPaths", value: JSON.stringify(entry.lockPaths) },
          { name: "Piora:optional", value: String(entry.optional) },
          { name: "Piora:sourceInstalled", value: String(entry.sourceInstalled) },
          { name: "Piora:licenseMaterialStatus", value: entry.licenseMaterialStatus },
          {
            name: "Piora:sourcePackageJsonSha256",
            value: JSON.stringify(entry.sourcePackageJsonSha256),
          },
          { name: "Piora:licenseFileCount", value: String(entry.licenseFiles.length) },
          ...(entry.reviewedReplacements
            ? [{
                name: "Piora:reviewedRuntimeReplacements",
                value: JSON.stringify(entry.reviewedReplacements),
              }]
            : []),
          ...(entry.reviewedLicenseFallback
            ? [{
                name: "Piora:reviewedLicenseFallback",
                value: JSON.stringify(entry.reviewedLicenseFallback),
              }]
            : []),
        ],
      })),
    ],
  };
  const readme = [
    "Piora packaged third-party license bundle",
    "",
    "THIRD_PARTY_PACKAGES.json contains two explicitly labelled evidence scopes:",
    "packaged-node-modules is the exact inventory of npm package copies found in the",
    "packaged resources/web tree; runtime-source-closure is the effective unique",
    "name/version closure of package-lock.json entries where dev !== true, including",
    "frontend libraries compiled into Next.js output and therefore absent as package",
    "directories. Exact reviewed postinstall replacements are retained as provenance",
    "on the final installed entity; every other dependency remains version-exact.",
    "SBOM.cdx.json includes both scopes with distinct bom-ref values and scope properties.",
    "The texts directory stores every top-level LICENSE, LICENCE, COPYING, and NOTICE",
    "file from matching installed runtime source packages, plus any such files retained",
    "in the final web tree, byte-for-byte and deduplicated globally by SHA-256.",
    "An absent optional platform package is still inventoried with sourceInstalled=false",
    "and licenseMaterialStatus=source-package-unavailable. A missing non-optional source",
    "package fails closed; no text is guessed or borrowed from a different version.",
    "Packages that publish no such file remain listed with an empty licenseFiles array",
    "unless a version-scoped reviewed fallback is listed. Reviewed fallbacks include",
    "their immutable upstream commit and provenance text and fail closed if modified.",
    "",
  ].join("\n");

  const files = new Map([
    ["README.txt", Buffer.from(readme, "utf8")],
    ["THIRD_PARTY_PACKAGES.json", Buffer.from(json(manifest), "utf8")],
    ["SBOM.cdx.json", Buffer.from(json(sbom), "utf8")],
  ]);
  for (const [digest, bytes] of [...licenseTexts.entries()].sort(([left], [right]) => compareText(left, right))) {
    files.set(`texts/${digest}.txt`, bytes);
  }
  return { manifest, sbom, files };
}

async function listBundleFiles(root) {
  const files = [];
  async function walk(directory) {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`License bundle must not contain symlinks: ${entryPath}`);
      if (entry.isDirectory()) await walk(entryPath);
      else if (entry.isFile()) {
        files.push(portablePath(relative(root, entryPath)));
        if (files.length > UNIQUE_LICENSE_TEXT_COUNT_LIMIT + 3) {
          throw new Error("Packaged license bundle contains too many files");
        }
      }
      else throw new Error(`Unexpected filesystem entry in license bundle: ${entryPath}`);
    }
  }
  await walk(root);
  return files.sort(compareText);
}

async function verifyArtifacts(bundleRoot, artifacts) {
  let entry;
  try {
    entry = await lstat(bundleRoot);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Packaged license bundle is missing: ${bundleRoot}`);
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`Packaged license bundle must be a regular directory: ${bundleRoot}`);
  }
  const actualFiles = await listBundleFiles(bundleRoot);
  const expectedFiles = [...artifacts.files.keys()].sort(compareText);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(
      `Packaged license bundle file set does not match the distributed packages. ` +
      `Expected ${expectedFiles.length} files, found ${actualFiles.length}.`,
    );
  }
  for (const [relativePath, expectedBytes] of artifacts.files) {
    const actualPath = join(bundleRoot, ...relativePath.split("/"));
    const actualEntry = await lstat(actualPath);
    if (actualEntry.isSymbolicLink() || !actualEntry.isFile() || actualEntry.size !== expectedBytes.length) {
      throw new Error(`Packaged license material is stale or modified: ${relativePath}`);
    }
    const actualBytes = await readFile(actualPath);
    if (!actualBytes.equals(expectedBytes)) {
      throw new Error(`Packaged license material is stale or modified: ${relativePath}`);
    }
  }
}

async function writeArtifacts(outputRoot, bundleRoot, artifacts) {
  await mkdir(outputRoot, { recursive: true });
  assertInside(outputRoot, bundleRoot, "License bundle");
  const temporaryRoot = join(outputRoot, `.third-party-${process.pid}-${randomUUID()}`);
  assertInside(outputRoot, temporaryRoot, "Temporary license bundle");
  const backupRoot = join(outputRoot, `.third-party-backup-${process.pid}-${randomUUID()}`);
  assertInside(outputRoot, backupRoot, "License bundle backup");
  let movedExisting = false;
  let installedNewBundle = false;
  try {
    await mkdir(temporaryRoot, { recursive: false });
    for (const [relativePath, bytes] of artifacts.files) {
      const destination = join(temporaryRoot, ...relativePath.split("/"));
      assertInside(temporaryRoot, destination, "License material");
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
    try {
      await renameWithTransientWindowsRetry(bundleRoot, backupRoot);
      movedExisting = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await renameWithTransientWindowsRetry(temporaryRoot, bundleRoot);
    installedNewBundle = true;
  } catch (error) {
    if (movedExisting && !installedNewBundle) {
      try {
        await renameWithTransientWindowsRetry(backupRoot, bundleRoot);
      } catch {
        // Preserve the original error; the backup path is included in it only locally.
      }
    }
    throw error;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  if (movedExisting) await rm(backupRoot, { recursive: true, force: true });
}

async function renameWithTransientWindowsRetry(source, destination) {
  const retryableCodes = new Set(["EACCES", "EBUSY", "EPERM"]);
  const maxAttempts = process.platform === "win32" ? 8 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (attempt === maxAttempts || !retryableCodes.has(error?.code)) throw error;
      await delay(50 * (2 ** (attempt - 1)));
    }
  }
}

export async function generatePackageLicenseBundle({
  webRoot = DEFAULT_WEB_ROOT,
  outputRoot = join(dirname(resolve(webRoot)), "licenses"),
  licenseSourceRoot = projectRoot,
  check = false,
} = {}) {
  const resolvedWebRoot = resolve(webRoot);
  let inspectionRoot = resolvedWebRoot;
  let extractedRoot;
  if (!(await optionalDirectory(join(resolvedWebRoot, "node_modules")))) {
    const runtimeArchivePath = join(resolvedWebRoot, "runtime.asar");
    const nodeModulesArchivePath = join(resolvedWebRoot, "node_modules.asar");
    const runtimeArchiveEntry = await lstat(runtimeArchivePath).catch(() => undefined);
    const nodeModulesArchiveEntry = await lstat(nodeModulesArchivePath).catch(() => undefined);
    const archivePath = runtimeArchiveEntry?.isFile()
      ? runtimeArchivePath
      : nodeModulesArchiveEntry?.isFile()
        ? nodeModulesArchivePath
        : undefined;
    const archiveEntry = runtimeArchiveEntry?.isFile() ? runtimeArchiveEntry : nodeModulesArchiveEntry;
    if (!archivePath || !archiveEntry || archiveEntry.isSymbolicLink()) {
      throw new Error(
        `Packaged dependency tree is missing: expected node_modules, runtime.asar, or node_modules.asar in ${resolvedWebRoot}`,
      );
    }
    extractedRoot = await mkdtemp(join(tmpdir(), "piora-license-asar-"));
    inspectionRoot = extractedRoot;
    if (archivePath === runtimeArchivePath) {
      await extractAll(archivePath, inspectionRoot);
    } else {
      await extractAll(archivePath, join(inspectionRoot, "node_modules"));
      const packagedManifest = join(resolvedWebRoot, "package.json");
      if (await lstat(packagedManifest).then((entry) => entry.isFile()).catch(() => false)) {
        await copyFile(packagedManifest, join(inspectionRoot, "package.json"));
      }
    }
  }

  let inspected;
  try {
    inspected = await inspectPackagedNpmDependencies(inspectionRoot, { licenseSourceRoot });
  } finally {
    if (extractedRoot) await rm(extractedRoot, { recursive: true, force: true });
  }
  const artifacts = buildArtifacts(inspected);
  const resolvedOutputRoot = resolve(outputRoot);
  const bundleRoot = join(resolvedOutputRoot, "third-party");
  if (check) await verifyArtifacts(bundleRoot, artifacts);
  else await writeArtifacts(resolvedOutputRoot, bundleRoot, artifacts);
  return {
    checked: check,
    bundleRoot,
    packageCount: inspected.packages.length,
    runtimeSourcePackageCount: inspected.runtimeSourceClosure.length,
    uniqueLicenseTextCount: inspected.licenseTexts.size,
    inventorySha256: artifacts.manifest.inventorySha256,
  };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") options.check = true;
    else if (argument === "--web-root") options.webRoot = argv[++index];
    else if (argument === "--output-root") options.outputRoot = argv[++index];
    else if (argument === "--license-source-root") options.licenseSourceRoot = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
    if (
      (argument === "--web-root" || argument === "--output-root" || argument === "--license-source-root") &&
      !argv[index]
    ) {
      throw new Error(`${argument} requires a path`);
    }
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  generatePackageLicenseBundle(parseArguments(process.argv.slice(2)))
    .then((result) => {
      console.log(JSON.stringify(result));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : error);
      process.exitCode = 1;
    });
}
