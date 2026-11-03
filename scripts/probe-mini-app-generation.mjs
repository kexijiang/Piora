/** Opt-in real-model development probe. Synthetic task, isolated session files,
 * production extensions/wrapper, and no filesystem/browser/action tools. */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createJiti } from 'jiti';
import { ModelRuntime, getAgentDir, SettingsManager, createAgentSessionServices, createAgentSessionFromServices } from '@earendil-works/pi-coding-agent';
import { getSystemMessageText } from '@earendil-works/pi-ai';
import { prepareMiniAppRuntime } from './prepare-mini-app-runtime.mjs';

const repo = resolve(import.meta.dirname, '..');
const suite = JSON.parse(await readFile(join(repo, 'tests/fixtures/intelligent-ui/phase3-first-tasks.json'), 'utf8'));
// Only the prompt is sent to the model. Expected forms and independent checks
// are evaluation data, never additional instructions or answer hints.
const cases = Object.fromEntries(suite.tasks.map(task => [task.id, task.prompt]));
const name = process.argv[2] ?? 'sorting';
const maxTokens = Number(process.argv[3] ?? 8192);
const thinkingIndex = process.argv.indexOf('--thinking');
const thinking = thinkingIndex === -1 ? 'disabled' : process.argv[thinkingIndex + 1];
if (!['disabled', 'enabled'].includes(thinking)) throw new Error('--thinking must be disabled or enabled');
const reasoning = thinking === 'enabled' ? 'medium' : 'off';
const promptIndex = process.argv.indexOf('--prompt-file');
if (promptIndex !== -1) {
  if (!process.argv[promptIndex + 1]) throw new Error('--prompt-file requires an explicit development prompt path');
  const prompt = (await readFile(resolve(process.argv[promptIndex + 1]), 'utf8')).trim();
  if (!prompt || prompt.length > 4000) throw new Error('Development prompt must contain 1..4000 characters');
  cases[name] = prompt;
}
if (![8192, 32768].includes(maxTokens)) throw new Error('Supported probe token limits: 8192, 32768');
if (!Object.hasOwn(cases, name)) throw new Error(`Choose ${Object.keys(cases).join(', ')}`);
const originalAgentDir = getAgentDir();
const runtime = await ModelRuntime.create({ authPath: join(originalAgentDir, 'auth.json'), modelsPath: join(originalAgentDir, 'models.json'), allowModelNetwork: false });
const model = runtime.getModel('deepseek', 'deepseek-flash');
if (runtime.getError() || !model || !/V4\.1/i.test(model.name) || !runtime.hasConfiguredAuth('deepseek')) throw new Error('Expected the configured DeepSeek V4.1 Flash model and credentials; no fallback is permitted');
await prepareMiniAppRuntime(repo);
await mkdir(join(repo, '.verification'), { recursive: true });
const directory = await mkdtemp(join(repo, '.verification', 'mini-app-live-'));
const agentDir = join(directory, 'agent'), cwd = join(directory, 'workspace');
await mkdir(agentDir); await mkdir(cwd);
const report = { case: name, prompt: cases[name], model: { provider: model.provider, id: model.id, name: model.name },
  startedAt: new Date().toISOString(), thinking, reasoning, scope: 'real model + production SDK/wrapper/admission/publication; browser interaction and semantic acceptance not covered',
  status: 'running', maxTokens, requests: [], events: [], plans: [], providerModelIds: [] };
