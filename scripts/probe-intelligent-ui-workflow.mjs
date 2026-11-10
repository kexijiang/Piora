/** Real provider -> production SDK/wrapper -> journal -> browser -> real routes -> follow-up.
 * Synthetic data only. This exercises the feature in isolation, not the desktop shell.
 */
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createJiti } from 'jiti';
import { chromium } from 'playwright-core';
import { getAgentDir, ModelRuntime, SettingsManager, createAgentSessionServices, createAgentSessionFromServices } from '@earendil-works/pi-coding-agent';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url))), require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url, { alias: { '@': repo } });
const hash = value => createHash('sha256').update(value).digest('hex');
const { AgentSessionWrapper } = await jiti.import('../lib/rpc-manager.ts');
const { createOwnedSessionManager } = await jiti.import('../lib/session-owned-manager.ts');
const { writeBetaFeatures } = await jiti.import('../lib/beta-features.ts');
const { writeToolPermission } = await jiti.import('../lib/tool-permission-store.ts');
const { cacheSessionPath, invalidateSessionPathCache } = await jiti.import('../lib/session-reader.ts');
const { resolveExtensionLoadPlan, applyExtensionLoadPlan } = await jiti.import('../lib/extension-config.ts');
const { generationJournalPath } = await jiti.import('../lib/intelligent-ui/generation-journal.ts');
const { readUiOutput } = await jiti.import('../lib/intelligent-ui/read-output.ts');
const { evaluateExpression } = await jiti.import('../lib/intelligent-ui/surface-document.ts');
const stateRoute = await jiti.import('../app/api/sessions/[id]/intelligent-ui/route.ts');
const actionRoute = await jiti.import('../app/api/sessions/[id]/intelligent-ui/actions/route.ts');

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = performance.now() + timeoutMs;
  while (!await predicate()) {
    if (performance.now() >= deadline) throw new Error(`Probe timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
function values(saved) {
  return { state: saved.state, revision: saved.revision, leafId: saved.leafId, snapshot: saved.snapshot,
    outputs: saved.surface.nodes.filter(node => ['metric', 'table', 'barChart', 'text'].includes(node.type)).map(node => {
      try {
        if (node.type === 'metric') return { id: node.id, label: node.label, value: evaluateExpression(node.value, saved.state) };
        if (node.type === 'table') return { id: node.id, columns: node.columns, rows: node.rows.map(row => row.map(value => evaluateExpression(value, saved.state))) };
        if (node.type === 'barChart') return { id: node.id, labels: node.labels, values: node.values.map(value => evaluateExpression(value, saved.state)) };
        return { id: node.id, text: node.text };
      } catch { return { id: node.id, error: 'calculation-unavailable' }; }
    }) };
}

function controlLocator(page, control) {
  // Accessible names exclude nested option text and the range's output element.
  const role = { number: 'spinbutton', slider: 'slider', select: 'combobox', checkbox: 'checkbox' }[control.type];
  return page.getByRole(role, { name: control.label, exact: true });
}
async function browserControls(page, surface) {
  const pairs = [];
  for (const control of surface.nodes.filter(node => ['number', 'slider', 'select', 'checkbox'].includes(node.type))) {
    const locator = controlLocator(page, control);
    pairs.push([control.id, control.type === 'checkbox' ? await locator.isChecked()
      : control.type === 'select' ? await locator.inputValue() : Number(await locator.inputValue())]);
  }
  return Object.fromEntries(pairs);
}
function sameControls(actual, expected) {
  return Object.keys(actual).length === Object.keys(expected).length && Object.entries(expected).every(([id, value]) => actual[id] === value);
}
async function changeControl(page, control, value) {
  const locator = controlLocator(page, control);
  if (control.type === 'checkbox') await locator.setChecked(value);
  else if (control.type === 'select') await locator.selectOption(String(value));
  else if (control.type !== 'slider') await locator.fill(String(value));
  else {
    // Real keyboard input, not injecting state or dispatching fabricated events.
    await locator.press('Home');
    let previous = Number(await locator.inputValue());
    for (let count = 0; count < 1000 && previous < value; count++) {
      await locator.press('ArrowRight');
      const next = Number(await locator.inputValue());
      if (next <= previous) break;
      previous = next;
    }
    if (Math.abs(Number(await locator.inputValue()) - value) > 1e-9) throw new Error('Browser change cannot reach the requested slider value with keyboard input');
  }
}

async function browserBundle(directory) {
  const { webpack } = require('next/dist/compiled/webpack/webpack.js');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'loader.cjs'), `const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
  await writeFile(join(directory, 'css.cjs'), `module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))`);
  await writeFile(join(directory, 'entry.tsx'), `
import React,{useState}from'react';import{createRoot}from'react-dom/client';
import{I18nProvider}from ${JSON.stringify(join(repo, 'hooks/useI18n.tsx'))};
import{AnswerOutput}from ${JSON.stringify(join(repo, 'components/AnswerOutput.tsx'))};
import{flushPendingAnswerState}from ${JSON.stringify(join(repo, 'lib/answer-output-client.ts'))};
localStorage.setItem('pi-locale','zh-CN');window.flushUi=()=>flushPendingAnswerState();
function App(){const[result,setResult]=useState();window.showUi=setResult;return <I18nProvider>{result?<AnswerOutput result={result} sessionId={window.sessionId} toolCallId={result.toolCallId}/>:null}</I18nProvider>}
createRoot(document.getElementById('root')).render(<App/>);`);
  const compiler = webpack({ mode: 'development', target: 'web', devtool: false, entry: join(directory, 'entry.tsx'), output: { path: directory, filename: 'bundle.js', publicPath: '/' },
    resolve: { extensions: ['.tsx', '.ts', '.js'], modules: [join(repo, 'node_modules')], alias: { '@': repo } },
    module: { parser: { javascript: { dynamicImportMode: 'eager' } }, rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: join(directory, 'loader.cjs') }, { test: /\.css$/, use: join(directory, 'css.cjs') }] } });
  await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
  const globals = await readFile(join(repo, 'app/globals.css'), 'utf8'), variables = globals.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1];
  const css = `:root{${variables ?? ''}}*{box-sizing:border-box}body{margin:16px;background:var(--bg);color:var(--text);font-family:system-ui;font-size:14px}`
    + await readFile(join(repo, 'components/intelligent-ui/IntelligentUiSurface.module.css'), 'utf8')
    + await readFile(join(repo, 'components/intelligent-ui/RichSurfaceLayout.module.css'), 'utf8');
  return { bundle: await readFile(join(directory, 'bundle.js')), css };
}

