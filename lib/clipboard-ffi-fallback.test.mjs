import test from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);

test('unknown clipboard owner is not attributed to the foreground application', () => {
  const { WindowsClipboard } = require('../desktop/dist/clipboard-windows.js');
  const unknown = { name: '未知应用', executable: '' };
  const source = WindowsClipboard.prototype.clipboardSource.call({
    owner: () => null,
    foreground: () => 123n,
    sourceFor: handle => handle === 0n ? unknown : { name: 'Unrelated foreground', executable: 'other.exe' },
  });
  assert.deepEqual(source, unknown);
});

test('missing FFI binding leaves clipboard history and polling available', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'piora-clipboard-ffi-fallback-'));
  const originalLoad = Module._load, powerMonitor = new EventEmitter();
  let currentText = 'baseline', ffiLoads = 0, runtime;
  Module._load = function (name, ...args) {
    if (name === 'koffi') { ffiLoads++; throw new Error('injected missing platform FFI binding'); }
    if (name === 'electron') return { powerMonitor, nativeImage: {}, clipboard: {
      availableFormats: () => ['text/plain'], readText: () => currentText, readHTML: () => '', readRTF: () => '',
      write: value => { currentText = value.text; }, writeText: value => { currentText = value; },
    } };
    return originalLoad.call(this, name, ...args);
  };
  try {
    for (const file of ['../desktop/dist/clipboard-runtime.js', '../desktop/dist/clipboard-windows.js']) delete require.cache[require.resolve(file)];
    const { ClipboardRuntime } = require('../desktop/dist/clipboard-runtime.js');
    assert.equal(ffiLoads, 0, 'importing the desktop runtime does not load a native platform binding');
    runtime = new ClipboardRuntime(directory); await runtime.start({});
    const status = await runtime.status();
    assert.equal(status.storage, 'ready'); assert.equal(status.listener, 'polling'); assert.equal(status.canPaste, false);
    if (process.platform === 'win32') { assert.equal(ffiLoads, 1); assert.match(status.error, /injected missing platform FFI binding/); }
    else assert.equal(ffiLoads, 0, 'non-Windows initialization never attempts the Windows FFI');
    currentText = 'fallback collection 中文😀'; await runtime.capture(true);
    const page = await runtime.store.query({ text: 'fallback collection' }); assert.equal(page.items.length, 1);
    const copied = await runtime.operate({ ids: [page.items[0].id] }, false, () => {});
    assert.equal(copied.status, 'copied'); assert.equal(currentText, 'fallback collection 中文😀');
    const paste = await runtime.operate({ ids: [page.items[0].id] }, true, () => {});
    assert.equal(paste.status, 'no-target', 'fallback copies content and asks for manual paste');
    if (process.platform === 'win32') assert.match((await runtime.status()).error, /injected missing platform FFI binding/, 'successful collection keeps the native degradation visible');
    await runtime.mutate({ type: 'settings', value: { enabled: true, excludedApps: ['excluded.exe'] } });
    currentText = 'unknown source must respect application exclusions';
    await runtime.capture(false);
    await assert.rejects(runtime.capture(true), /来源应用禁止记录/);
    assert.equal((await runtime.store.query({ text: 'unknown source' })).items.length, 0);
    await runtime.mutate({ type: 'settings', value: { enabled: false, excludedApps: [] } });
    currentText = 'explicit collection available again'; await runtime.capture(true);
    assert.equal((await runtime.store.query({ text: 'explicit collection' })).items.length, 1);
    await runtime.stop(); runtime = null;
    assert.equal(powerMonitor.listenerCount('lock-screen'), 0); assert.equal(powerMonitor.listenerCount('unlock-screen'), 0);
  } finally {
    Module._load = originalLoad;
    await runtime?.stop();
    assert.equal(dirname(directory), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
