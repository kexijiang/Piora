#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultProjectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STRICT_RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const STRICT_PREVIEW_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-(?:alpha|beta)\.(0|[1-9]\d*)$/;

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function runGit(projectRoot, arguments_, acceptedExitCodes = [0]) {
  const result = spawnSync("git", arguments_, {
    cwd: projectRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (!acceptedExitCodes.includes(result.status)) {
    throw new Error(
      `git ${arguments_.join(" ")} failed (${String(result.status)}): ${result.stderr || result.stdout}`,
    );
  }
  return { status: result.status, stdout: result.stdout.trim() };
}

export async function verifyReleaseMetadata({
  projectRoot = defaultProjectRoot,
  tagName,
  requireOriginMain = false,
  prerelease = false,
}) {
  const match = (prerelease ? STRICT_PREVIEW_TAG : STRICT_RELEASE_TAG).exec(tagName ?? "");
  if (!match) {
    throw new Error(prerelease
      ? `Preview tag must exactly match vX.Y.Z-alpha.N or vX.Y.Z-beta.N: ${tagName ?? ""}`
      : `Release tag must exactly match vX.Y.Z with no prerelease suffix: ${tagName ?? ""}`);
  }
  const version = tagName.slice(1);
  const [rootPackage, desktopPackage, packageLock, changelog] = await Promise.all([
    readJson(resolve(projectRoot, "package.json")),
    readJson(resolve(projectRoot, "desktop", "package.json")),
    readJson(resolve(projectRoot, "package-lock.json")),
    readFile(resolve(projectRoot, "CHANGELOG.md"), "utf8"),
  ]);

  if (rootPackage.version !== version || desktopPackage.version !== version) {
    throw new Error(
      `Tag ${tagName} must match both package versions (root=${rootPackage.version}, desktop=${desktopPackage.version}).`,
    );
  }
  const lockRootVersion = packageLock?.packages?.[""]?.version;
  const lockDesktopVersion = packageLock?.packages?.desktop?.version;
  if (
    packageLock?.version !== version
    || lockRootVersion !== version
    || lockDesktopVersion !== version
  ) {
    throw new Error(
      `Tag ${tagName} must match package-lock versions `
      + `(top-level=${String(packageLock?.version)}, root=${String(lockRootVersion)}, `
      + `desktop=${String(lockDesktopVersion)}).`,
    );
  }
  const changelogHeading = new RegExp(
    `^## \\[${escapeRegularExpression(version)}\\](?: - \\d{4}-\\d{2}-\\d{2})?\\s*$`,
    "m",
  );
  if (!changelogHeading.test(changelog)) {
    throw new Error(`CHANGELOG.md has no release heading for ${version}.`);
  }

  let commit = null;
  if (requireOriginMain) {
    commit = runGit(projectRoot, [
      "rev-parse",
      "--verify",
      `refs/tags/${tagName}^{commit}`,
    ]).stdout;
    const head = runGit(projectRoot, ["rev-parse", "HEAD"]).stdout;
    if (commit !== head) {
      throw new Error(`Checked-out commit ${head} is not the commit referenced by ${tagName} (${commit}).`);
    }
    runGit(projectRoot, ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"]);
    const ancestry = runGit(
      projectRoot,
      ["merge-base", "--is-ancestor", commit, "refs/remotes/origin/main"],
      [0, 1],
    );
    if (ancestry.status !== 0) {
      throw new Error(`Tag ${tagName} does not point to a commit contained in origin/main.`);
    }
  }

  return { tagName, version, rootVersion: rootPackage.version, desktopVersion: desktopPackage.version, commit };
}

async function main() {
  const tagName = process.argv[2] || process.env.GITHUB_REF_NAME;
  const result = await verifyReleaseMetadata({
    tagName,
    requireOriginMain: process.argv.includes("--require-origin-main"),
    prerelease: process.argv.includes("--prerelease"),
  });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
