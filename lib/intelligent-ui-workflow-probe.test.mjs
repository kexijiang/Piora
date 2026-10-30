import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { runWorkflowProbe } from '../scripts/probe-intelligent-ui-workflow.mjs';

for (const failFollowup of [false, true]) test(`workflow probe verifies browser/disk controls and ${failFollowup ? 'records a failed follow-up honestly' : 'continues without leaking hidden reasoning'}`, { timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'piora-workflow-probe-'));
  const requests = []; let call = 0;
  const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: join(root, 'models.json'), allowModelNetwork: false });
  runtime.registerProvider('workflow-fixture', { api: 'workflow-fixture-api', apiKey: 'fixture', baseUrl: 'https://unused.invalid',
    models: [{ id: 'test', name: 'test', reasoning: false, input: ['text'], contextWindow: 20000, maxTokens: 6000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      requests.push(context);
      const plan = { planVersion: 2, id: 'budget', title: '预算', inputs: [
        { id: 'people', label: '人数', valueType: 'number', value: 4, min: 1 },
        { id: 'size', label: '大小', valueType: 'number', value: 4, min: 0, max: 10, step: 1, presentation: 'slider' },
        { id: 'category', label: '类别', valueType: 'string', value: '文艺', options: ['文艺', '运动'] },
        { id: 'enabled', label: '开启', valueType: 'boolean', value: false }],
        derived: [{ id: 'amount', op: 'multiply', args: [{ input: 'people' }, { op: 'add', args: [20, 10] }] }],
        views: [{ id: 'amount', kind: 'metric', label: '总价', value: { derived: 'amount' } },
          { id: 'details', kind: 'table', columns: ['项目', '人数'], rows: [['预算', { input: 'people' }]] }],
        layout: [{ id: 'group', type: 'group', title: '条件和结果', columns: 1, nodeIds: ['people', 'size', 'category', 'enabled', 'amount', 'details'] }] };
      const current = call++, content = current === 0 ? [{ type: 'toolCall', id: 'call', name: 'piora_render_ui_plan', arguments: plan }]
        : [{ type: 'thinking', thinking: 'PRIVATE_NOT_FOR_REPORT' }, { type: 'text', text: current === 1 ? '已生成预算。' : '现在6个人，总价180元。' }];
      const stopReason = current === 0 ? 'toolUse' : failFollowup && current > 1 ? 'error' : 'stop';
      const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, stopReason, timestamp: Date.now(),
        ...(stopReason === 'error' ? { errorMessage: 'Synthetic provider failure' } : {}),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream(); queueMicrotask(() => { stream.push({ type: 'start', partial: message });
        stream.push(stopReason === 'error' ? { type: 'error', reason: 'error', error: message } : { type: 'done', reason: stopReason, message }); }); return stream;
    },
  });
  try {
    const task = { prompt: '四个人，每人餐费20、门票10，人数让我改。', changes: [{ label: '^人数$', value: 6 }, { label: '^大小$', value: 7 },
      { label: '^类别$', value: '运动' }, { label: '^开启$', value: true }], followup: '现在多少人，总共多少钱？', checks: ['DO_NOT_SEND_CHECKS'] };
    const output = join(root, 'probe');
    const result = await runWorkflowProbe({ runtime, model: runtime.getModel('workflow-fixture', 'test'), task, output, scope: 'sdk-browser-routes-fixture' });
    assert.equal(result.outcome, failFollowup ? 'model-turn-incomplete' : 'workflow-completed', JSON.stringify({ error: result.error, stage: result.failedStage, turns: result.turns, browser: result.browser }));
    assert.equal(result.initial.publication.status, 'committed'); assert.equal(result.initial.state.people, 4);
    assert.equal(result.turns[0].toolResults.length, 1); assert.equal(result.turns[0].toolResults[0].isError, false);
    assert.equal(result.changes[0].state.people, 6); assert.equal(result.changes[0].outputs[0].value, 180);
    assert.equal(result.reload.matchesSavedState, true); assert.equal(result.reload.state.people, 6);
    assert.equal(result.reload.matchesBrowserControls, true);
    assert.deepEqual(result.reload.observedControls, { people: 6, size: 7, category: '运动', enabled: true });
    assert.match(result.reload.browserTables[0], /预算\t6/);
    if (!failFollowup) assert.match(result.turns[1].assistant, /180/);
    assert.equal(result.turns[1].terminal, failFollowup ? 'error' : 'stop'); assert.equal(result.turns[1].toolResults.length, 0);
    assert.ok(result.browser.requests.some(item => item.method === 'PUT' && item.status === 200));
    assert.deepEqual(result.browser.errors, []);
    assert.doesNotMatch(JSON.stringify(requests), /DO_NOT_SEND_CHECKS/);
    assert.match(JSON.stringify(requests.at(-1)), /people.*6/s);
    const report = await readFile(join(output, 'result.json'), 'utf8');
    assert.doesNotMatch(report, /PRIVATE_NOT_FOR_REPORT/); assert.ok(result.disk.journalSha256);
  } finally {
    runtime.unregisterProvider('workflow-fixture');
    assert.ok(resolve(root).startsWith(resolve(tmpdir()))); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
