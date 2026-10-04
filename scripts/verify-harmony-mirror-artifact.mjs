import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyStagedHarmonyMirrorRelease } from './harmony-mirror-release.mjs';

const [resources, ...extra] = process.argv.slice(2);
if (extra.length) throw new Error('Usage: node scripts/verify-harmony-mirror-artifact.mjs [harmony-tools-resource-directory]');
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
await verifyStagedHarmonyMirrorRelease({ projectRoot,
  resourcesDirectory: resolve(resources ?? resolve(projectRoot, 'third_party/harmony-tools/windows-x64')) });
console.log('Verified ordinary HAP source, same-run provenance, official signature receipt, real-device acceptance and SOURCE.md.');
