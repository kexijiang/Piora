import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createJiti } from 'jiti';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { checkCalculationTrajectory } from './calculation-oracle.mjs';
const jiti = createJiti(import.meta.url);
const { compileUiRichPlan, tryCompileUiRichPlan } = await jiti.import('./rich-plan.ts');
const { compileUiPlan } = await jiti.import('./plan.ts');
const { parseUiPlanPrefix } = await jiti.import('./preview-parser.ts');
const { compileUiPreview } = await jiti.import('./preview-plan.ts');
const { evaluateExpression, initialState } = await jiti.import('./protocol.ts');
const { uiRichPlanSchema } = await jiti.import('./rich-plan-schema.ts');
const { createAdmittedUiTurn, evaluationVariant } = await import('../../scripts/intelligent-ui-live-evaluation.mjs');
const op = (name, ...args) => ({ op: name, args });
const input = name => ({ input: name });
const plan = value => ({ planVersion: 2, id: 'calculator', title: 'Calculation',
  inputs: [{ id: 'count', label: 'Count', valueType: 'number', value: 4 }], derived: [],
  views: [{ id: 'answer', kind: 'metric', label: 'Result', value }],
  layout: [{ id: 'group', type: 'group', title: 'Adjust', columns: 1, nodeIds: ['count', 'answer'] }] });
const compile = value => compileUiRichPlan(value, { revision: 1 });
const preview = text => compileUiPreview(parseUiPlanPrefix(text));
const result = (surface, state = initialState(surface)) => evaluateExpression(surface.nodes.find(n => n.id === 'answer').value, state);
const reject = (source, code, path) => {
  const value = tryCompileUiRichPlan(source, { revision: 1 });
  assert.equal(value.ok, false); assert.equal(value.error.code, code);
  if (path) assert.equal(value.error.path, path);
  return value.error;
};

test('inline expressions and named calculations compile identically without modifying model arguments', () => {
  const inline = plan(op('divide', op('multiply', input('count'), 60), 2));
  inline.views.push({ id: 'table', kind: 'table', columns: ['Cost'], rows: [[op('add', input('count'), 3)]] });
  inline.views.push({ id: 'chart', kind: 'barChart', labels: ['Cost'], values: [op('subtract', 12, input('count'))] });
  inline.layout[0].nodeIds.push('table', 'chart');
  const named = structuredClone(inline);
  named.derived = [{ id: 'gross', op: 'multiply', args: [input('count'), 60] },
    { id: 'total', op: 'divide', args: [{ derived: 'gross' }, 2] },
    { id: 'tableValue', op: 'add', args: [input('count'), 3] }, { id: 'chartValue', op: 'subtract', args: [12, input('count')] }];
  named.views[0].value = { derived: 'total' }; named.views[1].rows[0][0] = { derived: 'tableValue' }; named.views[2].values[0] = { derived: 'chartValue' };
  const before = structuredClone(inline), compiled = compile(inline);
  assert.deepEqual(compiled, compile(named)); assert.deepEqual(inline, before);
  for (const count of [0, 4, 6, 18]) assert.equal(result(compiled.surface, { count }), count * 30);
  const tool = { name: 'piora_render_ui_plan', parameters: uiRichPlanSchema };
  assert.deepEqual(validateToolArguments(tool, { id: 'inline', name: tool.name, arguments: inline }), before);
  assert.deepEqual(inline, before);
  const legacy = { ...inline }; delete legacy.layout;
  assert.throws(() => compileUiPlan({ ...legacy, planVersion: 1 }, { revision: 1 }), /PLAN_SHAPE/);
});

