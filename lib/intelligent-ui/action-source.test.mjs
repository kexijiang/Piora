import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createJiti } from 'jiti';
import { SessionManager } from '@earendil-works/pi-coding-agent';
const jiti = createJiti(import.meta.url);
const { compileUiRichPlan, tryCompileUiRichPlan } = await jiti.import('./rich-plan.ts');
const { UiGenerationPrototype, generationJournalPath, copyGenerationJournal } = await jiti.import('./generation-journal.ts');
const { readOnlySessionManager } = await jiti.import('../session-readonly-manager.ts');
const plan = () => ({ planVersion: 2, id: 'bill', title: 'Bill', inputs: [{ id: 'people', label: 'People', valueType: 'number', value: 4, min: 1, max: 20 }],
  derived: [], views: [{ id: 'count', kind: 'metric', label: 'Count', value: { input: 'people' } }],
  layout: [{ id: 'parameters', type: 'group', title: 'Values', columns: 1, nodeIds: ['people', 'count'] }],
  actions: { version: 1, actions: [{ id: 'save', label: 'Save results', kind: 'save_snapshot', path: 'report.json', format: 'json' }] } });
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'piora-action-source-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()))); rmSync(root, { recursive: true, force: true }); });
  const manager = SessionManager.create(root, join(root, 'sessions'));
  manager.appendMessage({ role: 'user', content: 'Create a budget and let me save it.', timestamp: 1 });
  const host = new UiGenerationPrototype({ manager, root }); await host.startRun();
  return { root, manager, host };
}
async function create(f, toolCallId = 'first', value = plan(), revision = 1) {
  const context = await f.host.captureContext('bill');
  const messageEntryId = f.manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: toolCallId, name: 'piora_render_ui_plan', arguments: value }], timestamp: 2 });
  const compiled = compileUiRichPlan(value, { revision });
  const candidate = await f.host.createCandidate(context.contextId, toolCallId, compiled);
  const receipt = await f.host.persistCandidate(candidate.operationId);
  await f.host.observePersistedCandidate(candidate.operationId, { messageEntryId, toolResultEntryIds: [receipt.entryId] });
  return { candidate, receipt, context, compiled };
}
test('action declarations are independent of layout and do not open arbitrary execution', () => {
  const compiled = compileUiRichPlan(plan(), { revision: 1 });
  assert.deepEqual(compiled.actions, plan().actions); assert.equal(compiled.surface.actions, undefined);
  const noActions = plan(); delete noActions.actions;
  assert.equal(compileUiRichPlan(noActions, { revision: 1 }).actions, undefined);
  for (const actions of [{ version: 2, actions: [] }, { version: 1, actions: [{ ...plan().actions.actions[0], path: '../outside.json' }] },
    { version: 1, actions: [{ id: 'run', kind: 'shell', label: 'run', path: 'report.json', command: 'echo x' }] }]) {
    const result = tryCompileUiRichPlan({ ...plan(), actions }, { revision: 1 });
    assert.equal(result.ok, false); assert.equal(result.error.path, '$.actions');
  }
});
test('only the current published output exposes an action source; parameter and branch changes invalidate it', async t => {
  const f = await fixture(t), created = await create(f);
  assert.deepEqual(created.candidate.details.answerOutput.actions, plan().actions);
  await assert.rejects(f.host.readActionSource('first'), /published/);
  const commit = await f.host.commitCandidate(created.candidate.operationId);
  const source = await f.host.readActionSource('first'); assert.equal(source.state.people, 4);
  let effects = 0;
  await f.host.withActionSource('first', source.digest, (_, assertOwned) => { assertOwned(); effects++; });
  assert.equal(effects, 1);
  await f.host.saveParameters(created.candidate.operationId, commit.stateRevision, { people: 8 });
  await assert.rejects(f.host.withActionSource('first', source.digest, () => effects++), /changed/);
  const current = await f.host.readActionSource('first'); assert.equal(current.state.people, 8); assert.notEqual(current.digest, source.digest);
  f.manager.appendMessage({ role: 'user', content: 'Change topic', timestamp: 3 });
  await assert.rejects(f.host.withActionSource('first', current.digest, () => effects++), /changed/); assert.equal(effects, 1);
  const second = await create(f, 'second', plan(), 2); await f.host.commitCandidate(second.candidate.operationId);
  await assert.rejects(f.host.readActionSource('first'), /current committed/);
  assert.equal((await f.host.readActionSource('second')).state.people, 8);
});
test('changing a declared target in the journal or replaying a call cannot reuse the original receipt', async t => {
  const f = await fixture(t), created = await create(f);
  const different = compileUiRichPlan({ ...plan(), actions: { version: 1, actions: [{ ...plan().actions.actions[0], path: 'other.json' }] } }, { revision: 1 });
  await assert.rejects(f.host.createCandidate(created.context.contextId, 'first', different), /different actions/);
  await f.host.commitCandidate(created.candidate.operationId);
  const path = generationJournalPath(f.manager.getSessionId(), f.root), journal = JSON.parse(readFileSync(path, 'utf8'));
  journal.records[0].actions.actions[0].path = 'other.json'; writeFileSync(path, JSON.stringify(journal));
  await assert.rejects(f.host.readActionSource('first'), /Exact candidate/);
});

