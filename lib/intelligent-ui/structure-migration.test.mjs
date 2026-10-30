import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createJiti } from 'jiti';
import { SessionManager } from '@earendil-works/pi-coding-agent';
const jiti = createJiti(import.meta.url);
const { UiGenerationPrototype, generationJournalPath, generationDigest, copyGenerationJournal } = await jiti.import('./generation-journal.ts');
const { compileUiPlan } = await jiti.import('./plan.ts');
const { authorizeUiMigration, revokeUiMigrationAuthorization } = await jiti.import('./migration-authorization.ts');
const { readOnlySessionManager } = await jiti.import('../session-readonly-manager.ts');
const { readUiOutput } = await jiti.import('./read-output.ts');
const { assessUiMigration } = await jiti.import('./structure-migration.ts');
const plan = () => ({ planVersion: 1, id: 'bill', title: 'Bill', inputs: [
  { id: 'people', valueType: 'number', label: 'People', value: 4, min: 1, max: 20 },
  { id: 'price', valueType: 'number', label: 'Cost', unit: 'yuan', value: 20, min: 0 }],
  derived: [], views: [{ id: 'total', kind: 'metric', label: 'Total', value: { input: 'people' } }] });
const changed = () => { const value = plan(); value.inputs[1].unit = 'cents'; value.inputs[1].value = 2000; return value; };
async function fixture(t, fault) {
  const root = mkdtempSync(join(tmpdir(), 'piora-structure-migration-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()))); rmSync(root, { recursive: true, force: true }); });
  const manager = SessionManager.create(root, join(root, 'sessions'));
  manager.appendMessage({ role: 'user', content: 'Create', timestamp: Date.now() });
  const host = new UiGenerationPrototype({ manager, root, runId: 'original-run', fault });
  await host.startRun();
  const f = { root, manager, host, journalPath: generationJournalPath(manager.getSessionId(), root) };
  const first = await candidate(f, 'first', plan(), 1);
  const commit = await host.commitCandidate(first.operationId);
  await host.saveParameters(first.operationId, commit.stateRevision, { people: 6, price: 30 });
  return { ...f, first, read: () => JSON.parse(readFileSync(f.journalPath, 'utf8')) };
}
async function candidate(f, callId, value, revision) {
  const context = await f.host.captureContext('bill');
  const messageEntryId = f.manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: callId, name: 'piora_render_ui_plan', arguments: value }], timestamp: Date.now() });
  const item = await f.host.createCandidate(context.contextId, callId, compileUiPlan(value, { revision }));
  const receipt = await f.host.persistCandidate(item.operationId);
  await f.host.observePersistedCandidate(item.operationId, { messageEntryId, toolResultEntryIds: [receipt.entryId] });
  return { ...item, receipt };
}
async function proposal(f, value = changed()) {
  const item = await candidate(f, 'change', value, 2);
  await assert.rejects(f.host.commitCandidate(item.operationId), error => error.code === 'MIGRATION_REQUIRED');
  const review = await f.host.prepareMigration(item.operationId);
  return { item, review };
}
async function ready(f, withLabel = false) {
  const p = await proposal(f);
  f.manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Please review the changes.' }], timestamp: Date.now() });
  if (withLabel) f.manager.appendLabelChange(f.manager.getLeafId(), 'Review point');
  await f.host.finishRun('idle');
  return { ...p, review: await f.host.readMigration('change') };
}
function authorization(f, review, decision = 'confirm', state = review.suggestedState, requestId = 'click-1', options = {}) {
  const input = { proposalId: review.proposalId, digest: review.digest, leafId: review.leafId, requestId, decision, state };
  const grant = authorizeUiMigration({ identity: { sessionId: f.manager.getSessionId(), runId: 'new-user-click' },
    proposalId: input.proposalId, digest: input.digest, choiceDigest: generationDigest({ decision, state: decision === 'confirm' ? state : {} }),
    isActive: () => true, assertOwned: () => {}, ...options });
  return { input, grant };
}

