import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createJiti } from 'jiti';
import { createAssistantMessageEventStream, getSystemMessageText } from '@earendil-works/pi-ai';
import { createAgentSessionServices, createAgentSessionFromServices, SettingsManager } from '@earendil-works/pi-coding-agent';
import { counterPlan } from './mini-app-fixtures.mjs';
import { prepareMiniAppRuntime } from '../scripts/prepare-mini-app-runtime.mjs';

const jiti = createJiti(import.meta.url, { alias: { '@': resolve(import.meta.dirname, '..') } });
const { AgentSessionWrapper } = await jiti.import('./rpc-manager.ts');
const { readBetaFeatures, writeBetaFeatures } = await jiti.import('./beta-features.ts');
const { createOwnedSessionManager } = await jiti.import('./session-owned-manager.ts');
const { readOnlySessionManager } = await jiti.import('./session-readonly-manager.ts');
const { resolveExtensionLoadPlan, applyExtensionLoadPlan } = await jiti.import('./extension-config.ts');
const { getMiniAppGenerationRuntime } = await jiti.import('./mini-app/generation-runtime.ts');
const { miniAppJournalPath } = await jiti.import('./mini-app/journal.ts');
const { readMiniAppOutput, saveMiniAppOutput } = await jiti.import('./mini-app/state-service.ts');
const { readUiOutput } = await jiti.import('./intelligent-ui/read-output.ts');
const { resolveSessionPath } = await jiti.import('./session-reader.ts');
const { ANSWER_FORM_GUIDELINES } = await jiti.import('./answer-output-decision.ts');
await prepareMiniAppRuntime();
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const componentPlan = () => ({ planVersion: 1, id: 'component', title: 'Comparison', inputs: [{ id: 'people', valueType: 'number', label: 'People', value: 4, min: 1, max: 20 }], derived: [], views: [{ id: 'amount', kind: 'metric', label: 'People', value: { input: 'people' } }] });
async function until(predicate, label) {
  const deadline = performance.now() + 20_000;
  while (!predicate()) { assert.ok(performance.now() < deadline, `Timeout: ${label}`); await new Promise(done => setTimeout(done, 10)); }
}
function savedMiniState(request) {
  const messages = JSON.parse(request.context).messages;
  const texts = messages.flatMap(message => typeof message.content === 'string' ? [message.content] : (message.content ?? []).filter(block => block.type === 'text').map(block => block.text));
  const state = texts.findLast(text => text.startsWith('Saved mini app parameters and host publication results'));
  assert.ok(state, 'the model receives the saved-state context message');
  return JSON.parse(state.slice(state.indexOf('\n') + 1));
}

