import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildHarmonyMirrorRelease } from './harmony-mirror-release.mjs';

const [workspace, outputDirectory, ...extra] = process.argv.slice(2);
if (!workspace || !outputDirectory || extra.length) {
  throw new Error('Usage: node scripts/build-harmony-mirror-release.mjs <new-workspace> <new-output-directory>');
}
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
await buildHarmonyMirrorRelease({ projectRoot, workspace: resolve(workspace), outputDirectory: resolve(outputDirectory) });
console.log('Built, signed, officially verified and recorded the ordinary Harmony mirror HAP. Real-device acceptance is still required.');
