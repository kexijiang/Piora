import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stageHarmonyMirrorRelease } from './harmony-mirror-release.mjs';

const [resourcesDirectory, targetDirectory, ...extra] = process.argv.slice(2);
if (!resourcesDirectory || !targetDirectory || extra.length) {
  throw new Error('Usage: node scripts/stage-harmony-mirror-artifact.mjs <accepted-resource-directory> <target-harmony-tools-directory>');
}
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
await stageHarmonyMirrorRelease({ projectRoot, resourcesDirectory: resolve(resourcesDirectory), targetDirectory: resolve(targetDirectory) });
console.log('Staged the same-run public unsigned HAP with its private-signing and real-device acceptance receipt.');
