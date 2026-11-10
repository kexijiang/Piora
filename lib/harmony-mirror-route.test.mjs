import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { alias: { '@': join(import.meta.dirname, '..') } });
const shared = await jiti.import('../app/api/harmony/_shared.ts');
const errors = await jiti.import('./harmony/errors.ts');
const source = await readFile(new URL('../app/api/harmony/video/route.ts', import.meta.url), 'utf8');

test('keyframe route authenticates and validates generation before touching capture', async t => {
  const previous = process.env.PI_DESKTOP_TOKEN; process.env.PI_DESKTOP_TOKEN = 'a'.repeat(64);
  t.after(() => { if (previous === undefined) delete process.env.PI_DESKTOP_TOKEN; else process.env.PI_DESKTOP_TOKEN = previous; });
  const calls = [], exports = {};
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, URL, Response,
    require(name) {
      if (name === '../_shared') return shared;
      if (name === '@/lib/harmony/errors') return errors;
      if (name === '@/lib/harmony/media/stream-start') return {};
      if (name === '@/lib/harmony') return { getHarmonyDeviceManager: () => ({ requestVideoKeyframe: (...args) => calls.push(args) }) };
      throw new Error(`Unexpected import ${name}`);
    },
  });
  const request = (query, auth = true, origin) => new Request(`http://localhost:30141/api/harmony/video?${query}`, {
    method: 'POST', headers: { host: 'localhost:30141', ...(auth ? { 'x-pi-desktop-token': process.env.PI_DESKTOP_TOKEN } : {}), ...(origin ? { origin } : {}) },
  });
  assert.equal((await exports.POST(request('serial=phone&generation=3', false))).status, 403);
  assert.equal((await exports.POST(request('serial=phone&generation=3', true, 'https://untrusted.example'))).status, 403);
  for (const query of ['serial=phone', 'generation=3', 'serial=phone&generation=NaN', 'serial=phone&generation=-1', 'serial=phone&generation=1.5']) {
    assert.equal((await exports.POST(request(query))).status, 400);
  }
  assert.deepEqual(calls, []);
  const response = await exports.POST(request('serial=phone&generation=3'));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { requested: true });
  assert.deepEqual(calls.map(args => Array.from(args)), [['phone', 3]]);
  assert.match(response.headers.get('cache-control'), /no-store/);
});
