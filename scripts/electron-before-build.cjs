/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder loads beforeBuild hooks as CommonJS. */
const { resolve } = require("node:path");

module.exports = async function prepareDesktopBuild(context) {
  const projectRoot = resolve(context.appDir, "..");
  const targetPlatform = context.electronPlatformName ?? process.platform;
  const { prepareBuildReleaseNotes } = await import("./create-release-notes.mjs");
  await prepareBuildReleaseNotes(projectRoot);
  if (targetPlatform !== "win32") return true;
  const { stagePowerShell } = await import("./stage-powershell.mjs");
  await stagePowerShell(projectRoot);
  const { stagePortableExtractor } = await import("./stage-portable-extractor.mjs");
  await stagePortableExtractor(projectRoot);
  // The desktop shell now has its own production dependency
  // (`electron-updater`). Let electron-builder include that dependency graph
  // in app.asar. The postinstall patch makes v26.18.0's workspace collector
  // traverse this package first. Upstream's one-dependency overlap check alone
  // cannot reject a root web tree sharing koffi but missing electron-updater.
  return true;
};