test('incompatible meanings wait for normal completion, explicit values and a new publication anchor', async t => {
  const f = await fixture(t), p = await proposal(f);
  assert.equal(p.review.status, 'provisional');
  assert.deepEqual(p.review.suggestedState, { people: 6, price: 2000 }, 'no automatic yuan-to-cents conversion');
  assert.deepEqual(p.review.fields.map(field => field.change), ['compatible', 'changed']);
  const early = authorization(f, p.review);
  await assert.rejects(f.host.confirmMigration(early.input, early.grant), error => error.code === 'CANCELLED');
  await f.host.finishRun('idle');
  const review = await f.host.readMigration('change'), beforeConfirmation = f.manager.getLeafId();
  assert.equal(review.status, 'ready');
  const { input, grant } = authorization(f, review, 'confirm', { people: 6, price: 3000 });
  await assert.rejects(f.host.confirmMigration(input, { kind: 'host-ui-migration' }), /authorized/);
  const result = await f.host.confirmMigration(input, grant);
  assert.equal(result.status, 'committed'); assert.notEqual(result.entryId, p.item.receipt.entryId);
  assert.deepEqual((await f.host.readActive('bill')).state, { people: 6, price: 3000 });
  const entry = f.manager.getEntry(result.entryId); assert.equal(entry.type, 'custom');
  assert.equal(entry.customType, 'piora-ui-confirmation');
  assert.deepEqual(await f.host.confirmMigration(input, grant), result, 'same click is idempotent');
  assert.equal(f.manager.getEntries().filter(entry => entry.customType === 'piora-ui-confirmation').length, 1);
  const historical = new UiGenerationPrototype({ root: f.root, manager: readOnlySessionManager(f.manager.getSessionFile(), { leafId: beforeConfirmation }) });
  assert.deepEqual((await historical.readActive('bill')).state, { people: 6, price: 30 });
  assert.equal((await historical.readOutput('change')).publication.status, 'candidate');
  assert.equal((await historical.readDecisionRecords()).records[0].surface.revision, 1);
  assert.equal(await historical.readMigration('change'), null);
});

test('field comparison protects removed values, range, choice and type changes without converting them', () => {
  const before = { version: 1, id: 'form', revision: 1, title: 'Fields', nodes: [
    { id: 'count', type: 'number', label: 'Count', min: 0, max: 20, value: 4 },
    { id: 'choice', type: 'select', label: 'Choice', options: ['A', 'B'], value: 'A' },
    { id: 'remove', type: 'checkbox', label: 'Old flag', value: false },
  ] };
  const after = { ...before, revision: 2, nodes: [
    { ...before.nodes[0], max: 10 },
    { ...before.nodes[1], options: ['A', 'C'] },
    { id: 'new', type: 'checkbox', label: 'New flag', value: false },
  ] };
  const result = assessUiMigration({ surface: before, state: { count: 17, choice: 'B', remove: true } }, { surface: after, semantics: [] });
  assert.equal(result.requiresConfirmation, true);
  assert.deepEqual(result.fields.map(field => field.change), ['changed', 'changed', 'added', 'removed']);
  assert.deepEqual(result.suggestedState, { count: 4, choice: 'A', new: false });
  assert.equal(result.fields.at(-1).savedValue, true);
  const typed = assessUiMigration({ surface: before, state: { count: 17, choice: 'B', remove: true } },
    { surface: { ...before, nodes: [{ id: 'count', type: 'checkbox', label: 'Count', value: false }, ...before.nodes.slice(1)] }, semantics: [] });
  assert.equal(typed.fields[0].change, 'changed'); assert.equal(typed.suggestedState.count, false);
});

test('abort, abnormal completion and a crashed provisional proposal never become ready', async t => {
  for (const reason of ['abort', 'error', 'destroy', 'fork', 'restart']) {
    const f = await fixture(t); await proposal(f);
    if (reason === 'restart') await new UiGenerationPrototype({ manager: f.manager, root: f.root }).startRun();
    else await f.host.finishRun(reason);
    assert.equal(f.read().records[1].status, 'aborted');
    assert.equal((await f.host.readMigration('change')).status, 'cancelled');
    assert.deepEqual((await f.host.readActive('bill')).state, { people: 6, price: 30 });
  }
});

test('ready proposals survive reopen but edits, branch moves and tampering prevent publication', async t => {
  for (const cause of ['values', 'branch', 'tamper']) {
    const f = await fixture(t), p = await ready(f);
    const restored = new UiGenerationPrototype({ manager: SessionManager.open(f.manager.getSessionFile()), root: f.root });
    assert.equal((await restored.readMigration('change')).status, 'ready');
    const { input, grant } = authorization(f, p.review);
    if (cause === 'values') {
      const active = await f.host.readActive('bill'); await f.host.saveParameters(active.operationId, active.stateRevision, { people: 9, price: 30 });
    } else if (cause === 'branch') f.manager.appendMessage({ role: 'user', content: 'another question', timestamp: Date.now() });
    else {
      const lines = readFileSync(f.manager.getSessionFile(), 'utf8').trim().split('\n').map(JSON.parse);
      lines.find(entry => entry.id === p.item.receipt.entryId).message.content[0].text = 'changed';
      writeFileSync(f.manager.getSessionFile(), lines.map(JSON.stringify).join('\n') + '\n');
    }
    await assert.rejects(f.host.confirmMigration(input, grant));
    assert.equal(f.read().records[1].status, 'aborted');
    assert.equal(f.read().records[1].migration.status, 'stale');
  }
});

