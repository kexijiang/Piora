import assert from 'node:assert/strict';
import test from 'node:test';
import { createAsyncSnapshotCache } from './async-snapshot-cache.ts';

test('coalesces concurrent loads and expires from completion, not request time', async t => {
  let now=0, loads=0, finish;
  t.mock.method(Date,'now',()=>now);
  const cache=createAsyncSnapshotCache(1000);
  const load=()=>{loads++;return new Promise(resolve=>{finish=resolve;});};
  const a=cache.get('repo',load), b=cache.get('repo',load);
  assert.equal(a,b); await Promise.resolve(); assert.equal(loads,1);
  now=5000; finish({files:[]}); await a;
  assert.equal(cache.get('repo',load),a);
  now=6001; const fresh=cache.get('repo',async()=>({files:['a']}));
  assert.notEqual(fresh,a); assert.deepEqual(await fresh,{files:['a']});
});

test('invalidation fences late loads, failures retry, and capacity evicts old snapshots', async () => {
  const cache=createAsyncSnapshotCache(10000,2);
  let finish;
  const old=cache.get('repo',()=>new Promise(resolve=>{finish=resolve;}));
  await Promise.resolve(); cache.invalidate();
  const current=cache.get('repo',async()=> 'new');
  finish('old'); await old; await current;
  assert.equal(await cache.get('repo',async()=> 'wrong'),'new');
  await assert.rejects(cache.get('bad',async()=>{throw new Error('temporary');}));
  assert.equal(await cache.get('bad',async()=> 'recovered'),'recovered');
  await cache.get('third',async()=>3);
  assert.equal(await cache.get('repo',async()=> 'reloaded'),'reloaded');
});