test('nested conditionals retain strict types and lazy branch evaluation', () => {
  const source = plan(op('if', op('equals', input('count'), 0), 0, op('divide', 12, input('count'))));
  source.inputs[0].value = 0;
  const compiled = compile(source);
  assert.equal(result(compiled.surface), 0); assert.equal(result(compiled.surface, { count: 3 }), 4);
  for (const expression of [op('add', '2', 1), op('add', true, 1), op('if', 1, 2, 3), op('round', { literal: null })]) reject(plan(expression), 'PLAN_TYPE');
  reject(plan(op('round', null)), 'PLAN_SHAPE');
  reject(plan(op('add', 1, op('multiply', true, 2))), 'PLAN_TYPE', '$.views[0].value.args[1].args');
  reject(plan(op('divide', 1)), 'PLAN_ARITY', '$.views[0].value.args');
});

test('internal names cannot satisfy unresolved references or shadow declared calculations', () => {
  const source = plan(op('add', op('multiply', input('count'), 2), { derived: 'pioraInline0' }));
  reject(source, 'PLAN_REFERENCE', '$.views[0].value.args[1]');
  source.derived = [{ id: 'pioraInline0', op: 'add', args: [90, 9] }];
  assert.equal(result(compile(source).surface), 107);
  const cycle = plan({ derived: 'total' }); cycle.derived = [{ id: 'total', op: 'add', args: [op('multiply', { derived: 'total' }, 2)] }];
  reject(cycle, 'PLAN_CYCLE');
});

test('depth, total graph size and expansion limits are unchanged after normalization', () => {
  let expression = input('count');
  for (let i = 0; i < 12; i++) expression = op('round', expression);
  const atLimit = plan(expression); assert.equal(result(compile(atLimit).surface), 4);
  assert.equal(preview(JSON.stringify(atLimit)).status, 'ready');
  assert.equal(reject(plan(op('round', expression)), 'PLAN_COMPLEXITY').repairable, false);
  const many = plan(1); many.views = [{ id: 'answer', kind: 'table', columns: ['A','B','C'],
    rows: Array.from({ length: 86 }, () => [op('add', 1), op('add', 2), op('add', 3)]) }];
  assert.equal(reject(many, 'PLAN_COMPLEXITY').repairable, false);
  const expanded = plan({ derived: 'd12' });
  expanded.derived = [{ id: 'd0', op: 'add', args: [input('count'), input('count')] }];
  for (let i = 1; i <= 12; i++) expanded.derived.push({ id: `d${i}`, op: 'add', args: [op('add', { derived: `d${i-1}` }), { derived: `d${i-1}` }] });
  assert.equal(reject(expanded, 'PLAN_COMPLEXITY').repairable, false);
});

test('non-expression depth and hostile or ambiguous objects are never normalized away', () => {
  let deep = {}; for (let i = 0; i < 12; i++) deep = { nested: deep };
  const invalid = plan(1); invalid.layout[0].extra = deep; reject(invalid, 'PLAN_LIMIT');
  assert.equal(parseUiPlanPrefix(JSON.stringify(invalid)).status, 'invalid');
  for (const expression of [{ op: 'add', args: [1], id: 'named' }, { op_not_used: 0 }, { op: 'add', args: [1], extra: 1 }]) reject(plan(expression), 'PLAN_SHAPE');
  reject(plan(op('execute', 1)), 'PLAN_TYPE');
  const recursive = op('add', 1); recursive.args.push(recursive); reject(plan(recursive), 'PLAN_SHAPE');
  let reads = 0; const accessor = op('add', 1);
  Object.defineProperty(accessor, 'args', { enumerable: true, get() { reads++; return [1]; } });
  reject(plan(accessor), 'PLAN_SHAPE'); assert.equal(reads, 0);
});

