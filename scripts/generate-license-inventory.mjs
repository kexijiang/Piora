#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultProjectRoot = resolve(dirname(scriptPath), "..");
const bundledPowerShell = JSON.parse(await readFile(resolve(defaultProjectRoot, "third_party/powershell/manifest.json"), "utf8"));
const REVIEWED_LICENSE_DECLARATIONS = new Map([
  ["format@0.2.2", "MIT"],
  ["khroma@2.1.0", "MIT"],
]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeLicense(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && typeof value.type === "string" && value.type.trim()) {
    return value.type.trim();
  }
  if (Array.isArray(value)) {
    const labels = [...new Set(value.map(normalizeLicense).filter((label) => label !== "UNDECLARED"))];
    if (labels.length > 0) return labels.sort(compareText).join(" OR ");
  }
  return "UNDECLARED";
}

function packageNameFromInstallPath(installPath) {
  const normalized = installPath.replaceAll("\\", "/");
  const marker = "node_modules/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const packagePath = normalized.slice(markerIndex + marker.length);
  const segments = packagePath.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  return segments[0].startsWith("@") && segments.length > 1
    ? `${segments[0]}/${segments[1]}`
    : segments[0];
}

export async function collectLockedPackages({ lock }) {
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== "object") {
    throw new Error("Expected an npm lockfileVersion 3 package-lock.json");
  }

  const packages = new Map();
  for (const [installPath, metadata] of Object.entries(lock.packages)) {
    if (!installPath.includes("node_modules/") || typeof metadata?.version !== "string") continue;
    const name = packageNameFromInstallPath(installPath);
    if (!name) continue;

    const key = `${name}@${metadata.version}`;
    const declaredLicense = normalizeLicense(metadata.license ?? metadata.licenses);
    const license = declaredLicense === "UNDECLARED"
      ? (REVIEWED_LICENSE_DECLARATIONS.get(key) ?? declaredLicense)
      : declaredLicense;
    const existing = packages.get(key);
    if (!existing) {
      packages.set(key, {
        name,
        version: metadata.version,
        license,
        runtime: !metadata.dev,
        optional: Boolean(metadata.optional),
      });
      continue;
    }

    existing.runtime ||= !metadata.dev;
    existing.optional &&= Boolean(metadata.optional);
    if (existing.license === "UNDECLARED" && license !== "UNDECLARED") existing.license = license;
  }

  return [...packages.values()].sort(
    (left, right) => compareText(left.name, right.name) || compareText(left.version, right.version),
  );
}

function renderTable(title, entries) {
  const rows = entries.map(
    ({ name, version, license, optional }) =>
      `| \`${name}\` | \`${version}\` | ${license} | ${optional ? "Yes" : "No"} |`,
  );
  return [
    `## ${title}`,
    "",
    "| Package | Version | Declared license | Optional |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

export function renderLicenseInventory(records, lockfileSha256) {
  const runtime = records.filter((record) => record.runtime);
  const development = records.filter((record) => !record.runtime);
  const undeclared = records.filter((record) => record.license === "UNDECLARED");
  const undeclaredRuntime = runtime.filter((record) => record.license === "UNDECLARED");
  if (undeclaredRuntime.length > 0) {
    throw new Error(
      `Runtime packages require a declared or version-scoped reviewed license: ${undeclaredRuntime
        .map(({ name, version }) => `${name}@${version}`)
        .join(", ")}`,
    );
  }
  return [
    "# Third-party package license inventory",
    "",
    "> Deterministically generated from the committed npm lockfile. Do not edit by hand; run `npm run licenses:generate`.",
    "",
    `Lockfile SHA-256: \`${lockfileSha256}\``,
    "",
    `Unique locked packages: **${records.length}**. Runtime packages: **${runtime.length}**. Build/development-only packages: **${development.length}**.`,
    "",
    "This source inventory records lockfile package-declared license labels plus exact version-scoped reviewed declarations before reviewed postinstall replacements. The packaged application additionally contains a build-derived SBOM, the final package-copy inventory, every published LICENSE/LICENCE/COPYING/NOTICE file, and version-scoped reviewed upstream fallbacks when a compiled npm package omits its required license text. A runtime package marked `UNDECLARED` fails generation.",
    "",
    undeclared.length
      ? `Packages without a declared license: ${undeclared.map(({ name, version }) => `\`${name}@${version}\``).join(", ")}.`
      : "Every locked package declares a license.",
    "",
    renderTable("Runtime dependency closure", runtime),
    "## Bundled Windows PowerShell runtime",
    "",
    `PowerShell ${bundledPowerShell.version} (Windows x64, MIT): [Microsoft release](${bundledPowerShell.source}). The complete self-contained ZIP includes .NET and module dependencies; their upstream license and third-party notices are preserved in resources/powershell. See [provenance](third_party/powershell/SOURCE.md).`,
    "",
    `Archive SHA-256: \`${bundledPowerShell.sha256}\`.`,
    "",
    renderTable("Build and development dependency closure", development),
  ].join("\n");
}

export async function generateLicenseInventory({
  projectRoot = defaultProjectRoot,
  outputPath = resolve(projectRoot, "THIRD_PARTY_LICENSES.md"),
  check = false,
} = {}) {
  const lockPath = resolve(projectRoot, "package-lock.json");
  const lockBytes = await readFile(lockPath);
  // Hash the repository's canonical LF representation. npm can leave a
  // mixed- or CRLF-ending working copy on Windows even when .gitattributes
  // commits package-lock.json with LF, which otherwise makes --check disagree
  // with a clean Linux/Windows checkout of the same Git object.
  const canonicalLockText = lockBytes.toString("utf8").replace(/\r\n?/g, "\n");
  const lock = JSON.parse(canonicalLockText);
  const records = await collectLockedPackages({ lock });
  const lockfileSha256 = createHash("sha256").update(canonicalLockText).digest("hex");
  const output = renderLicenseInventory(records, lockfileSha256);

  if (check) {
    let current;
    try {
      current = await readFile(outputPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`License inventory is missing: ${outputPath}`);
      }
      throw error;
    }
    if (current !== output) {
      throw new Error(
        "THIRD_PARTY_LICENSES.md is stale. Run `npm run licenses:generate` and commit the result.",
      );
    }
    return { checked: true, records, outputPath };
  }

  await writeFile(outputPath, output, "utf8");
  return { checked: false, records, outputPath };
}

function parseArguments(argv) {
  const options = { check: false };
  for (const argument of argv) {
    if (argument === "--check") options.check = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  generateLicenseInventory(parseArguments(process.argv.slice(2)))
    .then(({ checked, records, outputPath }) => {
      console.log(`${checked ? "Verified" : "Wrote"} ${outputPath} (${records.length} unique packages)`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
