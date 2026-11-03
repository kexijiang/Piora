import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
import { validateToolArguments } from '@earendil-works/pi-ai';

const jiti = createJiti(import.meta.url);
const { compileUiRichPlan, tryCompileUiRichPlan } = await jiti.import('./rich-plan.ts');
const { compileUiPlan } = await jiti.import('./plan.ts');
const { uiRichPlanSchema } = await jiti.import('./rich-plan-schema.ts');
const { uiPlanSchema } = await jiti.import('./plan-schema.ts');
const { evaluateRichSurface, validateRichSurface, formatRichSnapshot } = await jiti.import('./rich-protocol.ts');
const { parseUiPlanPrefix } = await jiti.import('./preview-parser.ts');
const { compileUiPreview } = await jiti.import('./preview-plan.ts');
const input = id => ({ input: id });
const derived = id => ({ derived: id });
const operation = (op, ...args) => ({ op, args });
const compile = plan => compileUiRichPlan(plan, { revision: 1 });
const fixture = (op = 'gte', inline = false) => ({
  planVersion: 2, id: 'threshold', title: 'Compare two supplied numbers',
  inputs: ['left', 'right'].map(id => ({ id, label: id, valueType: 'number', value: 0 })),
  derived: inline ? [] : [{ id: 'result', ...operation(op, input('left'), input('right')) }],
  views: [{ id: 'value', kind: 'metric', label: 'Comparison', value: inline ? operation(op, input('left'), input('right')) : derived('result') }],
  layout: [{ id: 'group', type: 'group', title: 'Comparison', columns: 1, nodeIds: ['left', 'right', 'value'] }],
});
const value = (surface, state) => evaluateRichSurface(surface, state).nodes.find(node => node.id === 'value').value;
const rejected = (plan, code, repairable = true) => {
  const result = tryCompileUiRichPlan(plan, { revision: 1 });
  assert.equal(result.ok, false);
  if (code) assert.equal(result.error.code, code);
  assert.equal(result.error.repairable, repairable);
  assert.ok(JSON.stringify(result.error).length < 700);
  return result.error;
};

test('numeric comparison semantics cover equality, signs, fractions, signed zero and supported extremes', () => {
  const values = [-1e12, -17, -0.5, -Number.EPSILON, -0, 0, Number.EPSILON, 0.5, 17, 1e12];
  const expected = { lt: (a, b) => a < b, lte: (a, b) => a <= b, gt: (a, b) => a > b, gte: (a, b) => a >= b };
  for (const [op, oracle] of Object.entries(expected)) for (const inline of [false, true]) {
    const source = fixture(op, inline), before = structuredClone(source), result = compile(source);
    assert.equal(result.compilerVersion, '2.7.0');
    assert.deepEqual(source, before);
    for (const left of values) for (const right of values) {
      assert.deepEqual(value(result.surface, { left, right }), { value: oracle(left, right) }, `${op}(${left},${right}) inline=${inline}`);
    }
  }
});

test('published comparisons use only existing Surface2 expressions and survive serialization and changed inputs', () => {
  for (const op of ['lt', 'lte', 'gt', 'gte']) {
    const compiled = compile(fixture(op)), restored = validateRichSurface(JSON.parse(JSON.stringify(compiled.surface)));
    assert.equal(restored.version, 2);
    assert.doesNotMatch(JSON.stringify(restored), /"op":"(?:lt|lte|gt|gte)"/);
    assert.deepEqual(value(restored, { left: 3, right: 5 }), value(compiled.surface, { left: 3, right: 5 }));
    assert.deepEqual(value(restored, { left: 7, right: 5 }), value(compiled.surface, { left: 7, right: 5 }));
    assert.match(formatRichSnapshot(restored, { left: 5, right: 5 }), /Comparison: (?:true|false)/);
  }
});

test('SDK transport, complete preview, streaming preview and committed output share comparison meaning', () => {
  const tool = { name: 'piora_render_ui_plan', parameters: uiRichPlanSchema };
  for (const op of ['lt', 'lte', 'gt', 'gte']) for (const inline of [false, true]) {
    const source = fixture(op, inline), parsed = validateToolArguments(tool, { type: 'toolCall', id: 'compare', name: tool.name, arguments: source });
    assert.deepEqual(parsed, source);
    const raw = JSON.stringify(source), committed = compile(source);
    for (const text of [raw, raw.slice(0, -1)]) {
      const preview = compileUiPreview(parseUiPlanPrefix(text));
      assert.equal(preview.status, 'ready');
      assert.deepEqual(preview.surface, committed.surface);
    }
  }
  const raw = JSON.stringify(fixture('gte', true));
  for (let end = 0; end <= raw.length; end++) assert.notEqual(compileUiPreview(parseUiPlanPrefix(raw.slice(0, end))).status, 'invalid', `boundary ${end}`);
});