/** Changes are independent test instructions, never sent as model context. Selectors must match exactly one control. */
export async function runWorkflowProbe({ runtime, model, task, output, timeoutMs = 120_000, protocol = 'plan-2', scope = 'real-provider-sdk-browser-routes' }) {
  if (!['surface', 'plan-1', 'plan-2'].includes(protocol)) throw new Error('Unsupported probe protocol');
  if (!task || typeof task.prompt !== 'string' || !Array.isArray(task.changes) || typeof task.followup !== 'string') throw new Error('Invalid synthetic workflow task');
  const directory = resolve(output);
  await mkdir(directory, { recursive: false }); // Never overwrite or resume an unverified run.
  const agentDir = join(directory, 'agent'), cwd = join(directory, 'workspace');
  await mkdir(agentDir); await mkdir(cwd);
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PIORA_UI_INPUT_PROTOCOL: process.env.PIORA_UI_INPUT_PROTOCOL };
  process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PIORA_UI_INPUT_PROTOCOL = protocol;
  const record = { version: 2, scope, model: `${model.provider}/${model.id}`, protocol,
    createdAt: new Date().toISOString(), task, settings: { thinking: 'low', maxTokens: 6000, maxRetries: 0, timeoutMs },
    outcome: 'running', desktop: 'not-tested', independentReviews: [], events: [], turns: [], browser: { requests: [], errors: [] } };
  const sourceFiles = ['scripts/probe-intelligent-ui-workflow.mjs', 'extensions/piora-intelligent-ui.ts', 'lib/rpc-manager.ts',
    'lib/intelligent-ui/decision-policy.ts', 'lib/intelligent-ui/plan.ts', 'lib/intelligent-ui/plan-schema.ts',
    'lib/intelligent-ui/rich-plan.ts', 'lib/intelligent-ui/rich-plan-schema.ts', 'lib/intelligent-ui/rich-protocol.ts',
    'lib/intelligent-ui/generation-runtime.ts', 'lib/intelligent-ui/generation-journal.ts', 'lib/intelligent-ui/decision-context.ts',
    'lib/answer-output-admission.ts', 'lib/intelligent-ui/plan-admission.ts', 'lib/intelligent-ui/admission.ts', 'lib/intelligent-ui/preview-plan.ts',
    'components/AnswerOutput.tsx', 'components/intelligent-ui/IntelligentUiSurface.tsx', 'components/intelligent-ui/client-state.ts', 'package-lock.json'];
  record.selectedSourceDigests = Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path, hash(await readFile(join(repo, path)))])));
  let wrapper, owned, browser, turnStarted, turnIndex = -1, stage = 'services';
  const originalStream = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (requestedModel, context, options) => {
    record.turns[turnIndex].requests.push({ elapsedMs: performance.now() - turnStarted,
      tools: context.tools?.map(tool => tool.name) ?? [],
      // Inspect visible synthetic context, never reasoning; this text is not authorization.
      uiContext: context.messages.filter(message => message.role === 'user').map(message => typeof message.content === 'string' ? message.content
        : message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
        .filter(text => text.includes('Saved interactive UI parameters') || text.includes('Saved UI generation context')) });
    return originalStream(requestedModel, context, { ...options, maxTokens: 6000, maxRetries: 0, timeoutMs });
  };
  try {
    writeBetaFeatures({ intelligentUi: true }, agentDir);
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const plan = await resolveExtensionLoadPlan({ cwd, agentDir, settingsManager, profile: 'normal', preferences: { version: 1, disabled: [] } });
    plan.enabledPaths = plan.candidates.filter(item => item.id === 'piora:intelligent-ui' && item.enabled).map(item => item.path);
    const services = await createAgentSessionServices({ cwd, agentDir, settingsManager, modelRuntime: runtime, resourceLoaderOptions: {
      additionalExtensionPaths: plan.enabledPaths, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionsOverride: result => applyExtensionLoadPlan(result, plan),
    } });
    owned = createOwnedSessionManager(cwd, join(agentDir, 'sessions'), agentDir);
    const toolName = protocol === 'surface' ? 'piora_render_ui' : 'piora_render_ui_plan';
    const { session } = await createAgentSessionFromServices({ services, sessionManager: owned.manager, model, thinkingLevel: 'low', tools: [toolName] });
    session.setAutoRetryEnabled(false); session.setAutoCompactionEnabled(false);
    wrapper = new AgentSessionWrapper(session, 'normal', { ownedSessionManager: owned, toolNameCeiling: [toolName] });
    wrapper.initializeSessionCapabilities(); wrapper.start(); wrapper.beginExtensionBinding(); await wrapper.waitUntilReady();
    const id = wrapper.sessionId, file = wrapper.sessionFile;
    (globalThis.__piSessions ??= new Map()).set(id, wrapper); cacheSessionPath(id, file); writeToolPermission(id, 'full', agentDir);
    record.sessionId = id;
    wrapper.onEvent(event => {
      if (['prompt_started', 'prompt_done', 'prompt_error', 'tool_execution_start', 'tool_execution_end', 'answer_output_preview'].includes(event.type)) {
        record.events.push({ type: event.type, turnIndex, elapsedMs: performance.now() - (turnStarted ?? performance.now()),
          ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}), ...(event.toolName ? { toolName: event.toolName } : {}),
          ...(event.type === 'tool_execution_end' ? { isError: event.isError, diagnostic: event.result?.details?.intelligentUiDiagnostic } : {}),
          ...(event.preview ? { phase: event.preview.phase, nodeCount: event.preview.payload?.nodes?.length ?? 0 } : {}) });
      }
    });
    async function prompt(text) {
      turnIndex++; turnStarted = performance.now();
      const turn = { user: text, requests: [], assistant: '' }; record.turns.push(turn);
      const before = session.sessionManager.getEntries().length;
      await wrapper.send({ type: 'prompt', source: 'ui', message: text });
      try { await waitUntil(() => !wrapper.isRunning() && !wrapper.getActivePromptRunId(), timeoutMs, 'model turn'); }
      catch (error) { await wrapper.send({ type: 'abort' }); await waitUntil(() => !wrapper.isRunning(), 15000, 'cancel transport'); throw error; }
      turn.durationMs = performance.now() - turnStarted;
      const entries = session.sessionManager.getEntries().slice(before);
      turn.assistant = entries.filter(entry => entry.type === 'message' && entry.message.role === 'assistant')
        .flatMap(entry => entry.message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n');
      turn.terminal = entries.filter(entry => entry.type === 'message' && entry.message.role === 'assistant').at(-1)?.message.stopReason;
      turn.toolResults = entries.filter(entry => entry.type === 'message' && entry.message.role === 'toolResult')
        .map(entry => ({ entryId: entry.id, toolCallId: entry.message.toolCallId, isError: entry.message.isError, diagnostic: entry.message.details?.intelligentUiDiagnostic }));
      return entries;
    }
    stage = 'initial-generation'; await prompt(task.prompt);
    if (record.turns[0].terminal !== 'stop') { record.outcome = 'model-turn-incomplete'; return record; }
    const resultEntry = session.sessionManager.getBranch().filter(entry => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.details?.answerOutput).at(-1);
    if (!resultEntry) { record.outcome = 'no-ui-result'; return record; }
    const result = resultEntry.message, toolCallId = result.toolCallId;
    const initial = await readUiOutput(session.sessionManager, toolCallId, { root: agentDir });
    record.initial = { ...values(initial), surface: initial.surface, publication: initial.publication };
    if (protocol !== 'surface' && initial.publication?.status !== 'committed') { record.outcome = 'not-committed'; return record; }
    stage = 'browser'; const { bundle, css } = await browserBundle(join(directory, 'browser'));
    record.browser.bundleSha256 = hash(bundle);
    browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chromium', headless: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    page.setDefaultTimeout(10_000);
    page.on('pageerror', error => record.browser.errors.push(error.message));
    await page.route('http://localhost/**', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
      if (url.pathname === '/api/beta-features') return route.fulfill({ json: { intelligentUi: true } });
      if (url.pathname.startsWith('/api/')) {
        const apiRequest = new Request(request.url(), { method: request.method(), headers: { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json' },
          ...(request.method() === 'GET' ? {} : { body: request.postData() }) });
        const handler = url.pathname.endsWith('/actions') ? actionRoute[request.method()] : url.pathname.endsWith('/intelligent-ui') ? stateRoute[request.method()] : undefined;
        const response = handler ? await handler(apiRequest, { params: Promise.resolve({ id }) }) : Response.json({ error: 'Unexpected route' }, { status: 404 });
        record.browser.requests.push({ method: request.method(), path: url.pathname, status: response.status });
        return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
      }
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><style>${css}</style><div id="root"></div><script>window.sessionId=${JSON.stringify(id)}</script><script src="/bundle.js"></script>` });
    });
    async function mount() {
      await page.goto('http://localhost/'); await page.waitForFunction(() => !!window.showUi);
      await page.evaluate(value => window.showUi(value), result);
      await page.getByText('已保存 · 后续追问可读取当前参数', { exact: true }).waitFor();
    }
    await mount();
    record.browser.initialText = await page.locator('body').innerText();
    record.browser.initialControls = await browserControls(page, initial.surface);
    if (!sameControls(record.browser.initialControls, initial.state)) throw new Error('Browser change initial controls do not match published state');
    await page.screenshot({ path: join(directory, 'initial.png'), fullPage: true });
    record.changes = [];
    for (const change of task.changes) {
      const controls = initial.surface.nodes.filter(node => ['number', 'slider', 'select', 'checkbox'].includes(node.type)
        && new RegExp(change.label, 'i').test(node.label));
      if (controls.length !== 1) throw new Error(`Control selector did not match exactly one input: ${change.label}`);
      const control = controls[0];
      const options = control.type === 'select' && change.optionLabel ? control.options.filter(option => new RegExp(change.optionLabel).test(option)) : null;
      if (options && options.length !== 1) throw new Error('Control selector did not match exactly one option');
      const requestedValue = options ? options[0] : change.value;
      await changeControl(page, control, requestedValue);
      await page.evaluate(() => window.flushUi());
      const saved = await readUiOutput(session.sessionManager, toolCallId, { root: agentDir });
      if (saved.state[control.id] !== requestedValue) throw new Error('Browser change was not acknowledged on disk');
      const observedControls = await browserControls(page, initial.surface);
      if (!sameControls(observedControls, saved.state)) throw new Error('Browser change controls do not match acknowledged disk state');
      record.changes.push({ inputId: control.id, requestedValue, ...values(saved), observedControls, browserText: await page.locator('body').innerText(), browserTables: await page.locator('table').allInnerTexts() });
    }
    const beforeReload = await readUiOutput(session.sessionManager, toolCallId, { root: agentDir });
    await page.screenshot({ path: join(directory, 'changed.png'), fullPage: true });
    await mount();
    const reloaded = await readUiOutput(session.sessionManager, toolCallId, { root: agentDir });
    const observedControls = await browserControls(page, initial.surface);
    record.reload = { ...values(reloaded), browserText: await page.locator('body').innerText(), browserTables: await page.locator('table').allInnerTexts(),
      observedControls, matchesSavedState: sameControls(beforeReload.state, reloaded.state) && beforeReload.revision === reloaded.revision,
      matchesBrowserControls: sameControls(observedControls, reloaded.state) };
    if (!record.reload.matchesSavedState || !record.reload.matchesBrowserControls) throw new Error('Browser change reload did not restore acknowledged controls');
    stage = 'followup'; await prompt(task.followup);
    record.final = values(await readUiOutput(session.sessionManager, toolCallId, { root: agentDir }));
    record.disk = { sessionSha256: hash(await readFile(file)), journalSha256: existsSync(generationJournalPath(id, agentDir)) ? hash(readFileSync(generationJournalPath(id, agentDir))) : null };
    record.outcome = record.turns.at(-1).terminal !== 'stop' ? 'model-turn-incomplete' : record.browser.errors.length ? 'browser-errors' : 'workflow-completed';
    return record;
  } catch (error) {
    record.outcome = 'failed'; record.failedStage = stage;
    record.error = error instanceof Error && /^(Control selector|Browser change|Probe timed out)/.test(error.message) ? error.message.slice(0, 800) : 'Workflow probe failed';
    return record;
  } finally {
    await browser?.close();
    if (wrapper) {
      await wrapper.shutdownForFileMutation(); globalThis.__piSessions?.delete(wrapper.sessionId); invalidateSessionPathCache(wrapper.sessionId);
    } else owned?.release();
    runtime.streamSimple = originalStream;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    // Reports contain synthetic text and outputs, never model thinking or raw provider errors.
    await writeFile(join(directory, 'result.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  }
}

async function main() {
  const args = process.argv.slice(2), options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!['--model', '--task', '--output', '--protocol'].includes(args[index]) || !args[index + 1]) throw new Error('Use --model provider/id --task task.json --output new-directory [--protocol plan-2]');
    options[args[index]] = args[index + 1];
  }
  if (!options['--model']?.includes('/') || !options['--task'] || !options['--output']) throw new Error('Missing model, task or output');
  const output = resolve(options['--output']);
  try { await access(output); throw new Error('Output exists; use a new directory'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(dirname(output), { recursive: true });
  const userAgentDir = getAgentDir();
  const runtime = await ModelRuntime.create({ authPath: join(userAgentDir, 'auth.json'), modelsPath: join(userAgentDir, 'models.json'), allowModelNetwork: false });
  const slash = options['--model'].indexOf('/'), model = runtime.getModel(options['--model'].slice(0, slash), options['--model'].slice(slash + 1));
  if (!model) throw new Error('Requested model is not configured');
  const task = JSON.parse(await readFile(resolve(options['--task']), 'utf8'));
  const result = await runWorkflowProbe({ runtime, model, task, output, protocol: options['--protocol'] ?? 'plan-2' });
  console.log(JSON.stringify({ output: join(output, 'result.json'), model: result.model, outcome: result.outcome, turns: result.turns.length,
    attempts: result.events.filter(event => event.type === 'tool_execution_start').length, browserErrors: result.browser.errors.length }));
  process.exitCode = result.outcome === 'workflow-completed' ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