test('all streaming boundaries and field orders preserve inline dependencies and final meaning', () => {
  const source = plan(op('add', op('multiply', input('count'), 3), { derived: 'later' }));
  source.derived = [{ id: 'later', op: 'divide', args: [op('add', 8, 4), 2] }];
  for (const order of [['views','layout','derived','inputs'], ['inputs','derived','views','layout'], ['layout','inputs','views','derived']]) {
    const raw = JSON.stringify({ planVersion: 2, id: source.id, title: source.title, ...Object.fromEntries(order.map(k => [k, source[k]])) });
    for (let i = 0; i <= raw.length; i++) assert.notEqual(preview(raw.slice(0,i)).status, 'invalid', `${order}: ${i}`);
    const partial = preview(raw.slice(0,-1)); assert.equal(partial.status, 'ready');
    assert.deepEqual(partial.surface, compile(source).surface);
    assert.equal(result(partial.surface), 18); assert.equal(result(partial.surface, { count: 6 }), 24);
  }
  const prefix = JSON.stringify({ planVersion: 2, id: source.id, title: source.title, inputs: source.inputs,
    views: source.views, layout: source.layout }).slice(0,-1);
  assert.equal(preview(prefix).status, 'waiting');
  assert.equal(preview(prefix + ',"derived":[]').status, 'invalid');
  const hidden = plan(1); hidden.derived.push({ id: 'unused', op: 'add', args: [op('multiply', true, 2)] });
  assert.equal(preview(JSON.stringify(hidden).slice(0,-1)).status, 'invalid');
});

test('original-data admission guards operands left open by the compact provider schema', async t => {
  const configuration = await evaluationVariant('plan-2');
  const turn = await createAdmittedUiTurn({ configuration, signal: new AbortController().signal }); t.after(turn.close);
  const state = new Map(), bad = plan(op('add', 1, { literal: null }));
  // The provider declaration is intentionally finite. Host original-data
  // validation is mandatory and must reject this before any SDK coercion.
  validateToolArguments(configuration.tools[0], { id: 'bad', name: configuration.tools[0].name, arguments: bad });
  const rejected = await turn.execute({ state, call: { id: 'bad', name: configuration.tools[0].name, arguments: bad } });
  assert.equal(rejected.isError, true); assert.equal(rejected.evidence.generationValid, false); assert.equal(state.size, 0);
  const good = await turn.execute({ state, call: { id: 'good', name: configuration.tools[0].name,
    arguments: plan(op('divide', op('multiply', input('count'), 60), 2)) } });
  assert.equal(good.evidence.generationValid, true); assert.equal(good.evidence.admission.corrections, 1);
  assert.equal(result(good.evidence.surface), 120);
});

test('captured model failures are repaired only where the original expression has an unambiguous meaning', () => {
  const fixtures = JSON.parse(readFileSync(new URL('../../tests/fixtures/intelligent-ui/plan2-inline-failures.json', import.meta.url), 'utf8')).cases;
  for (const fixture of fixtures) {
    const before = structuredClone(fixture.plan);
    if (['candidate-pro-b07-1','refined-flash-b07-1','baseline-flash-b09-1'].includes(fixture.id)) {
      reject(fixture.plan, fixture.id.endsWith('b09-1') ? 'PLAN_TYPE' : 'PLAN_SHAPE'); continue;
    }
    const validated = validateToolArguments({ name: 'piora_render_ui_plan', parameters: uiRichPlanSchema },
      { id: fixture.id, name: 'piora_render_ui_plan', arguments: fixture.plan });
    assert.deepEqual(validated, before);
    const compiled = compile(validated), oracle = fixture.taskId === 'b08'
      ? { controls: { rent: { type: 'number', initial: 6000 } }, steps: [{}, { rent: 9000 }], expected: [[1000,1500],[2000,3000],[3000,4500]] }
      : { controls: { rent: { type: 'number', initial: 6000 } }, steps: [{ rent: 9000 }, { rent: 18000 }], expected: [[3000,6000],[2000,4000],[4000,8000]] };
    assert.equal(checkCalculationTrajectory(compiled.surface, oracle).status, 'matched', fixture.id);
    assert.deepEqual(preview(JSON.stringify(fixture.plan)).surface, compiled.surface, fixture.id);
    assert.deepEqual(fixture.plan, before);
  }
});
