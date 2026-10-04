import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const boundedJson = await jiti.import('./bounded-json.ts');
const { HarmonyError } = await jiti.import('./harmony/errors.ts');
const { hasJsonContentType } = await jiti.import('./request-security.ts');
const source = await readFile(new URL('../app/api/harmony/device-terminal/route.ts', import.meta.url), 'utf8');

function runtime(authorized = true) {
  const calls = [], exports = {};
  const json = (body, init) => Response.json(body, init);
  runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, {
    exports, TextEncoder, ReadableStream, Response, URL, setInterval, clearInterval,
    require(name) {
      if (name === '@/lib/bounded-json') return boundedJson;
      if (name === '@/lib/request-security') return { hasJsonContentType };
      if (name === '@/lib/harmony/errors') return { HarmonyError };
      if (name === '@/lib/harmony/device-terminal') return {
        startDeviceTerminal(...args) { calls.push({ action: 'start', args }); return 'owned-terminal'; },
        controlDeviceTerminal(...args) { calls.push({ action: 'control', args }); },
      };
      if (name === '../_shared') return {
        requireHarmonyAccess() { return authorized ? null : json({ error: 'unauthorized' }, { status: 401 }); },
        noStoreJson: json,
        harmonyErrorResponse(error) { return json({ error: error.message }, { status: 400 }); },
      };
      throw new Error(`Unexpected route import: ${name}`);
    },
  });
  return { api: exports, calls };
}

function inputRequest(data) {
  return new Request('http://owned.test/api/harmony/device-terminal', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'input', id: 'owned-terminal', leaseToken: 'owned-token', data }),
  });
}

test('terminal route accepts the full reviewed Chinese paste and JSON-escaped character budgets', async () => {
  const { api, calls } = runtime();
  for (const data of ['汉'.repeat(16_000), '\uD800'.repeat(16_000)]) {
    const request = inputRequest(data);
    assert.ok(new TextEncoder().encode(await request.clone().text()).length > 24 * 1024);
    const response = await api.POST(request);
    assert.equal(response.status, 200);
    assert.equal(calls.at(-1).args[3], data);
  }
  assert.equal(calls.length, 2);
});

test('terminal route rejects excessive declared and streamed bodies before dispatch', async () => {
  const { api, calls } = runtime();
  const declared = inputRequest('pwd\r');
  declared.headers.set('content-length', String(128 * 1024 + 1));
  assert.equal((await api.POST(declared)).status, 413);
  const streamed = inputRequest('汉'.repeat(50_000));
  assert.equal(streamed.headers.has('content-length'), false);
  assert.equal((await api.POST(streamed)).status, 413);
  assert.equal(calls.length, 0);
});

test('terminal route authenticates before reading a body and validates tab identities', async () => {
  const denied = runtime(false), request = inputRequest('汉'.repeat(50_000));
  assert.equal((await denied.api.POST(request)).status, 401);
  assert.equal(request.bodyUsed, false);
  assert.equal(denied.calls.length, 0);

  const allowed = runtime();
  const start = new Request('http://owned.test/api/harmony/device-terminal', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'start', serial: 'phone', leaseToken: 'owned-token', kind: 'shared', clientTerminalId: 42 }),
  });
  assert.equal((await allowed.api.POST(start)).status, 400);
  assert.equal(allowed.calls.length, 0);
});
