import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { validateFirstTaskSuite, runSlots, generationEvidence, summarizeRun } from '../scripts/mini-app-evaluation-data.mjs';

const suite = JSON.parse(await readFile(new URL('../tests/fixtures/intelligent-ui/phase3-first-tasks.json', import.meta.url), 'utf8'));

test('the fixed development set has eight distinct families and all requested repetitions', () => {
  validateFirstTaskSuite(suite);
  const slots = runSlots(suite);
  assert.equal(slots.length, 24); assert.equal(new Set(slots.map(slot => slot.id)).size, 24);
  assert.deepEqual(suite.tasks.reduce((counts, task) => { counts[task.acceptedForms[0]]++; return counts; }, { 'non-ui': 0, 'intelligent-ui': 0, 'mini-app': 0 }), { 'non-ui': 2, 'intelligent-ui': 2, 'mini-app': 4 });
  assert.throws(() => runSlots(suite, 0)); assert.throws(() => runSlots(suite, 4));
  const repeated = structuredClone(suite); repeated.tasks[1].family = repeated.tasks[0].family;
  assert.throws(() => validateFirstTaskSuite(repeated));
});

test('publication is technical evidence, not semantic or interaction acceptance', () => {
  const task = suite.tasks.find(task => task.id === 'sorting');
  const result = { status: 'completed', observedForms: ['mini-app'],
    toolAttempts: [{ toolCallId: 'bad', isError: true, diagnostic: { code: 'SCHEMA' } }, { toolCallId: 'good', isError: false }],
    journal: { records: [{ status: 'committed', toolCallId: 'good' }] } };
  const evidence = generationEvidence(task, result);
  assert.equal(evidence.generationAccepted, true); assert.equal(evidence.firstAttemptAccepted, false);
  for (const key of ['choiceCorrect', 'semanticCorrect', 'browserInteraction', 'savedAfterInteraction', 'reload', 'followup']) assert.equal(evidence[key], null);
  assert.deepEqual(evidence.diagnostics, [{ code: 'SCHEMA' }]);
  assert.equal(generationEvidence(task, { ...result, journal: { records: [{ status: 'candidate', toolCallId: 'good' }] } }).generationAccepted, false);
  assert.equal(generationEvidence(task, { ...result, status: 'failed' }).generationAccepted, false);
  assert.equal(generationEvidence(task, { ...result, observedForms: ['mini-app', 'intelligent-ui'] }).generationAccepted, false);
});

test('no-UI responses do not receive inferred clarification or choice judgments', () => {
  const task = suite.tasks.find(task => task.id === 'clarification');
  const result = { status: 'completed', observedForms: ['non-ui'], finalText: 'What rule applies?', toolAttempts: [] };
  const evidence = generationEvidence(task, result);
  assert.equal(evidence.noUiResponse, true); assert.equal(evidence.semanticCorrect, null); assert.equal(evidence.choiceCorrect, null);
  const falseTrigger = generationEvidence(task, { ...result, toolAttempts: [{ isError: true }] });
  assert.equal(falseTrigger.noUiResponse, false); assert.equal(falseTrigger.unexpectedUiAttempt, true);
  assert.equal(generationEvidence(task, { ...result, finalText: '' }).noUiResponse, false);
});

test('errors, timeouts and missing samples remain in the requested denominators', () => {
  const slots = runSlots(suite); slots[0].status = 'failed'; slots[0].timedOut = true;
  slots.find(slot => slot.taskId === 'sorting').status = 'completed';
  const summary = summarizeRun(suite, slots);
  assert.equal(summary.requested, 24); assert.equal(summary.finished, 2); assert.equal(summary.pending, 22);
  assert.equal(summary.failed, 1); assert.equal(summary.ui.denominator, 18); assert.equal(summary.nonUi.denominator, 6);
  assert.equal(summary.ui.generationAccepted, 0); assert.equal(summary.ui.firstAttemptAccepted, 0);
  assert.equal(summary.semanticAcceptance, 'pending'); assert.equal(summary.completeTaskAcceptance, 'pending');
});