test('linear chat renaming leaves action identity stable without losing parameters stored on the title entry', async t => {
  const f = await fixture(t), created = await create(f); await f.host.commitCandidate(created.candidate.operationId);
  const original = await f.host.readActionSource('first');
  f.manager.appendSessionInfo('Automatically generated chat title');
  const renamed = await f.host.readActionSource('first');
  assert.equal(renamed.digest, original.digest); assert.notEqual(renamed.leafId, original.leafId);
  await f.host.withActionSource('first', original.digest, () => {});
  await f.host.saveParameters(created.candidate.operationId, renamed.revision, { people: 7 });
  const edited = await f.host.readActionSource('first'); assert.equal(edited.state.people, 7); assert.notEqual(edited.digest, original.digest);
  f.manager.appendSessionInfo('Renamed again');
  const again = await f.host.readActionSource('first'); assert.equal(again.digest, edited.digest); assert.equal(again.state.people, 7);
  f.manager.appendMessage({ role: 'user', content: 'Continue with another task', timestamp: 3 });
  await assert.rejects(f.host.withActionSource('first', again.digest, () => {}), /changed/);
});

test('title entries on sibling branches cannot share an action authorization', async t => {
  const f = await fixture(t), created = await create(f); await f.host.commitCandidate(created.candidate.operationId);
  const anchor = f.manager.getLeafId();
  const first = f.manager.appendSessionInfo('Branch one');
  const beforeBranch = await f.host.readActionSource('first');
  f.manager.branch(anchor); f.manager.appendSessionInfo('Branch two');
  await assert.rejects(f.host.withActionSource('first', beforeBranch.digest, () => {}), /changed/);
  const second = await f.host.readActionSource('first');
  f.manager.branch(first);
  const firstAgain = await f.host.readActionSource('first');
  assert.notEqual(firstAgain.digest, second.digest);
  await assert.rejects(f.host.withActionSource('first', second.digest, () => {}), /changed/);
});
test('confirmed fork inherits declarations and values but receives a distinct session-bound source digest', async t => {
  const f = await fixture(t), created = await create(f); await f.host.commitCandidate(created.candidate.operationId);
  const sourceId = f.manager.getSessionId(), sourceFile = f.manager.getSessionFile(), source = await f.host.readActionSource('first');
  const child = SessionManager.open(sourceFile), childFile = child.createBranchedSession(f.manager.getLeafId());
  await copyGenerationJournal({ source: sourceId, target: child.getSessionId(), sourceFile, targetFile: childFile,
    retainedEntryIds: child.getBranch().map(entry => entry.id), sourceLeafId: f.manager.getLeafId(), root: f.root });
  const host = new UiGenerationPrototype({ manager: readOnlySessionManager(childFile), root: f.root });
  const forked = await host.readActionSource('first');
  assert.deepEqual(forked.actions, source.actions); assert.deepEqual(forked.state, source.state);
  assert.notEqual(forked.sessionId, source.sessionId); assert.notEqual(forked.digest, source.digest);
});