const save = () => writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n');
await save(); console.log(JSON.stringify({ directory, case: name, status: 'running', model: report.model }));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const jiti = createJiti(import.meta.url, { alias: { '@': repo } });
const { AgentSessionWrapper } = await jiti.import('../lib/rpc-manager.ts');
const { writeBetaFeatures } = await jiti.import('../lib/beta-features.ts');
const { createOwnedSessionManager } = await jiti.import('../lib/session-owned-manager.ts');
const { resolveExtensionLoadPlan, applyExtensionLoadPlan } = await jiti.import('../lib/extension-config.ts');
const { miniAppJournalPath } = await jiti.import('../lib/mini-app/journal.ts');
const { readUiOutput } = await jiti.import('../lib/intelligent-ui/read-output.ts');
const cancellation = new AbortController();
const deadline = setTimeout(() => cancellation.abort(), 180_000);
const originalStream = runtime.streamSimple.bind(runtime);
runtime.streamSimple = (selected, context, options) => {
  if (selected.provider !== model.provider || selected.id !== model.id) throw new Error('Model fallback is forbidden');
  if (report.requests.length >= 4) throw new Error('Probe model request limit reached');
  const request = { number: report.requests.length + 1, startedAt: new Date().toISOString(),
    systemPrompt: context.messages.filter(message => message.role === 'system').map(getSystemMessageText).join('\n') };
  report.requests.push(request);
  // Preserve provider compatibility metadata while pinning this evaluation to
  // explicit Flash thinking setting. Verify the wire body before any request.
  return originalStream(selected, context, { ...options, maxTokens, reasoning, maxRetries: 0, timeoutMs: 120_000,
    signal: options?.signal ? AbortSignal.any([options.signal, cancellation.signal]) : cancellation.signal,
    fetch: async (...args) => {
      if (typeof args[1]?.body === 'string') {
        const body = JSON.parse(args[1].body);
        request.generationSettings = { model: body.model, max_tokens: body.max_tokens, max_completion_tokens: body.max_completion_tokens, thinking: body.thinking, reasoning_effort: body.reasoning_effort };
        if (body.model !== 'deepseek-flash' || body.thinking?.type !== thinking) throw new Error(`Evaluation requires deepseek-flash with thinking explicitly ${thinking}; no request was sent`);
      } else {
        throw new Error('Cannot verify the actual evaluation request body; no request was sent');
      }
      const response = await fetch(...args); request.httpStatus = response.status;
      if (!response.body) return response;
      const decoder = new TextDecoder(); let pending = '';
      const inspect = new TransformStream({ transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split('\n'); pending = lines.pop();
        if (pending.length > 1024 * 1024) throw new Error('Provider line exceeds probe budget');
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let value; try { value = JSON.parse(line.slice(6)); } catch { continue; }
          if (typeof value.model === 'string' && !report.providerModelIds.includes(value.model)) {
            report.providerModelIds.push(value.model);
            if (/pro/i.test(value.model)) cancellation.abort();
          }
        }
        controller.enqueue(chunk);
      } });
      return new Response(response.body.pipeThrough(inspect), { status: response.status, statusText: response.statusText, headers: response.headers });
    },
  });
};
let wrapper, owned, session;
try {
  writeBetaFeatures({ intelligentUi: true }, agentDir);
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const loadPlan = await resolveExtensionLoadPlan({ cwd, agentDir, settingsManager, profile: 'normal', preferences: { version: 1, disabled: [] } });
  loadPlan.enabledPaths = loadPlan.candidates.filter(candidate => ['piora:intelligent-ui', 'piora:mini-app'].includes(candidate.id) && candidate.enabled).map(candidate => candidate.path);
  if (loadPlan.enabledPaths.length !== 2) throw new Error('Expected both production UI extensions');
  const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime: runtime, settingsManager, resourceLoaderOptions: {
    additionalExtensionPaths: loadPlan.enabledPaths, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionsOverride: result => applyExtensionLoadPlan(result, loadPlan),
  } });
  owned = createOwnedSessionManager(cwd, join(agentDir, 'sessions', 'project'), agentDir);
  ({ session } = await createAgentSessionFromServices({ services, sessionManager: owned.manager, model, thinkingLevel: reasoning,
    tools: ['piora_render_ui_plan', 'piora_render_mini_app'] }));
  session.setAutoRetryEnabled(false); session.setAutoCompactionEnabled(false);
  wrapper = new AgentSessionWrapper(session, 'normal', { ownedSessionManager: owned });
  wrapper.initializeSessionCapabilities(); wrapper.start(); wrapper.beginExtensionBinding(); await wrapper.waitUntilReady();
  report.sessionId = session.sessionId;
  wrapper.onEvent(event => {
    if (['tool_execution_start', 'tool_execution_end', 'prompt_error', 'prompt_done'].includes(event.type)) {
      report.events.push(event);
      console.log(JSON.stringify({ type: event.type, tool: event.toolName, isError: event.isError }));
    }
  });
  await wrapper.send({ type: 'prompt', message: cases[name] });
  while (wrapper.isRunning() || wrapper.getActivePromptRunId()) {
    if (cancellation.signal.aborted) { await wrapper.send({ type: 'abort' }); throw new Error('Probe cancelled or timed out'); }
    await new Promise(done => setTimeout(done, 100));
  }
  report.messages = session.messages;
  try { report.journal = JSON.parse(await readFile(miniAppJournalPath(session.sessionId, agentDir), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  report.components = [];
  for (const message of session.messages) {
    if (message.role !== 'toolResult' || message.isError || message.details?.answerOutput?.kind !== 'intelligent-ui') continue;
    const output = await readUiOutput(owned.manager, message.toolCallId, { root: agentDir });
    report.components.push({ toolCallId: message.toolCallId, ...output });
  }
  const assistant = session.messages.findLast(message => message.role === 'assistant');
  report.finalText = typeof assistant?.content === 'string' ? assistant.content : (assistant?.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n');
  report.stopReason = assistant?.stopReason;
  report.status = report.events.some(event => event.type === 'prompt_error') || ['length', 'error', 'aborted'].includes(assistant?.stopReason) ? 'failed' : 'completed';
  report.observedForms = [
    ...(report.journal?.records?.some(record => record.status === 'committed') ? ['mini-app'] : []),
    ...(report.components.some(output => output.publication?.status === 'committed') ? ['intelligent-ui'] : []),
  ];
  report.outcome = assistant?.stopReason === 'length' ? 'output-limit' : report.observedForms.length > 1 ? 'multiple-ui-forms'
    : report.observedForms[0] === 'mini-app' ? 'published-mini-app' : report.observedForms[0] === 'intelligent-ui' ? 'published-components' : 'no-ui';
  if (!report.observedForms.length) report.observedForms.push('non-ui');
  report.toolAttempts = session.messages.filter(message => message.role === 'toolResult' && ['piora_render_mini_app', 'piora_render_ui_plan'].includes(message.toolName))
    .map(message => ({ toolCallId: message.toolCallId, toolName: message.toolName, isError: !!message.isError,
      diagnostic: message.details?.answerOutputDiagnostic ?? message.details?.diagnostic ?? null }));
  report.usage = session.messages.filter(message => message.role === 'assistant').map(message => message.usage ?? null);
} catch (error) {
  report.status = 'failed'; report.error = String(error?.message ?? error); process.exitCode = 1;
} finally {
  clearTimeout(deadline); cancellation.abort();
  if (session) {
    report.messages = session.messages;
    report.toolAttempts = session.messages.filter(message => message.role === 'toolResult' && ['piora_render_mini_app', 'piora_render_ui_plan'].includes(message.toolName))
      .map(message => ({ toolCallId: message.toolCallId, toolName: message.toolName, isError: !!message.isError,
        diagnostic: message.details?.answerOutputDiagnostic ?? message.details?.diagnostic ?? null }));
  }
  if (wrapper) await wrapper.shutdownForFileMutation(); else owned?.release();
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  report.endedAt = new Date().toISOString(); await save();
  if (report.status !== 'completed') process.exitCode = 1;
  console.log(JSON.stringify({ directory, status: report.status, requests: report.requests.length, providerModelIds: report.providerModelIds }));
}
