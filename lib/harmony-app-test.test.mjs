import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareHarmonyFixture } from '../scripts/prepare-harmony-fixture.mjs';
const { BridgeSession } = await createJiti(import.meta.url).import('../tests/harmony-fixture/test-only/BridgeSession.ts');
const packet = { runId:'run-a',deviceInstance:'phone-a',token:'private-test-token',expiresAt:1000,sampleRate:16000,channels:1 };
for (const change of [{ runId:'run-b' },{deviceInstance:'phone-b'},{token:'another-test-token'},{expiresAt:2000},{sampleRate:48000},{channels:2}]) {
  test(`app-test rejects mismatched pairing ${Object.keys(change)[0]}`,()=> {
    const session = new BridgeSession('run-a','phone-a','private-test-token',1000);
    assert.throws(()=>session.consume({...packet,...change},new Uint8Array(1600),500));
  });
}
test('app-test token expires and cannot be replayed; PCM remains byte-identical',()=> {
  const session = new BridgeSession('run-a','phone-a','private-test-token',1000), pcm=new Uint8Array([0,1,2,3]);
  session.consume(packet,pcm,500); assert.deepEqual([...pcm],[0,1,2,3]);
  assert.throws(()=>session.consume(packet,pcm,500));
  assert.throws(()=>new BridgeSession('run-a','phone-a','private-test-token',1000).consume(packet,pcm,1000));
});
test('production fixture excludes the bridge and debug uses the exact tested authorization implementation',async()=> {
  const root=await mkdtemp(join(tmpdir(),'piora-audio-fixture-'));
  try {
    const production=await prepareHarmonyFixture('production',join(root,'production'));
    const debug=await prepareHarmonyFixture('debug',join(root,'debug'));
    await assert.rejects(readFile(join(production,'entry/src/main/ets/bridge/BridgeSession.ets')));
    await assert.rejects(readFile(join(production,'entry/src/main/ets/atlas/AtlasFixture.ets')));
    assert.equal(await readFile(join(debug,'entry/src/main/ets/bridge/BridgeSession.ets'),'utf8'),await readFile(new URL('../tests/harmony-fixture/test-only/BridgeSession.ts',import.meta.url),'utf8'));
    assert.equal(await readFile(join(debug,'entry/src/main/ets/atlas/AtlasFixture.ets'),'utf8'),await readFile(new URL('../tests/harmony-fixture/test-only/AtlasFixture.ets',import.meta.url),'utf8'));
    assert.deepEqual(JSON.parse(await readFile(join(debug,'build-profile.json5'),'utf8')).app.buildModeSet,[{name:'debug'}]);
  } finally {await rm(root,{recursive:true,force:true});}
});
