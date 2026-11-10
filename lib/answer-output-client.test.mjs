import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { registerAnswerStateWriter, refreshAnswerState, flushPendingAnswerState, setAnswerStateEnabled } = await jiti.import('./answer-output-client.ts');

test('settled output refresh is scoped and cannot flush or refresh another session', async t => {
  const calls = [];
  for (const id of ['one', 'two']) t.after(registerAnswerStateWriter(id, id, async () => calls.push(`flush:${id}`), async () => calls.push(`refresh:${id}`)));
  await refreshAnswerState('one'); assert.deepEqual(calls, ['refresh:one']);
  await flushPendingAnswerState('two'); assert.deepEqual(calls, ['refresh:one', 'flush:two']);
});

test('disabled output and retired registrations never refresh; replacement owns its registration', async t => {
  const calls = [], old = registerAnswerStateWriter('same', 'one', async () => {}, async () => calls.push('old'));
  const current = registerAnswerStateWriter('same', 'one', async () => {}, async () => calls.push('current')); t.after(current); t.after(() => setAnswerStateEnabled(true));
  old(); setAnswerStateEnabled(false); await refreshAnswerState('one'); assert.deepEqual(calls, []);
  setAnswerStateEnabled(true); await refreshAnswerState('one'); assert.deepEqual(calls, ['current']);
  current(); await refreshAnswerState('one'); assert.deepEqual(calls, ['current']);
});

test('optional refresh failures settle independently while failed writes still block dependent sends', async t => {
  let refreshed = false;
  t.after(registerAnswerStateWriter('fails', 'one', async () => { throw new Error('unsaved'); }, async () => { throw new Error('offline'); }));
  t.after(registerAnswerStateWriter('works', 'one', async () => {}, async () => { refreshed = true; }));
  await refreshAnswerState('one'); assert.equal(refreshed, true);
  await assert.rejects(flushPendingAnswerState('one'), /unsaved/);
});