test('supplied threshold rules remain correct below, at and above the boundary without evaluating unused branches', () => {
  const source = fixture();
  source.derived = [
    { id: 'result', ...operation('if', derived('eligible'), operation('subtract', input('left'), 30), input('left')) },
    { id: 'eligible', ...operation('gte', input('left'), input('right')) },
  ];
  const surface = compile(source).surface;
  for (const [amount, expected] of [[199, 199], [200, 170], [201, 171]]) assert.deepEqual(value(surface, { left: amount, right: 200 }), { value: expected });
  source.derived = [{ id: 'result', ...operation('if', operation('lte', input('left'), 0), 0, operation('divide', 1, input('left'))) }];
  const lazy = compile(source).surface;
  for (const [left, expected] of [[-1, 0], [0, 0], [2, 0.5]]) assert.deepEqual(value(lazy, { left, right: 0 }), { value: expected });
});

test('comparisons require exactly two numeric operands without coercing strings, booleans, null or references', () => {
  for (const op of ['lt', 'lte', 'gt', 'gte']) for (const inline of [false, true]) {
    for (const args of [[], [1], [1, 2, 3]]) {
      const source = fixture(op, inline);
      (inline ? source.views[0].value : source.derived[0]).args = args;
      rejected(source, 'PLAN_ARITY');
    }
    for (const invalid of ['2', true, null, { literal: '2' }, { literal: false }, { derived: 'missing' }]) {
      const source = fixture(op, inline);
      (inline ? source.views[0].value : source.derived[0]).args[1] = invalid;
      rejected(source);
    }
    for (const invalid of [NaN, Infinity, -Infinity, 1e13]) {
      const source = fixture(op, inline);
      (inline ? source.views[0].value : source.derived[0]).args[1] = invalid;
      rejected(source, 'PLAN_TYPE');
    }
    const source = fixture(op, inline); source.inputs[0] = { id: 'left', label: 'Text', valueType: 'string', value: '2', options: ['2', '3'] };
    rejected(source, 'PLAN_TYPE');
  }
});

test('comparison lowering retains exact-key validation, static branch types and unused declaration checks', () => {
  for (const inline of [false, true]) {
    const source = fixture('gte', inline);
    (inline ? source.views[0].value : source.derived[0]).unexpected = 'do not drop';
    rejected(source, 'PLAN_SHAPE');
    delete (inline ? source.views[0].value : source.derived[0]).unexpected;
    (inline ? source.views[0].value : source.derived[0]).op = 'greaterThan';
    rejected(source, 'PLAN_TYPE');
  }
  const source = fixture();
  source.views[0].value = operation('if', derived('result'), 10, 'unavailable');
  rejected(source, 'PLAN_TYPE');
  source.views[0].value = 1; source.derived[0].args = [1, true];
  rejected(source, 'PLAN_TYPE');
});

test('lowered operations consume the existing graph, expression-depth and total-expansion budgets', () => {
  const source = fixture('lt');
  source.derived = Array.from({ length: 85 }, (_, i) => ({ id: `compare${i}`, ...operation('lt', input('left'), input('right')) }));
  source.views[0].value = derived('compare0');
  assert.equal(compile(source).compilerVersion, '2.7.0');
  source.derived.push({ id: 'tooMany', ...operation('lt', input('left'), input('right')) });
  rejected(source, 'PLAN_COMPLEXITY', false);
  const nested = fixture(); nested.derived = []; let expression = input('left');
  for (let i = 0; i < 5; i++) {
    nested.derived.push({ id: `depth${i}`, ...operation('if', operation('gte', expression, input('right')), 1, 0) });
    expression = derived(`depth${i}`);
  }
  nested.views[0].value = expression; rejected(nested, 'PLAN_COMPLEXITY', false);
  const wide = fixture();
  wide.derived = [{ id: 'wide', ...operation('add', ...Array(32).fill(1)) }, { id: 'result', ...operation('gte', derived('wide'), input('right')) }];
  wide.views = Array.from({ length: 61 }, (_, i) => ({ id: `value${i}`, kind: 'metric', label: 'Comparison', value: derived('result') }));
  wide.layout[0].nodeIds = ['left', 'right', ...wide.views.map(view => view.id)];
  rejected(wide, 'PLAN_COMPLEXITY', false);
});

test('Plan1 remains strict and existing rich plans keep their compiler identity', () => {
  const source = fixture('gte');
  const legacy = { ...source, planVersion: 1 }; delete legacy.layout;
  assert.throws(() => compileUiPlan(legacy, { revision: 1 }), /PLAN_TYPE/);
  assert.throws(() => validateToolArguments({ name: 'piora_render_ui_plan', parameters: uiPlanSchema }, { type: 'toolCall', id: 'legacy', name: 'piora_render_ui_plan', arguments: legacy }));
  source.derived[0].op = 'equals';
  assert.equal(compile(source).compilerVersion, '2.5.0');
});
