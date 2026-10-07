/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder hooks are CommonJS. */
const { writeFile } = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { createPayloadManifest } = require("./portable-payload.cjs");
const contexts = new Map();

function registerPayloadContext(context) {
  if (context.electronPlatformName !== "win32") return;
  if (context.arch !== 1) throw new Error("Portable payload supports only the reviewed Windows x64 target");
  contexts.set(resolve(context.appOutDir), { context, generation: null });
}
async function prepareArtifactPayload(event) {
  if (!["nsis", "portable"].includes(event.targetPresentableName)) return;
  if (contexts.size !== 1) throw new Error("Expected exactly one finalized Windows payload before NSIS compression");
  for (const entry of contexts.values()) {
    const { context } = entry;
    // artifactBuildStarted is emitted by NsisTarget before packArch; this runs
    // after platformPackager's fuses/resource editing/signing, even unsigned.
    entry.generation ??= (async () => {
      // AppPackageHelper normally copies/signs elevate.exe immediately after
      // this event. Run that same idempotent helper first so it is covered too.
      const targets = context.targets.filter(target => ["nsis", "portable"].includes(target.name));
      if (!targets.length || targets.some(target => typeof target.packageHelper?.elevateHelper?.copy !== "function")) throw new Error("Unsupported electron-builder NSIS payload lifecycle");
      for (const target of targets) await target.packageHelper.elevateHelper.copy(context.appOutDir, target);
      const manifest = await createPayloadManifest(context.appOutDir, {
        version: context.packager.appInfo.version,
        executable: `${context.packager.appInfo.productFilename}.exe`,
      });
      await writeFile(join(context.packager.projectDir, "build", "portable-payload-x64.json"), manifest);
    })();
    await entry.generation;
  }
}
module.exports = prepareArtifactPayload;
module.exports.registerPayloadContext = registerPayloadContext;
