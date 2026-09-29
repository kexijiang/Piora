import { cp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
export async function prepareHarmonyFixture(mode, destination) {
  if (!['production', 'debug'].includes(mode)) throw new Error('Use production or debug');
  await mkdir(destination, { recursive: false });
  const root = resolve('tests/harmony-fixture');
  await cp(join(root, 'base'), destination, { recursive: true });
  if (mode === 'debug') {
    const ets = join(destination, 'entry/src/main/ets');
    await mkdir(join(ets, 'bridge'));
    for (const file of ['BridgeSession.ts', 'PcmTestInputSource.ets', 'TestBridge.ets']) await cp(join(root, 'test-only', file), join(ets, 'bridge', file.replace(/\.ts$/, '.ets')));
    await cp(join(root, 'test-only/EntryAbility.ets'), join(ets, 'entryability/EntryAbility.ets'));
    await cp(join(root, 'test-only/TestIndex.ets'), join(ets, 'pages/TestIndex.ets'));
    await mkdir(join(ets, 'atlas'));
    await cp(join(root, 'test-only/AtlasFixture.ets'), join(ets, 'atlas/AtlasFixture.ets'));
    await writeFile(join(destination, 'entry/src/main/resources/base/profile/main_pages.json'), JSON.stringify({ src: ['pages/TestIndex', 'pages/Index'] }));
    const config = join(destination, 'build-profile.json5');
    const content = JSON.parse(await readFile(config, 'utf8')); content.app.buildModeSet = [{ name: 'debug' }];
    await writeFile(config, JSON.stringify(content, null, 2));
  } else {
    const walk = async directory => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (/TestBridge|PcmTestInputSource|pioraPcmPacket|appTestPairing|BridgeSession/.test(await readFile(path, 'utf8'))) throw new Error(`Production contains debug bridge: ${entry.name}`);
      }
    };
    await walk(destination);
  }
  return destination;
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, destination] = process.argv.slice(2);
  if (!destination) throw new Error('Pass a new output directory; existing projects are never overwritten');
  console.log(await prepareHarmonyFixture(mode, resolve(destination)));
}
