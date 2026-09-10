#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { extractFile } from '@electron/asar';
import { createIsolatedProcessEnvironment, prepareIsolatedEnvironment } from './isolated-process-env.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Load the actual packaged FFI and SQLite worker outside every developer node_modules ancestor. */
export async function verifyPackagedClipboard(applicationRoot) {
  const root = resolve(applicationRoot), archive = join(root, 'resources/app.asar');
  const modules = (await readdir(join(projectRoot, 'desktop/dist'))).filter(name => /^clipboard-.*\.js$/.test(name));
  assert.ok(modules.includes('clipboard-worker.js') && modules.includes('clipboard-windows.js'));
  for (const name of modules) assert.deepEqual(extractFile(archive, 'dist/' + name), await readFile(join(projectRoot, 'desktop/dist', name)), 'packaged clipboard module differs from the compiled source: ' + name);
  for (const file of ['node_modules/koffi/index.cjs', 'node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node']) {
    assert.ok((await readFile(join(archive + '.unpacked', file))).length > 0, 'required native dependency is unpacked: ' + file);
  }
  const temporary = await mkdtemp(join(tmpdir(), 'piora-packaged-clipboard-'));
  let child;
  try {
    await prepareIsolatedEnvironment(temporary);
    const app = join(temporary, 'application/app.asar');
    await mkdir(dirname(app), { recursive: true });
    await cp(archive, app);
    await cp(archive + '.unpacked', app + '.unpacked', { recursive: true });
    const reportFile = join(temporary, 'report.json'), probe = join(temporary, 'probe.cjs');
    await writeFile(probe, `
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { writeFileSync } = require('node:fs');
const request = createRequire(${JSON.stringify(join(app, 'package.json'))});
(async () => {
  const koffiPath = request.resolve('koffi');
  assert.ok(koffiPath.startsWith(${JSON.stringify(dirname(app))}));
  const koffi = request('koffi');
  assert.equal(typeof koffi.load, 'function');
  const { WindowsClipboard } = request('./dist/clipboard-windows.js');
  const native = new WindowsClipboard();
  const sequence = native.currentSequence();
  assert.ok(Number.isSafeInteger(sequence)); native.close();
  const { ClipboardStore } = request('./dist/clipboard-store.js');
  const store = new ClipboardStore(${JSON.stringify(join(temporary, 'history'))});
  try {
    await store.start();
    const id = await store.capture({ text: 'packaged clipboard verification 中文😀', html: '<b>packaged clipboard verification</b>' });
    await store.mutate({ type: 'remark', id, value: 'packaged note' });
    await store.mutate({ type: 'shelf-add', ids: [id] });
    const detail = await store.detail(id);
    assert.equal(detail.text, 'packaged clipboard verification 中文😀');
    assert.equal(detail.remark, 'packaged note');
    assert.equal((await store.query({ text: 'packaged' })).items.length, 1);
    assert.equal((await store.status()).shelf, 1);
  } finally { await store.close(); }
  writeFileSync(${JSON.stringify(reportFile)}, JSON.stringify({ electron: process.versions.electron, node: process.versions.node, koffi: koffi.version, ffiLoaded: true, windowsMetadataCall: true, workerFromAsar: true, isolatedDependencies: true, systemClipboardWritten: false }));
})().catch(error => { console.error(error); process.exitCode = 1; });
`);
    let output = '';
    child = spawn(join(root, 'Piora.exe'), [probe], { cwd: temporary, env: createIsolatedProcessEnvironment(temporary, { ELECTRON_RUN_AS_NODE: '1' }), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { output = (output + data).slice(-32000); });
    child.stderr.on('data', data => { output = (output + data).slice(-32000); });
    await new Promise((resolveExit, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Packaged clipboard probe timed out\n' + output)); }, 60000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); code === 0 ? resolveExit() : reject(new Error('Packaged clipboard probe failed\n' + output)); });
    });
    return { ...JSON.parse(await readFile(reportFile, 'utf8')), sourceModulesVerified: modules.length };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolveExit => child.once('exit', resolveExit)); child.kill(); await exited;
    }
    assert.equal(dirname(temporary), resolve(tmpdir()));
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyPackagedClipboard(process.argv[2] ?? join(projectRoot, 'desktop/release/win-unpacked'))
    .then(report => console.log(JSON.stringify(report, null, 2)))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
