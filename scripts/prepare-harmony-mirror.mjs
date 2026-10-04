import { cp, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { includeMirrorSource, readGitHubBuildOrigin, writeMirrorPreparation } from './harmony-mirror-provenance.mjs';

/** Source tree contains no signing configuration. Never overwrite a build workspace. */
export async function prepareHarmonyMirror(destination, options = {}) {
  const sourceDirectory = fileURLToPath(new URL('../third_party/harmony-mirror/', import.meta.url));
  const profile = JSON.parse(await readFile(new URL('../third_party/harmony-mirror/build-profile.json5', import.meta.url), 'utf8'));
  if (profile.app?.signingConfigs !== undefined || profile.app?.products?.some(product => product.signingConfig !== undefined)) {
    throw new Error('The source profile contains signing configuration; build from an unsigned source tree');
  }
  await mkdir(destination, { recursive: false });
  await cp(sourceDirectory, destination, {
    recursive: true, errorOnExist: true, force: false,
    filter: includeMirrorSource,
  });
  const origin = Object.hasOwn(options, 'origin') ? options.origin : process.env.GITHUB_ACTIONS === 'true'
    ? readGitHubBuildOrigin(fileURLToPath(new URL('../', import.meta.url))) : null;
  await writeMirrorPreparation(destination, sourceDirectory, origin);
  return destination;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const destination = process.argv[2];
  if (!destination) throw new Error('Pass a new output directory');
  console.log(await prepareHarmonyMirror(resolve(destination)));
}
