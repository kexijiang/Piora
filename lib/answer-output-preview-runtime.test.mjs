import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createJiti } from 'jiti';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createAgentSessionServices, createAgentSessionFromServices, SettingsManager } from '@earendil-works/pi-coding-agent';
const jiti = createJiti(import.meta.url, { alias: { '@': resolve(import.meta.dirname, '..') } });
const { AgentSessionWrapper } = await jiti.import('./rpc-manager.ts');
const { writeBetaFeatures } = await jiti.import('./beta-features.ts');
const { createOwnedSessionManager } = await jiti.import('./session-owned-manager.ts');
const { generationJournalPath } = await jiti.import('./intelligent-ui/generation-journal.ts');
const { resolveExtensionLoadPlan, applyExtensionLoadPlan } = await jiti.import('./extension-config.ts');
const { createAgentEventTransport, createAgentEventDecoder } = await jiti.import('./agent-event-transport.ts');
const { AnswerOutputPreviewStore } = await jiti.import('./answer-output-preview-client.ts');
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const plan = () => ({ planVersion: 2, id: 'bill', title: '分账',
  inputs: [{ id: 'people', label: '人数', valueType: 'number', value: 4 }], derived: [],
  views: [{ id: 'total', kind: 'metric', label: '人数合计', value: { input: 'people' } }],
  layout: [{ id: 'parameters', type: 'group', title: '调整人数', columns: 1, nodeIds: ['people'] },
    { id: 'results', type: 'group', title: '结果', columns: 1, nodeIds: ['total'] }] });