test('confirmation crash windows need a fresh explicit grant and replay without duplicate entries', async t => {
  for (const stage of ['confirmation-intent', 'confirmation-entry', 'confirmation-receipt', 'migration-committed']) {
    let injected = false;
    const f = await fixture(t, reached => { if (!injected && reached === stage) { injected = true; throw new Error('injected'); } });
    const p = await ready(f), { input, grant } = authorization(f, p.review, 'confirm', { people: 6, price: 2500 });
    await assert.rejects(f.host.confirmMigration(input, grant), /injected/); revokeUiMigrationAuthorization(grant);
    const fresh = new UiGenerationPrototype({ manager: f.manager, root: f.root });
    await assert.rejects(fresh.confirmMigration(input, grant), /authorized/);
    const review = await fresh.readMigration('change');
    if (stage !== 'migration-committed') {
      assert.equal(review.status, 'ready'); assert.deepEqual(review.pendingConfirmation, { requestId: 'click-1', state: { people: 6, price: 2500 } });
      assert.deepEqual((await fresh.readActive('bill')).state, { people: 6, price: 30 });
    }
    const next = authorization(f, review, 'confirm', { people: 6, price: 2500 });
    assert.equal((await fresh.confirmMigration(next.input, next.grant)).status, 'committed');
    assert.equal(f.manager.getEntries().filter(entry => entry.customType === 'piora-ui-confirmation').length, 1);
  }
});

test('cancel stays terminal, pending intents can be cancelled, and compatible fields cannot be overwritten', async t => {
  let fault = true;
  const f = await fixture(t, stage => { if (fault && stage === 'confirmation-entry') { fault = false; throw new Error('disconnect'); } });
  const p = await ready(f), wrong = authorization(f, p.review, 'confirm', { people: 7, price: 3000 });
  await assert.rejects(f.host.confirmMigration(wrong.input, wrong.grant), /Compatible/);
  const first = authorization(f, p.review);
  await assert.rejects(f.host.confirmMigration(first.input, first.grant), /disconnect/);
  const pending = await f.host.readMigration('change'), cancel = authorization(f, pending, 'cancel', {}, 'cancel-1');
  assert.equal((await f.host.confirmMigration(cancel.input, cancel.grant)).status, 'cancelled');
  await assert.rejects(f.host.confirmMigration(first.input, first.grant));
  assert.equal((await f.host.readActive('bill')).surface.revision, 1);
});

test('fork before confirmation excludes new authority; confirmed forks and second forks retain exact receipts', async t => {
  const f = await fixture(t), p = await ready(f, true);
  const source = f.manager.getSessionId(), sourceFile = f.manager.getSessionFile(), earlier = f.manager.getLeafId();
  const { input, grant } = authorization(f, p.review); const committed = await f.host.confirmMigration(input, grant);
  // Exercise SDK label removal between normal completion and confirmation.
  const copyBranch = async (sourceId, file, leaf) => {
    const manager = SessionManager.open(file); const targetFile = manager.createBranchedSession(leaf);
    await copyGenerationJournal({ source: sourceId, target: manager.getSessionId(), sourceFile: file, targetFile,
      retainedEntryIds: manager.getBranch().map(entry => entry.id), sourceLeafId: leaf, root: f.root });
    return { manager, host: new UiGenerationPrototype({ manager, root: f.root }) };
  };
  const before = await copyBranch(source, sourceFile, earlier);
  assert.equal((await before.host.readActive('bill')).surface.revision, 1);
  assert.equal((await readUiOutput(before.manager, 'change', { root: f.root })).publication.status, 'aborted');
  const after = await copyBranch(source, sourceFile, committed.entryId);
  assert.equal((await after.host.readActive('bill')).surface.revision, 2);
  const again = await copyBranch(after.manager.getSessionId(), after.manager.getSessionFile(), after.manager.getLeafId());
  assert.equal((await again.host.readActive('bill')).surface.revision, 2);
});
