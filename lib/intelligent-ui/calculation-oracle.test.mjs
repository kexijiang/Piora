import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCalculationTrajectory, checkCalculationAttempts } from './calculation-oracle.mjs';
const surface = () => ({ version: 1, revision: 1, id: 'bill', title: 'Bill', nodes: [
  { id: 'people', type: 'number', label: 'People', value: 6, min: 1 },
  { id: 'share', type: 'metric', label: 'Share', value: { op: 'divide', args: [480, { ref: 'people' }] } },
] });
const oracle = { controls: { count: { type: 'number', initial: 6 } }, steps: [{}, { count: 8 }], expected: [[80, 60]] };
test('empty or partial expectations cannot produce a vacuous pass', () => {
  assert.throws(() => checkCalculationTrajectory(surface(), { ...oracle, expected: [] }), /Oracle requires/);
  assert.throws(() => checkCalculationTrajectory(surface(), { ...oracle, expected: [[80]] }), /Oracle requires/);
});
test('failed generation is distinct from no selection and a rejected update retains the prior valid calculation', () => {
  assert.equal(checkCalculationAttempts([], oracle).final.status, 'no-ui');
  const rejected = { errorCode: 'PLAN_SHAPE', evidence: { generationValid: false } };
  assert.equal(checkCalculationAttempts([rejected], oracle).final.status, 'invalid-generation');
  const accepted = { evidence: { generationValid: true, surface: surface() } };
  const result = checkCalculationAttempts([rejected, accepted, rejected], oracle);
  assert.equal(result.first.status, 'invalid-generation'); assert.equal(result.final.status, 'matched');
});
test('offline oracle follows the same expression across edits, without mutating input', () => {
  const input = surface(), original = structuredClone(input);
  assert.equal(checkCalculationTrajectory(input, oracle).status, 'matched'); assert.deepEqual(input, original);
  input.nodes[1].value = 80; input.nodes.push({ id: 'other', type: 'metric', label: 'Other', value: 60 });
  assert.equal(checkCalculationTrajectory(input, oracle).status, 'mismatch', 'unrelated constants cannot masquerade as a changed result');
});
test('ambiguous selectors and rejected input remain separate from matching calculations', () => {
  const input = surface(); input.nodes.push({ id: 'other', type: 'number', label: 'Other', value: 6 });
  assert.equal(checkCalculationTrajectory(input, oracle).status, 'unmapped');
  input.nodes.pop(); input.nodes[0].max = 7;
  assert.equal(checkCalculationTrajectory(input, oracle).status, 'input-rejected');
  input.nodes[0].value = 8; assert.equal(checkCalculationTrajectory(input, oracle).status, 'invalid-surface');
});

test('bound prose trajectories count only the same numeric part across edits', () => {
  const input = surface(); input.version = 2;
  input.nodes[1] = { id: 'share', type: 'dynamicText', parts: ['Each person pays ', input.nodes[1].value, ' yuan'] };
  input.layout = [{ id: 'group', type: 'group', title: 'Split', columns: 1, nodeIds: ['people', 'share'] }];
  const result = checkCalculationTrajectory(input, oracle);
  assert.equal(result.status, 'matched'); assert.deepEqual(result.matches, [['share.parts[1]']]);
  input.nodes[1].parts = ['80 then 60', 80, 60];
  assert.equal(checkCalculationTrajectory(input, oracle).status, 'mismatch');
});
test('selectors support explicit choices, booleans and numeric representation variants', () => {
  const input = surface(); input.nodes = [
    { id: 'discount', type: 'number', label: 'Discount', value: .8 },
    { id: 'choice', type: 'select', label: 'Choice', value: '基础', options: ['基础', '高级'] },
    { id: 'extra', type: 'checkbox', label: 'Extra', value: false },
    { id: 'result', type: 'metric', label: 'Result', value: { op: 'if', args: [{ ref: 'extra' },
      { op: 'if', args: [{ op: 'equals', args: [{ ref: 'choice' }, '高级'] }, { op: 'multiply', args: [{ ref: 'discount' }, 100] }, 1] }, 0] } },
  ];
  const query = { controls: { rate: { type: 'number', initial: [.8, 8] }, edition: { type: 'select' }, extra: { type: 'checkbox' } },
    steps: [{}, { rate: { byInitial: { '.8': .9, '0.8': .9, '8': 9 } }, edition: { option: '高级' }, extra: true }], expected: [[0, 90]] };
  assert.equal(checkCalculationTrajectory(input, query).status, 'matched');
  query.steps[1].edition.option = '不存在'; assert.equal(checkCalculationTrajectory(input, query).status, 'unmapped');
});
