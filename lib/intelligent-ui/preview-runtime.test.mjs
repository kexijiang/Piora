import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { UiPreviewRuntime } = await jiti.import('./preview-runtime.ts');
const { readAnswerOutputPreviewSnapshot } = await jiti.import('../answer-output-preview.ts');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const plan = () => ({ planVersion: 2, id: 'bill', title: 'Bill',
  inputs: [{ id: 'people', label: 'People', valueType: 'number', value: 4 }], derived: [],
  views: [{ id: 'total', kind: 'metric', label: 'Total', value: { input: 'people' } }],
  layout: [{ id: 'inputs', type: 'group', title: 'Inputs', columns: 1, nodeIds: ['people'] },
    { id: 'results', type: 'group', title: 'Results', columns: 1, nodeIds: ['total'] }] });
function fixture(t) {
  const events = []; let active = true;
  const runtime = new UiPreviewRuntime({ sessionId: 'session', runId: 'run', intervalMs: 1, isActive: () => active,
    emit: value => events.push(value) });
  t.after(() => runtime.cancel()); runtime.beginRequest();
  const content = [{ type: 'toolCall', id: 'call', name: 'piora_render_ui_plan', arguments: {} }];
  const message = { role: 'assistant', timestamp: 1000, provider: 'fixture', model: 'test', content };
  runtime.observe({ type: 'message_start', message });
  const update = (type, extra = {}) => runtime.observe({ type: 'message_update', message,
    assistantMessageEvent: { type, contentIndex: 0, partial: message, ...extra } });
  update('toolcall_start');
  return { runtime, events, content, message, update, deactivate() { active = false; } };
}
function firstGroupPrefix(value) {
  const raw = JSON.stringify(value), marker = ',{"id":"results"';
  return { raw, prefix: raw.slice(0, raw.indexOf(marker) + 1) };
}

test('closed blocks appear before tool completion and snapshot is transient, bounded and independent', async t => {
  const f = fixture(t), { raw, prefix } = firstGroupPrefix(plan());
  f.update('toolcall_delta', { delta: prefix });
  await pause(15);
  const partial = f.events.find(e => e.phase === 'partial');
  assert.ok(partial); assert.equal(partial.payload.layout.length, 1);
  assert.deepEqual(partial.payload.nodes.map(n => n.id), ['people']);
  assert.equal(f.events.some(e => e.phase === 'complete'), false);
  const snapshot = f.runtime.snapshot(); assert.ok(readAnswerOutputPreviewSnapshot(snapshot));
  snapshot.previews[0].payload.title = 'mutated';
  assert.equal(f.runtime.snapshot().previews[0].payload.title, 'Bill');
  f.update('toolcall_delta', { delta: raw.slice(prefix.length) });
  f.content[0].arguments = plan();
  f.update('toolcall_end', { toolCall: f.content[0] });
  assert.equal(f.events.at(-1).phase, 'complete');
  assert.equal(f.events.at(-1).payload.layout.length, 2);
  f.runtime.observe({ type: 'tool_execution_update', toolCallId: 'call' });
  assert.equal(f.events.at(-1).phase, 'cleared');
  assert.equal(f.runtime.snapshot().previews.length, 0);
  assert.ok(f.events.every((event, i) => i === 0 || event.seq > f.events[i - 1].seq));
  assert.ok(f.events.every(event => !('operationId' in event) && !('committed' in event)));
});

test('shared SDK partial mutation cannot alter buffered raw members; final replacement is authoritative', async t => {
  const f = fixture(t), { prefix } = firstGroupPrefix(plan());
  f.update('toolcall_delta', { delta: prefix });
  f.content[0].arguments = { ...plan(), title: 'Shared object changed' };
  await pause(15);
  assert.equal(f.events.at(-1).payload.title, 'Bill');
  const replacement = plan(); replacement.inputs[0].value = 9; replacement.title = 'Final replacement';
  f.update('toolcall_end', { toolCall: { ...f.content[0], arguments: replacement } });
  replacement.title = 'Mutated later';
  assert.equal(f.events.at(-1).payload.title, 'Final replacement');
  assert.equal(f.events.at(-1).payload.nodes[0].value, 9);
  f.runtime.observe({ type: 'message_end', message: { ...f.message, stopReason: 'length' } });
  assert.equal(f.events.at(-1).phase, 'cleared');
});

test('cancellation and request replacement revoke pending timers and old deltas', async t => {
  const f = fixture(t), { prefix } = firstGroupPrefix(plan());
  f.update('toolcall_delta', { delta: prefix });
  f.runtime.resetRequest(); await pause(15);
  assert.deepEqual(f.events.map(e => e.phase), ['preparing', 'cleared']);
  f.runtime.beginRequest();
  f.update('toolcall_delta', { delta: prefix }); await pause(10);
  assert.equal(f.runtime.snapshot().previews.length, 0);
  const replacement = { ...f.message, timestamp: 2000, content: [{ ...f.content[0] }] };
  f.runtime.observe({ type: 'message_start', message: replacement });
  f.update('toolcall_start'); assert.equal(f.runtime.snapshot().previews.length, 0, 'old assistant stream is ignored');
  f.runtime.cancel();
  f.runtime.observe({ type: 'message_start', message: replacement });
  assert.equal(f.runtime.snapshot().runId, null);
});

test('invalid continuation revokes a valid prefix and cannot be repaired into a partial preview', async t => {
  const f = fixture(t), { prefix } = firstGroupPrefix(plan());
  f.update('toolcall_delta', { delta: prefix }); await pause(15);
  assert.equal(f.events.at(-1).phase, 'partial');
  f.update('toolcall_delta', { delta: 'oops' }); await pause(15);
  assert.equal(f.events.at(-1).phase, 'cleared');
  f.update('toolcall_delta', { delta: JSON.stringify(plan()) }); await pause(10);
  assert.equal(f.events.at(-1).phase, 'cleared');
  f.update('toolcall_end', { toolCall: { ...f.content[0], arguments: plan() } });
  assert.equal(f.events.at(-1).phase, 'cleared', 'revoked preview remains retired; the final tool result uses normal admission');
});

test('no raw deltas falls back to the complete final candidate, not invented incremental content', t => {
  const f = fixture(t);
  f.content[0].arguments = plan();
  f.runtime.observe({ type: 'message_end', message: { ...f.message, stopReason: 'toolUse' } });
  assert.deepEqual(f.events.map(e => e.phase), ['preparing', 'complete']);
  f.runtime.observe({ type: 'tool_execution_end', toolCallId: 'call', isError: true });
  assert.equal(f.events.at(-1).phase, 'cleared');
});

test('oversize raw streams and lost run authority clear previews without admitting more content', async t => {
  const f = fixture(t);
  f.update('toolcall_delta', { delta: ' '.repeat(64001) });
  assert.equal(f.events.at(-1).phase, 'cleared');
  f.deactivate(); f.update('toolcall_end', { toolCall: { ...f.content[0], arguments: plan() } });
  await pause(5); assert.equal(f.runtime.snapshot().previews.length, 0);
});
