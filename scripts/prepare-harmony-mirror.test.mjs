import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { prepareHarmonyMirror } from './prepare-harmony-mirror.mjs';

async function presenceClock() {
  const source = await readFile(new URL('../third_party/harmony-mirror/entry/src/main/ets/CapturePresence.ets', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  let now = 0, nextId = 0, stops = 0;
  const timers = new Map();
  const context = { exports: {}, Date: { now: () => now },
    setTimeout: (callback, delay) => { const id = ++nextId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id) };
  vm.runInNewContext(compiled, context);
  const guard = new context.exports.CapturePresence(() => stops++);
  return { guard, timers, get stops() { return stops; },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
    } };
}

test('transport presence without an explicit request never schedules an absence stop', async () => {
  const clock = await presenceClock();
  for (const present of [false, true, false]) clock.guard.presenceChanged(present);
  clock.advance(60000);
  assert.equal(clock.timers.size, 0);
  assert.equal(clock.stops, 0);
});

test('a fresh explicit request receives a full deadline and fences an old disconnect callback', async () => {
  const clock = await presenceClock();
  clock.guard.requestCapture();
  clock.guard.presenceChanged(true);
  clock.guard.presenceChanged(false);
  const stale = [...clock.timers.values()][0].callback;
  clock.advance(4900);
  clock.guard.requestCapture();
  stale();
  assert.equal(clock.stops, 0);
  clock.advance(29999);
  assert.equal(clock.stops, 0);
  clock.advance(1);
  assert.equal(clock.stops, 1);
  assert.equal(clock.timers.size, 0);
});

test('a current request keeps five seconds offline and reconnect fences a queued stop', async () => {
  const clock = await presenceClock();
  clock.guard.requestCapture();
  clock.guard.presenceChanged(true);
  clock.guard.presenceChanged(false);
  const stale = [...clock.timers.values()][0].callback;
  clock.advance(4999);
  clock.guard.presenceChanged(true);
  stale();
  clock.advance(30000);
  assert.equal(clock.stops, 0);
  assert.equal(clock.timers.size, 0);
  clock.guard.presenceChanged(false);
  clock.advance(4999);
  assert.equal(clock.stops, 0);
  clock.advance(1);
  assert.equal(clock.stops, 1);
});

test('repeated offline notices do not extend request or disconnect deadlines', async () => {
  const clock = await presenceClock();
  clock.guard.requestCapture();
  const requestTimer = [...clock.timers.keys()][0];
  clock.advance(10000);
  clock.guard.presenceChanged(false);
  assert.equal([...clock.timers.keys()][0], requestTimer);
  clock.advance(19999);
  assert.equal(clock.stops, 0);
  clock.advance(1);
  assert.equal(clock.stops, 1);
  clock.guard.requestCapture();
  clock.guard.presenceChanged(true);
  clock.guard.presenceChanged(false);
  const disconnectTimer = [...clock.timers.keys()][0];
  clock.advance(4000);
  clock.guard.presenceChanged(false);
  assert.equal([...clock.timers.keys()][0], disconnectTimer);
  clock.advance(999);
  assert.equal(clock.stops, 1);
  clock.advance(1);
  assert.equal(clock.stops, 2);
});

test('cancelRequest fences callbacks and preserves an idle viewer for the next explicit request', async () => {
  const clock = await presenceClock();
  clock.guard.requestCapture();
  const stale = [...clock.timers.values()][0].callback;
  clock.guard.cancelRequest();
  stale();
  for (const present of [true, false]) clock.guard.presenceChanged(present);
  clock.advance(60000);
  assert.equal(clock.stops, 0);
  assert.equal(clock.timers.size, 0);
  clock.guard.presenceChanged(true);
  clock.guard.cancelRequest();
  clock.guard.requestCapture();
  assert.equal(clock.timers.size, 0);
  clock.guard.presenceChanged(false);
  clock.advance(5000);
  assert.equal(clock.stops, 1);
});

test('cancelling an active request invalidates its viewer and the next request gets a fresh deadline', async () => {
  const clock = await presenceClock();
  clock.guard.presenceChanged(true);
  clock.guard.requestCapture();
  assert.equal(clock.timers.size, 0);
  clock.guard.cancelRequest();
  clock.guard.requestCapture();
  const stale = [...clock.timers.values()][0].callback;
  clock.advance(29999);
  assert.equal(clock.stops, 0);
  clock.guard.requestCapture();
  stale();
  clock.advance(29999);
  assert.equal(clock.stops, 0);
  clock.advance(1);
  assert.equal(clock.stops, 1);
});

test('an expired explicit request cannot be revived by transport notices', async () => {
  const clock = await presenceClock();
  clock.guard.requestCapture();
  clock.advance(29999);
  assert.equal(clock.stops, 0);
  clock.advance(1);
  assert.equal(clock.stops, 1);
  for (const present of [true, false]) clock.guard.presenceChanged(present);
  clock.advance(60000);
  assert.equal(clock.stops, 1);
  assert.equal(clock.timers.size, 0);
});

test('dispose cancels requests, fences pending callbacks and clears transport presence', async () => {
  const clock = await presenceClock();
  clock.guard.requestCapture();
  const stale = [...clock.timers.values()][0].callback;
  clock.guard.dispose();
  stale();
  clock.guard.presenceChanged(false);
  clock.advance(30000);
  assert.equal(clock.stops, 0);
  assert.equal(clock.timers.size, 0);
  clock.guard.presenceChanged(true);
  clock.guard.dispose();
  clock.guard.requestCapture();
  clock.advance(29999);
  assert.equal(clock.stops, 0);
  clock.advance(1);
  assert.equal(clock.stops, 1);
});

test('mirror build workspace retains its ordinary entry and never overwrites an existing project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'piora-mirror-source-'));
  const destination = join(root, 'source');
  try {
    await prepareHarmonyMirror(destination);
    const profile = JSON.parse(await readFile(join(destination, 'build-profile.json5'), 'utf8'));
    assert.equal(profile.app.signingConfigs, undefined);
    assert.equal(profile.app.products.some(product => product.signingConfig !== undefined), false);
    const moduleInfo = JSON.parse(await readFile(join(destination, 'entry/src/main/module.json5'), 'utf8')).module;
    assert.equal(moduleInfo.mainElement, 'EntryAbility');
    assert.deepEqual(moduleInfo.requestPermissions, [{ name: 'ohos.permission.INTERNET' }, { name: 'ohos.permission.KEEP_BACKGROUND_RUNNING' }]);
    assert.deepEqual(moduleInfo.abilities[0].backgroundModes, ['avPlaybackAndRecord']);
    const sourceBefore = await readFile(join(destination, 'entry/src/main/ets/pages/MirrorPage.ets'), 'utf8');
    await assert.rejects(prepareHarmonyMirror(destination), error => error.code === 'EEXIST');
    assert.equal(await readFile(join(destination, 'entry/src/main/ets/pages/MirrorPage.ets'), 'utf8'), sourceBefore);
  } finally { await rm(root, { recursive: true, force: true }); }
});
