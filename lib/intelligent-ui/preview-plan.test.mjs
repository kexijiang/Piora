import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { parseUiPlanPrefix } = await jiti.import('./preview-parser.ts');
const { compileUiPreview } = await jiti.import('./preview-plan.ts');
const { compileUiRichPlan } = await jiti.import('./rich-plan.ts');
const { evaluateExpression, initialState } = await jiti.import('./protocol.ts');
const preview = raw => compileUiPreview(parseUiPlanPrefix(raw));
const plan = () => ({ planVersion: 2, id: 'bill', title: 'Bill',
  inputs: [{ id: 'people', label: 'People', valueType: 'number', value: 4 }],
  derived: [{ id: 'total', op: 'multiply', args: [{ input: 'people' }, { literal: 12 }] }],
  views: [{ id: 'amount', kind: 'metric', label: 'Total', value: { derived: 'total' } }],
  layout: [{ id: 'parameters', type: 'group', title: 'Parameters', columns: 1, nodeIds: ['people'] },
    { id: 'results', type: 'group', title: 'Results', columns: 1, nodeIds: ['amount'] }] });
const partial = value => preview(JSON.stringify(value).slice(0, -1));

test('separate calculation names work across field orders and every streaming boundary', () => {
  const value = plan();
  value.derived[0].id = 'people';
  value.derived.push({ id: 'amount', op: 'add', args: [{ derived: 'people' }, { literal: 2 }] });
  value.views[0].value = { derived: 'amount' };
  value.derived.push({ id: 'parameters', op: 'add', args: [{ literal: 1 }] });
  for (const order of [['inputs', 'derived', 'views', 'layout'], ['layout', 'views', 'derived', 'inputs'], ['derived', 'layout', 'inputs', 'views']]) {
    const reordered = { planVersion: 2, id: value.id, title: value.title, ...Object.fromEntries(order.map(k => [k, value[k]])) };
    const raw = JSON.stringify(reordered);
    for (let end = 0; end <= raw.length; end++) assert.notEqual(preview(raw.slice(0, end)).status, 'invalid', `${order} boundary ${end}`);
    const pending = partial(reordered), complete = preview(raw);
    assert.equal(pending.status, 'ready'); assert.deepEqual(pending.surface, complete.surface);
    assert.deepEqual(complete.surface, compileUiRichPlan(value, { revision: 1 }).surface);
    const expression = complete.surface.nodes.find(n => n.id === 'amount').value;
    assert.equal(evaluateExpression(expression, { people: 4 }), 50);
    assert.equal(evaluateExpression(expression, { people: 6 }), 74);
  }
});

test('typed references never resolve through a different namespace during preview', () => {
  const value = plan(); value.views[0].id = 'total'; value.layout[1].nodeIds = ['total'];
  const prefix = JSON.stringify({ planVersion: 2, id: value.id, title: value.title, views: value.views, layout: value.layout }).slice(0, -1);
  assert.equal(preview(prefix).status, 'waiting', 'a view name does not define a pending calculation');
  assert.equal(preview(prefix + ',"derived":[]').status, 'invalid', 'closing the absent calculation rejects the typed reference');
  value.views[0].value = { input: 'total' };
  assert.equal(partial(value).status, 'invalid', 'derived/view total does not define an input total');
  value.views[0].value = { derived: 'total' }; value.derived.push({ ...value.derived[0] });
  assert.equal(partial(value).status, 'invalid', 'duplicate calculation definitions remain invalid');
});

test('literal shorthand has identical preview and committed meaning at every boundary', () => {
  const value = plan(); value.derived[0].args[1] = 12;
  value.views.push({ id: 'table', kind: 'table', columns: ['Text', 'Value'], rows: [['120', { derived: 'total' }], ['Flag', false]] });
  value.layout[1].nodeIds.push('table');
  const raw = JSON.stringify(value);
  for (let end = 0; end <= raw.length; end++) assert.notEqual(preview(raw.slice(0, end)).status, 'invalid', `boundary ${end}`);
  const pending = partial(value), complete = preview(raw);
  assert.equal(pending.status, 'ready'); assert.equal(pending.complete, false);
  assert.equal(complete.status, 'ready'); assert.equal(complete.complete, true);
  assert.deepEqual(pending.surface, complete.surface);
  assert.deepEqual(complete.surface, compileUiRichPlan(value, { revision: 1 }).surface);
  assert.match(pending.snapshot, /120 \| 48/); assert.match(pending.snapshot, /Flag \| false/);
  value.views[1].rows[0][0] = null;
  assert.equal(partial(value).status, 'invalid'); assert.equal(preview(JSON.stringify(value)).status, 'invalid');
});

test('every boundary of an ordinary plan yields only closed validated blocks', () => {
  const value = plan(), raw = JSON.stringify(value);
  let first;
  for (let end = 0; end < raw.length; end++) {
    const result = preview(raw.slice(0, end));
    assert.notEqual(result.status, 'invalid', `boundary ${end}`);
    if (result.status === 'ready') { first ??= end; assert.equal(result.complete, false); }
  }
  assert.ok(first < raw.indexOf('"results"'), 'the first group is visible before the second group');
  const result = preview(raw);
  assert.equal(result.status, 'ready'); assert.equal(result.complete, true);
  assert.deepEqual(result.surface, compileUiRichPlan(value, { revision: 1 }).surface);
  assert.equal(evaluateExpression(result.surface.nodes.find(n => n.id === 'amount').value, initialState(result.surface)), 48);
});