async function until(predicate, label) {
  const deadline = performance.now() + 15000;
  while (!predicate()) { assert.ok(performance.now() < deadline, `Timeout: ${label}`); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('SDK raw fragments reach wrapper, transport, decoder and scoped preview before tools; reconnect and cancellation stay transient', { timeout: 90000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'piora-preview-runtime-'));
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PIORA_UI_INPUT_PROTOCOL: process.env.PIORA_UI_INPUT_PROTOCOL };
  const cwd = join(root, 'workspace'), agentDir = join(root, 'agent');
  process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PIORA_UI_INPUT_PROTOCOL = 'plan-2';
  let wrapper, owned, release, call = 0, scenario = 'create', finalSent = false, transport;
  const events = [], wire = [], store = new AnswerOutputPreviewStore(); let connection;
  try {
    await mkdir(cwd); await mkdir(agentDir); writeBetaFeatures({ intelligentUi: true }, agentDir);
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const loadPlan = await resolveExtensionLoadPlan({ cwd, agentDir, settingsManager, profile: 'normal', preferences: { version: 1, disabled: [] } });
    loadPlan.enabledPaths = loadPlan.candidates.filter(c => c.id === 'piora:intelligent-ui' && c.enabled).map(c => c.path);
    const services = await createAgentSessionServices({ cwd, agentDir, settingsManager, resourceLoaderOptions: {
      additionalExtensionPaths: loadPlan.enabledPaths, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionsOverride: result => applyExtensionLoadPlan(result, loadPlan),
      extensionFactories: [api => api.registerProvider('preview-fixture', { api: 'preview-fixture-api', apiKey: 'test', baseUrl: 'https://unused.invalid',
        models: [{ id: 'test', name: 'test', reasoning: false, input: ['text'], contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        streamSimple(model, _context, options) {
          const stream = createAssistantMessageEventStream(), initial = call++ === 0;
          const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
            content: [], timestamp: Date.now(), usage, stopReason: initial ? 'toolUse' : 'stop' };
          queueMicrotask(async () => {
            if (!initial) {
              message.content.push({ type: 'text', text: 'done' });
              stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'stop', message }); return;
            }
            const args = plan(), raw = JSON.stringify(args), cut = raw.indexOf(',{"id":"results"') + 1;
            const toolCall = { type: 'toolCall', id: `${scenario}-call`, name: 'piora_render_ui_plan', arguments: {} };
            message.content.push(toolCall);
            stream.push({ type: 'start', partial: message });
            stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message });
            stream.push({ type: 'toolcall_delta', contentIndex: 0, delta: raw.slice(0, cut), partial: message });
            await new Promise(resolveGate => {
              const finish = () => { options.signal?.removeEventListener('abort', finish); resolveGate(); };
              release = finish; options.signal?.addEventListener('abort', finish, { once: true });
              if (options.signal?.aborted) finish();
            });
            if (options.signal?.aborted) {
              message.stopReason = 'aborted'; stream.push({ type: 'error', reason: 'aborted', error: message }); return;
            }
            finalSent = true; toolCall.arguments = args;
            stream.push({ type: 'toolcall_delta', contentIndex: 0, delta: raw.slice(cut), partial: message });
            stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial: message });
            stream.push({ type: 'done', reason: 'toolUse', message });
          });
          return stream;
        },
      })],
    } });
    owned = createOwnedSessionManager(cwd, join(agentDir, 'sessions'), agentDir);
    const { session } = await createAgentSessionFromServices({ services, sessionManager: owned.manager, model: services.modelRuntime.getModel('preview-fixture', 'test') });
    session.setAutoRetryEnabled(false); session.setAutoCompactionEnabled(false);
    wrapper = new AgentSessionWrapper(session, 'normal', { ownedSessionManager: owned });
    wrapper.initializeSessionCapabilities(); wrapper.start(); wrapper.beginExtensionBinding(); await wrapper.waitUntilReady();
    const id = session.sessionId, file = session.sessionFile, journalPath = generationJournalPath(id, agentDir);
    const journal = () => existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')).records : [];
    connection = store.connect(id);
    const decode = createAgentEventDecoder();
    transport = createAgentEventTransport(event => {
      // Wire roundtrip rules out accidental shared-memory payloads.
      const serialized = JSON.stringify(event); wire.push(serialized);
      const decoded = decode(JSON.parse(serialized)); if (!decoded) return;
      if (decoded.type === 'prompt_started') store.started(connection, decoded.sessionId, decoded.runId);
      if (decoded.type === 'answer_output_preview') store.receive(connection, decoded.preview);
    }, { incremental: true, intervalMs: 1 });
    wrapper.onEvent(event => { events.push(structuredClone(event)); transport.push(event); });
    await wrapper.send({ type: 'prompt', message: '我们四个人出门，做个能调整人数的费用表' });
    await until(() => store.getSnapshot().get('create-call')?.phase === 'partial', 'preview before final arguments');
    assert.equal(finalSent, false);
    assert.equal(events.some(e => e.type === 'tool_execution_start'), false);
    assert.equal(journal().length, 0, 'raw preview does not create a durable candidate');
    const preview = store.getSnapshot().get('create-call');
    assert.deepEqual(preview.payload.nodes.map(n => n.id), ['people']);
    assert.equal(preview.payload.layout.length, 1);
    assert.equal(readFileSync(file, 'utf8').includes('answer_output_preview'), false);
    const reconnect = wrapper.getAnswerOutputPreviewSnapshot();
    connection = store.connect(id); store.restore(connection, JSON.parse(JSON.stringify(reconnect)));
    assert.deepEqual(store.getSnapshot().get('create-call'), preview);
    release(); release = undefined;
    await until(() => !wrapper.isRunning() && !wrapper.getActivePromptRunId(), 'complete generation');
    assert.equal(journal().find(r => r.toolCallId === 'create-call')?.status, 'committed');
    assert.equal(store.getSnapshot().size, 0);
    assert.equal(events.some(e => e.type === 'answer_output_preview' && e.preview.phase === 'complete'), true);
    assert.equal(wrapper.getAnswerOutputPreviewSnapshot().previews.length, 0);
    assert.equal(wire.some(line => line.includes('"type":"message_block"')), true);

    scenario = 'cancel'; call = 0; finalSent = false;
    await wrapper.send({ type: 'prompt', message: '再加个结果分组' });
    await until(() => store.getSnapshot().get('cancel-call')?.phase === 'partial', 'cancellable raw preview');
    const stale = wrapper.getAnswerOutputPreviewSnapshot();
    store.stop(); await wrapper.send({ type: 'abort' });
    await until(() => !wrapper.isRunning() && !wrapper.getActivePromptRunId(), 'cancel settled');
    connection = store.connect(id); store.restore(connection, stale);
    assert.equal(store.getSnapshot().size, 0); assert.equal(finalSent, false);
    assert.equal(journal().length, 1, 'cancelled preview produces no candidate');
    assert.equal(journal()[0].status, 'committed', 'previous committed answer survives');
    assert.equal(wrapper.getAnswerOutputPreviewSnapshot().previews.length, 0);
    assert.equal(events.filter(e => e.type === 'prompt_error').length, 0);
  } finally {
    release?.(); transport?.close();
    if (wrapper) await wrapper.shutdownForFileMutation(); else owned?.release();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    const taskPath = resolve(root); assert.ok(taskPath.startsWith(`${resolve(tmpdir())}\\`) || taskPath.startsWith(`${resolve(tmpdir())}/`));
    await rm(taskPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