// The model is deterministic. The extension loader, SDK, wrapper, admission,
// QuickJS trial, disk publication and state service are the production paths.
test('real wrapper shares component and mini app tools, publishes disk receipts, and revokes cancelled work', { timeout: 120_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'piora-mini-wrapper-'));
  const agentDir = join(root, 'agent'), cwd = join(root, 'workspace');
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PIORA_UI_INPUT_PROTOCOL: process.env.PIORA_UI_INPUT_PROTOCOL };
  process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PIORA_UI_INPUT_PROTOCOL = 'plan-1';
  let wrapper, owned, scenario = 'create', index = 0, releaseBoundary, boundaryWaiting = false, heldRuntime;
  const events = [], requests = [], candidateStatuses = [];
  try {
    await mkdir(agentDir); await mkdir(cwd); writeBetaFeatures({ intelligentUi: true }, agentDir);
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const loadPlan = await resolveExtensionLoadPlan({ cwd, agentDir, settingsManager, profile: 'normal', preferences: { version: 1, disabled: [] } });
    loadPlan.enabledPaths = loadPlan.candidates.filter(c => ['piora:intelligent-ui', 'piora:mini-app'].includes(c.id) && c.enabled).map(c => c.path);
    assert.equal(loadPlan.enabledPaths.length, 2);
    const services = await createAgentSessionServices({ cwd, agentDir, settingsManager, resourceLoaderOptions: {
      additionalExtensionPaths: loadPlan.enabledPaths, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionsOverride: result => applyExtensionLoadPlan(result, loadPlan),
      extensionFactories: [api => api.registerProvider('mini-wrapper-fixture', { api: 'mini-wrapper-api', apiKey: 'test', baseUrl: 'https://unused.invalid',
        models: [{ id: 'test', name: 'test', reasoning: false, input: ['text'], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        streamSimple(model, context) {
          const n = index++; requests.push({ scenario, n, context: JSON.stringify(context) });
          const runtime = getMiniAppGenerationRuntime(wrapper.inner.sessionManager);
          if (!(scenario === 'disable' && n > 0)) assert.ok(runtime, 'binding precedes the model request');
          if (scenario === 'create' && n === 0) wrapper.inner.sessionManager.appendSessionInfo('Automatic title');
          if (['cancel', 'disable'].includes(scenario) && n === 0) {
            heldRuntime = runtime;
            const original = runtime.onTurnEnd.bind(runtime);
            const gate = new Promise(done => { releaseBoundary = done; });
            runtime.onTurnEnd = async boundary => {
              if (boundary.toolResultEntryIds.length) { boundaryWaiting = true; await gate; }
              return original(boundary);
            };
          }
          const mini = () => {
            const args = counterPlan();
            if (['repair', 'cancel', 'disable', 'resumed', 'mixed', 'shared-budget'].includes(scenario)) args.id = scenario;
            if (scenario === 'revise') args.title = 'Counter with a changed explanation';
            if (['repair', 'shared-budget'].includes(scenario) && n === 0) args.inputs[0].value = '2';
            return { type: 'toolCall', id: `${scenario}-${n}`, name: 'piora_render_mini_app', arguments: args };
          };
          let content = [{ type: 'text', text: 'done' }];
          if (!['explain', 'inspect'].includes(scenario) && n === 0 || scenario === 'repair' && n === 1 || scenario === 'shared-budget' && n === 2) content = [mini()];
          if (scenario === 'inspect' && n === 0) content = [{ type: 'toolCall', id: 'inspect-0', name: 'piora_inspect_mini_app', arguments: { appId: 'counter', actionIds: ['increment'] } }];
          if (scenario === 'mixed' && n === 0) content.push({ type: 'toolCall', id: 'mixed-component', name: 'piora_render_ui_plan', arguments: componentPlan() });
          if (scenario === 'shared-budget' && n === 1) {
            const args = componentPlan(); args.inputs[0].value = '4';
            content = [{ type: 'toolCall', id: `${scenario}-${n}`, name: 'piora_render_ui_plan', arguments: args }];
          }
          const reason = content[0].type === 'toolCall' ? 'toolUse' : 'stop';
          const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, timestamp: Date.now(), usage, stopReason: reason };
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason, message }); });
          return stream;
        },
      })],
    } });
    owned = createOwnedSessionManager(cwd, join(agentDir, 'sessions', 'project'), agentDir);
    const { session } = await createAgentSessionFromServices({ services, sessionManager: owned.manager, model: services.modelRuntime.getModel('mini-wrapper-fixture', 'test') });
    session.setAutoRetryEnabled(false); session.setAutoCompactionEnabled(false);
    wrapper = new AgentSessionWrapper(session, 'normal', { ownedSessionManager: owned });
    wrapper.initializeSessionCapabilities(); wrapper.start(); wrapper.beginExtensionBinding(); await wrapper.waitUntilReady();
    const id = session.sessionId, file = session.sessionFile;
    assert.ok(session.getAllTools().some(tool => tool.name === 'piora_render_mini_app'));
    assert.ok(session.getAllTools().some(tool => tool.name === 'piora_render_ui_plan'));
    const readManager = () => readOnlySessionManager(file, { expectedSessionId: id, leafId: session.sessionManager.getLeafId() });
    const options = { sessionId: id, readManager, root: agentDir };
    const read = toolCallId => readMiniAppOutput({ ...options, toolCallId });
    const journal = () => JSON.parse(readFileSync(miniAppJournalPath(id, agentDir), 'utf8'));
    wrapper.onEvent(event => {
      events.push(event);
      if (event.type === 'tool_execution_end' && event.toolName === 'piora_render_mini_app' && !event.isError) candidateStatuses.push(journal().records.find(r => r.toolCallId === event.toolCallId)?.status);
    });
    const run = async name => {
      await until(() => !wrapper.isRunning() && !wrapper.getActivePromptRunId(), 'idle');
      scenario = name; index = 0;
      await wrapper.send({ type: 'prompt', message: name });
      await until(() => !wrapper.isRunning() && !wrapper.getActivePromptRunId(), `${name} settled`);
    };
    await t.test('publish only after the persisted SDK turn receipt and emit bounded previews', async () => {
      await run('create');
      const firstContext = JSON.parse(requests.find(r => r.scenario === 'create' && r.n === 0).context);
      const systemPrompt = firstContext.messages.filter(message => message.role === 'system').map(getSystemMessageText).join('\n');
      for (const rule of ANSWER_FORM_GUIDELINES) {
        assert.equal(systemPrompt.split(rule).length - 1, 1, 'SDK assembles each shared selection rule exactly once');
      }
      const declaredTools = firstContext.messages.filter(message => message.role === 'system').flatMap(message => message.toolsAdded ?? []);
      assert.ok(declaredTools.some(tool => tool.name === 'piora_render_ui_plan'));
      assert.ok(declaredTools.some(tool => tool.name === 'piora_render_mini_app'));
      assert.ok(declaredTools.some(tool => tool.name === 'piora_inspect_mini_app'));
      assert.deepEqual(candidateStatuses, ['candidate']);
      const created = await read('create-0');
      assert.equal(created.publication.status, 'committed'); assert.equal(created.result.frame.summary, 'Count: 2');
      assert.match(requests.find(r => r.scenario === 'create' && r.n === 1).context, /committed/);
      const previews = events.filter(e => e.type === 'answer_output_preview' && e.preview.kind === 'mini-app').map(e => e.preview);
      assert.ok(previews.some(p => p.phase === 'complete')); assert.ok(previews.some(p => p.phase === 'cleared'));
      assert.ok(previews.every((p, i) => !i || p.seq > previews[i - 1].seq));
      for (const preview of previews) assert.equal(JSON.stringify(preview).includes('function init'), false);
    });
    await t.test('save a real checkpoint and explain from its acknowledged state without regeneration', async () => {
      const current = await read('create-0');
      await saveMiniAppOutput({ ...options, enabled: () => readBetaFeatures(agentDir).intelligentUi, request: {
        requestId: 'save-count-13', toolCallId: 'create-0', publicationId: current.publication.id, planDigest: current.publication.planDigest,
        runtimeVersion: current.publication.runtimeVersion, leafId: current.leafId, expectedRevision: current.stateRevision,
        checkpoint: { ...current.result.snapshot, inputs: { start: 7 }, state: { count: 13 }, tick: 11 },
      } });
      const before = journal().records.length;
      await run('explain');
      const context = savedMiniState(requests.find(r => r.scenario === 'explain'));
      const app = context.apps.find(app => app.id === 'counter');
      assert.ok(app); assert.equal(app.summary, 'Count: 13');
      assert.equal(Object.hasOwn(app,'tick'),false,'host clock is not a top-level task fact');
      assert.deepEqual(app.runtimeMetadata,{tick:11,playbackMode:current.plan.playback?.mode??'legacy'});
      assert.equal(app.inputs.find(input => input.id === 'start').value, 7);
      assert.equal(app.progressSource.complete,true);assert.equal(app.progressSource.planDigest,current.publication.planDigest);
      assert.deepEqual(app.progressSource.snapshot,{inputs:{start:7},state:{count:13},tick:11,rng:current.result.snapshot.rng});
      assert.deepEqual(app.progressSource.stateSchema,current.plan.stateSchema);
      assert.equal(app.localActionPreviews,undefined,'plain explanations receive current facts, not automatically executed alternatives');
      assert.equal(app.localActions.tool,'piora_inspect_mini_app');
      assert.deepEqual(app.localActions.choices.map(choice=>choice.id),['increment']);
      assert.equal(requests.filter(r=>r.scenario==='explain').length,1,'no separate classification or inspection model call');
      await run('inspect');
      const inspection=events.find(event=>event.type==='tool_execution_end'&&event.toolCallId==='inspect-0');
      assert.ok(inspection&&!inspection.isError);
      const previews=inspection.result.details.miniAppActionInspection;
      assert.equal(previews.appId,'counter');assert.deepEqual(previews.requestedActionIds,['increment']);
      assert.equal(previews.source.planDigest,current.publication.planDigest);
      assert.equal(previews.source.stateRevision,(await read('create-0')).stateRevision);
      assert.equal(previews.eligibleActions,1);assert.equal(previews.omittedActions,0);
      assert.equal(previews.version,2);assert.equal(previews.actions[0].id,'increment');
      assert.deepEqual(previews.actions[0].changes,{complete:true,total:1,omitted:0,items:[{path:'/state/count',kind:'replace',before:13,after:14}]});
      assert.equal(Object.hasOwn(previews.actions[0],'snapshot'),false);assert.equal(Object.hasOwn(previews.actions[0],'summary'),false);
      assert.deepEqual(previews.fieldEffects.fields.find(row=>row.path==='/state/count'),{
        path:'/state/count',current:13,unchanged:[],outcomes:[{present:true,value:14,actions:['increment']}],unknown:[],
      });
      assert.deepEqual((await read('create-0')).result.snapshot,app.progressSource.snapshot,'previews never save their counterfactual result');
      assert.equal(journal().records.length, before);
    });
    await t.test('original invalid arguments get one actionable correction before publication', async () => {
      await run('repair');
      const results = events.filter(e => e.type === 'tool_execution_end' && e.toolCallId?.startsWith('repair-'));
      assert.deepEqual(results.map(e => !!e.isError), [true, false]);
      assert.match(JSON.stringify(results[0]), /inputs.*value/);
      assert.equal((await read('repair-1')).publication.status, 'committed');
    });
    await t.test('component and mini app share one prompt and cannot reset the correction budget by switching tools', async () => {
      await run('mixed');
      assert.equal((await read('mixed-0')).publication.status, 'committed');
      assert.equal((await readUiOutput(readManager(), 'mixed-component', { root: agentDir })).publication.status, 'committed');
      await run('shared-budget');
      const results = events.filter(e => e.type === 'tool_execution_end' && e.toolCallId?.startsWith('shared-budget-'));
      assert.deepEqual(results.map(e => !!e.isError), [true, true, true]);
      assert.match(JSON.stringify(results[2]), /UI_CORRECTIONS_EXHAUSTED/);
      assert.equal(journal().records.some(r => r.toolCallId.startsWith('shared-budget-')), false);
    });
    await t.test('a program revision remains a proposal and preserves confirmed state', async () => {
      await run('revise');
      assert.equal((await read('revise-0')).publication.status, 'awaiting_confirmation');
      assert.equal((await read('create-0')).publication.status, 'committed');
      assert.equal((await read('create-0')).result.frame.summary, 'Count: 13');
      assert.match(requests.find(r => r.scenario === 'revise' && r.n === 1).context, /awaiting_confirmation/);
    });
    for (const name of ['cancel', 'disable']) await t.test(`${name} before publication cannot resurrect a late candidate`, async () => {
      scenario = name; index = 0; boundaryWaiting = false;
      await wrapper.send({ type: 'prompt', message: name });
      await until(() => boundaryWaiting, 'candidate at SDK publication boundary');
      assert.equal(journal().records.find(r => r.toolCallId === `${name}-0`).status, 'candidate');
      let aborting;
      if (name === 'cancel') {
        aborting = wrapper.send({ type: 'abort' });
        await until(() => !wrapper.getActivePromptRunId(), 'prompt revoked');
      } else {
        writeBetaFeatures({ intelligentUi: false }, agentDir); writeBetaFeatures({ intelligentUi: true }, agentDir);
        assert.equal(getMiniAppGenerationRuntime(session.sessionManager), undefined);
        await heldRuntime.finish('abort');
      }
      releaseBoundary(); releaseBoundary = undefined;
      await aborting;
      await until(() => !wrapper.isRunning() && !wrapper.getActivePromptRunId(), `${name} settled`);
      assert.equal((await read(`${name}-0`)).publication.status, 'aborted');
      assert.equal((await read('create-0')).result.frame.summary, 'Count: 13');
    });
    await t.test('a fresh run works after re-enable and the production fork preserves confirmed mini app state', async () => {
      await run('resumed'); assert.equal((await read('resumed-0')).publication.status, 'committed');
      await run('explain');
      const forkPoint = session.sessionManager.getBranch().findLast(e => e.type === 'message' && e.message.role === 'user');
      const forked = await wrapper.send({ type: 'fork', entryId: forkPoint.id });
      assert.equal(forked.cancelled, false);
      const childFile = await resolveSessionPath(forked.newSessionId); assert.ok(childFile);
      const child = readOnlySessionManager(childFile, { expectedSessionId: forked.newSessionId });
      const inherited = await readMiniAppOutput({ sessionId: forked.newSessionId, readManager: () => child, root: agentDir, toolCallId: 'create-0' });
      assert.equal(inherited.result.frame.summary, 'Count: 13'); assert.equal(inherited.result.snapshot.inputs.start, 7);
      await wrapper.shutdownForFileMutation(); wrapper = undefined; owned = undefined;
      const restored = readOnlySessionManager(file, { expectedSessionId: id });
      const saved = await readMiniAppOutput({ sessionId: id, readManager: () => restored, root: agentDir, toolCallId: 'create-0' });
      assert.equal(saved.result.frame.summary, 'Count: 13');
    });
  } finally {
    releaseBoundary?.();
    if (wrapper) await wrapper.shutdownForFileMutation(); else owned?.release();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    assert.equal(dirname(root), tmpdir());
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
