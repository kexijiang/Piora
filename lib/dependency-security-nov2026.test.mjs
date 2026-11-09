import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import test from 'node:test';

const require = createRequire(import.meta.url);

test('node-forge rejects small-order Ed25519 keys while accepting generated signatures', () => {
  const { ed25519 } = require('node-forge');
  const message = Buffer.from('Piora dependency security regression');
  const keys = ed25519.generateKeyPair();
  const signature = ed25519.sign({ message, privateKey: keys.privateKey });
  assert.equal(ed25519.verify({ message, signature, publicKey: keys.publicKey }), true);
  const identity = Buffer.alloc(32); identity[0] = 1;
  const forged = Buffer.alloc(64); forged[0] = 1;
  assert.equal(ed25519.verify({ message, signature: forged, publicKey: identity }), false);
});

test('Undici enforces SRI across ASCII whitespace and prefers the strongest digest', async t => {
  const { MockAgent, fetch } = require('undici');
  const dispatcher = new MockAgent();
  dispatcher.disableNetConnect();
  t.after(() => dispatcher.close());
  const body = 'Piora integrity regression';
  dispatcher.get('https://integrity.invalid').intercept({ path: '/', method: 'GET' }).reply(200, body).persist();
  const good = createHash('sha256').update(body).digest('base64');
  const bad = createHash('sha512').update('different').digest('base64');
  for (const whitespace of [' ', '\t', '\n', '\f', '\r']) {
    await assert.rejects(fetch('https://integrity.invalid/', { dispatcher, integrity: `${whitespace}sha512-${bad}` }), new TypeError("fetch failed", { cause: new Error("integrity mismatch") }));
    await assert.rejects(fetch('https://integrity.invalid/', { dispatcher, integrity: `sha256-${good}${whitespace}sha512-${bad}` }), new TypeError("fetch failed", { cause: new Error("integrity mismatch") }));
    const response = await fetch('https://integrity.invalid/', { dispatcher, integrity: `${whitespace}sha256-${good}` });
    assert.equal(await response.text(), body);
  }
});