test('layout and one closed input can render while the input array is still open', () => {
  const value = plan();
  const prefix = JSON.stringify({ planVersion: 2, id: 'bill', title: 'Bill', layout: [value.layout[0]] }).slice(0, -1)
    + ',"inputs":[' + JSON.stringify(value.inputs[0]) + ',';
  const result = preview(prefix);
  assert.equal(result.status, 'ready'); assert.deepEqual(result.surface.nodes.map(n => n.id), ['people']);
  assert.equal(result.surface.layout.length, 1);
  assert.throws(() => compileUiRichPlan({ ...value, views: [], derived: [], layout: [value.layout[0]] }, { revision: 1 }), /PLAN_SHAPE/,
    'ordinary complete plans still require a view');
});

test('output dependencies require the controls to have a complete owning block', () => {
  const value = plan(); value.layout.reverse();
  const raw = JSON.stringify(value), boundary = raw.indexOf(',{"id":"parameters"');
  assert.equal(preview(raw.slice(0, boundary + 1)).status, 'waiting');
  const ready = preview(raw.slice(0, -1)); assert.equal(ready.status, 'ready');
  assert.deepEqual(ready.surface.nodes.map(n => n.id), ['people', 'amount']);
  const missing = { ...value, layout: [value.layout[0]] };
  assert.equal(partial(missing).status, 'invalid', 'closed layout cannot silently omit an input');
});

test('missing future references wait, closed missing references and cycles invalidate', () => {
  const value = plan();
  const prefix = JSON.stringify({ planVersion: 2, id: value.id, title: value.title, layout: value.layout, views: value.views }).slice(0, -1);
  assert.equal(preview(prefix).status, 'waiting');
  assert.equal(preview(prefix + ',"derived":[]').status, 'invalid');
  value.derived[0].args = [{ derived: 'other' }, { literal: 1 }];
  value.derived.push({ id: 'other', op: 'add', args: [{ derived: 'total' }] });
  assert.equal(partial(value).status, 'invalid');
});

test('bad closed declarations cannot hide outside the selected blocks', () => {
  for (const mutate of [
    p => p.inputs.push({ ...p.inputs[0] }),
    p => p.inputs.push({ id: 'bad', label: 'Bad', valueType: 'number', value: 4, min: 10 }),
    p => p.derived.push({ id: 'bad', op: 'divide', args: [{ literal: 1 }] }),
    p => p.derived.push({ id: 'bad', op: 'multiply', args: [{ literal: false }] }),
    p => p.views.push({ id: 'bad', kind: 'barChart', labels: ['x'], values: [{ literal: false }] }),
    p => p.layout.push({ ...p.layout[0], id: 'bad' }),
    p => { p.layout[0].columns = 1.5; },
    p => { p.layout[0].id = 'amount'; },
    p => { p.title = ' '; },
  ]) {
    const value = plan(); mutate(value);
    // Layout still open, so omitted-but-invalid declarations cannot be hidden.
    const raw = JSON.stringify(value).slice(0, -2) + ',';
    assert.equal(preview(raw).status, 'invalid', JSON.stringify(value));
  }
});

test('comparison and filtered table wait for dependencies and preserve lazy conditional evaluation', () => {
  const value = { planVersion: 2, id: 'courses', title: 'Courses',
    inputs: [{ id: 'cap', label: 'Limit', valueType: 'number', value: 20 }],
    derived: [{ id: 'zero', op: 'divide', args: [{ literal: 1 }, { literal: 0 }] },
      { id: 'lazy', op: 'if', args: [{ literal: false }, { derived: 'zero' }, { literal: 10 }] }],
    views: [{ id: 'table', kind: 'table', columns: ['Price'], rows: [[{ derived: 'lazy' }], [{ literal: 30 }]] },
      { id: 'a', kind: 'text', text: 'A' }, { id: 'b', kind: 'text', text: 'B' }],
    layout: [{ id: 'filter', type: 'filteredTable', title: 'Results', tableId: 'table', filters: [{ column: 0, controlId: 'cap', operator: 'lte' }] },
      { id: 'cards', type: 'comparison', title: 'Compare', cards: [{ id: 'cardA', title: 'A', nodeIds: ['a'] }, { id: 'cardB', title: 'B', nodeIds: ['b'] }] },
      { id: 'controls', type: 'group', title: 'Controls', columns: 1, nodeIds: ['cap'] }] };
  const raw = JSON.stringify(value), cut = raw.indexOf(',{"id":"controls"');
  const first = preview(raw.slice(0, cut + 1));
  assert.equal(first.status, 'ready'); assert.deepEqual(first.surface.layout.map(b => b.id), ['cards']);
  const result = partial(value); assert.equal(result.status, 'ready');
  assert.match(result.snapshot, /Rows shown: 1\/2/);
  value.layout[0].filters[0].operator = 'contains';
  assert.equal(partial(value).status, 'invalid');
});
