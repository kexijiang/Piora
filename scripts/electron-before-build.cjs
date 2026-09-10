/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder loads beforeBuild hooks as CommonJS. */
const { createHash } = require("node:crypto");
const { readFile, writeFile } = require("node:fs/promises");
const { dirname, join, resolve } = require("node:path");

const STOCK_PORTABLE_TEMPLATE_SHA256 = "80fa75cf8cb68f4999eb92afc9f37f8e5b605cb1c3a077821bbc350a9b907a48";
const PRIOR_PIORA_TEMPLATE_SHA256 = "9bbc69b6315e9c1a06e056d2859a95f791794be3358d7ca27b6f417befc90015";

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

module.exports = async function prepareDesktopBuild(context) {
  const projectRoot = resolve(context.appDir, "..");
  const { prepareBuildReleaseNotes } = await import("./create-release-notes.mjs");
  await prepareBuildReleaseNotes(projectRoot);
  const targetPlatform = context.electronPlatformName ?? process.platform;
  if (targetPlatform !== "win32") return true;
  const customTemplatePath = join(projectRoot, "desktop", "build", "portable-cache.nsi");
  const builderPackagePath = require.resolve("app-builder-lib/package.json", { paths: [projectRoot] });
  const stockTemplatePath = join(dirname(builderPackagePath), "templates", "nsis", "portable.nsi");
  const [customTemplate, currentTemplate] = await Promise.all([
    readFile(customTemplatePath),
    readFile(stockTemplatePath),
  ]);
  const currentHash = sha256(currentTemplate);
  const customHash = sha256(customTemplate);
  const isPioraCacheTemplate = currentTemplate.toString("utf8").includes(
    "# PIORA_PORTABLE_CACHE_TEMPLATE_V1",
  );
  if (
    currentHash !== STOCK_PORTABLE_TEMPLATE_SHA256
    && currentHash !== PRIOR_PIORA_TEMPLATE_SHA256
    && currentHash !== customHash
    && !isPioraCacheTemplate
  ) {
    throw new Error(
      `Unsupported electron-builder portable template (${currentHash}); review the cached-runtime override before packaging.`,
    );
  }
  if (currentHash !== customHash) await writeFile(stockTemplatePath, customTemplate);

  // The desktop shell now has its own production dependency
  // (`electron-updater`). Let electron-builder include that dependency graph
  // in app.asar. The postinstall patch makes v26.15.3's workspace collector
  // traverse this package first, so the root web dependency tree is not copied.
  return true;
};
