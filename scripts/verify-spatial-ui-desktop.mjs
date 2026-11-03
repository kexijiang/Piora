import assert from 'node:assert/strict';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { getAgentDir, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createJiti } from 'jiti';
import { runDesktopScenario } from './desktop-e2e/harness.mjs';
import { startRealModelProxy } from './desktop-e2e/real-model-proxy.mjs';
import { evaluationSources } from './mini-app-evaluation-data.mjs';
import { worldPoint, projectPoint, checkSpatialExpectations } from './desktop-e2e/spatial-oracle.mjs';
import { spatialRequestPhase } from './desktop-e2e/spatial-request.mjs';

const root = process.cwd(), cancellation = new AbortController();
const { SESSION_TITLE_PROMPT } = await createJiti(import.meta.url).import('../lib/session-title-prompt.ts');
const args = process.argv.slice(2), recordingRoot = args.includes('--recording') ? resolve(args[args.indexOf('--recording') + 1]) : undefined;
const bindingPath = args.includes('--bindings') ? resolve(args[args.indexOf('--bindings') + 1]) : undefined;
const bindings = bindingPath ? JSON.parse(await readFile(bindingPath, 'utf8')) : undefined;
if (bindings) { assert.equal(bindings.version, 1); assert.ok(recordingRoot, 'Audits bind an unchanged recorded program'); assert.ok(bindings.steps?.length); }
let recording;
if (recordingRoot) {
  const files = (await readdir(join(recordingRoot, 'agent/piora/mini-app'))).filter(file => /^[a-f0-9]{64}\.json$/.test(file));
  assert.equal(files.length, 1, 'Replay requires exactly one recorded mini-app journal');
  const path = join(recordingRoot, 'agent/piora/mini-app', files[0]), bytes = await readFile(path), journal = JSON.parse(bytes);
  const committed = journal.records.filter(record => record.status === 'committed'); assert.equal(committed.length, 1, 'Replay requires one committed original program');
  recording = { root: recordingRoot, path, sha256: createHash('sha256').update(bytes).digest('hex'), sessionId: journal.sessionId, toolCallId: committed[0].toolCallId, entryId: committed[0].call.id };
}
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => cancellation.abort(new Error(`Interrupted by ${event}`)));
const agent = getAgentDir(), runtime = await ModelRuntime.create({ authPath: join(agent, 'auth.json'), modelsPath: join(agent, 'models.json'), allowModelNetwork: false });
const model = runtime.getModel('deepseek', 'deepseek-flash');
assert.ok(model && /V4\.1/.test(model.name) && runtime.hasConfiguredAuth('deepseek'), 'Configured DeepSeek V4.1 Flash is required; no fallback');
const promptFile = args.includes('--prompt-file') ? args[args.indexOf('--prompt-file') + 1] : undefined;
const prompt = promptFile ? (await readFile(resolve(promptFile), 'utf8')).trim() : '飞机的俯仰、偏航和横滚我总分不清。让我转一转飞机看看区别，也想点选飞机或坐标轴，换个视角观察。' + (args.includes('--presets') ? '也让我能一键把角度归零。' : '');
assert.ok(prompt, 'A nonempty development task is required');
const followupFile = args.includes('--followup-file') ? args[args.indexOf('--followup-file') + 1] : undefined;
const followup = followupFile ? (await readFile(resolve(followupFile), 'utf8')).trim() : '先别生成新界面，解释一下我现在选中的对象、改过的角度，以及换视角和改变飞机姿态有什么区别。';
assert.ok(followup, 'A nonempty follow-up is required');
const requests = [], responses = [], environments = [], checkpoints = [], runtimeFindings = [], audits = [];
let directory, phase = 'generation', sources;
const textParts = message => typeof message.content === 'string' ? [message.content] : (message.content ?? []).filter(block => block.type === 'text').map(block => block.text);
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const persist = () => writeFile(join(directory, 'spatial-task.json'), JSON.stringify({ prompt, followup, configuredModel: { provider: model.provider, id: model.id, name: model.name },
  scope: 'One natural-language development sample on the actual Windows development desktop; operations and reload through UI, APIs only inspect results. No sealed-set or independent human semantic acceptance.',
  recording, sources, bindings, requests, responses, environments, checkpoints, runtimeFindings, audits }, null, 2) + '\n');

const scenario = {
  id: 'spatial-ui-live-model', mode: recording ? 'recorded-generation-with-live-model-followup' : 'real-model',
  scope: recording ? 'Original committed spatial program copied to an isolated real desktop, with UI operations and real-model follow-up; not fresh generation' : 'Real Electron/Next/SDK generation with an origin-bound WebGL probe, production scene runtime, saved state and real-model follow-up',
  coverage: ['natural request', 'window preflight and model capability context', 'scene selection and camera controls', 'parameter edit', 'save and reload', 'confirmed spatial state in follow-up'],
  limits: ['all spatial tasks and generation stability', bindings ? 'geometry outside the explicitly bound poses and independent explanation acceptance' : 'independent geometry and explanation correctness', 'other GPUs and platforms', 'native hide/recovery matrix', 'release packages', 'two-human acceptance'],
  async prepare(context) {
    directory = context.directory;
    context.report.credentials = 'in-memory relay from configured DeepSeek authentication; retained profile contains only a disposable local relay token';
    if (recording) {
      await cp(join(recording.root, 'agent/sessions'), join(context.paths.agent, 'sessions'), { recursive: true, force: false, errorOnExist: true });
      await mkdir(join(context.paths.agent, 'piora'), { recursive: true });
      await cp(join(recording.root, 'agent/piora/mini-app'), join(context.paths.agent, 'piora/mini-app'), { recursive: true, force: false, errorOnExist: true });
      context.report.recording = recording;
    }
    const relay = await startRealModelProxy({ runtime, model, signal: context.signal, registerCleanup: context.registerCleanup,
      onRequest: async ({ id, body }) => {
        const texts = (body.messages ?? []).flatMap(textParts);
        const purpose = spatialRequestPhase(body, { phase, prompt, followup, titleInstruction: SESSION_TITLE_PROMPT });
        requests.push({ id, phase: purpose, model: body.model, thinking: body.thinking, maxTokens: body.max_tokens ?? body.max_completion_tokens, context: texts.filter(text => /mini app|Mini app|scene3d|current window/i.test(text)),
          titleInstructionPresent: texts.some(text => text.includes(SESSION_TITLE_PROMPT)),
          requestDigest: createHash('sha256').update(JSON.stringify(body)).digest('hex') }); await persist();
        assert.equal(body.model, 'deepseek-flash');
        if (purpose !== 'background') assert.equal(body.thinking?.type, 'enabled', 'Spatial tasks use the pinned reasoning configuration');
      },
      onResponse: async response => { assert.ok(!(response.modelIds ?? []).some(id => /pro/i.test(id)), 'No Pro response'); responses.push({ ...response, receivedAt: Date.now(), phase: requests.find(request => request.id === response.id)?.phase }); await persist(); },
    });
    await mkdir(join(context.paths.agent, 'piora'), { recursive: true });
    await writeFile(join(context.paths.agent, 'piora', 'beta-features.json'), JSON.stringify({ version: 1, intelligentUi: true }));
    await writeFile(join(context.paths.agent, 'models.json'), JSON.stringify({ providers: { deepseek: { api: model.api, ...relay,
      models: [{ id: model.id, name: model.name, reasoning: model.reasoning, compat: model.compat, input: ['text'], contextWindow: model.contextWindow, maxTokens: Math.min(model.maxTokens, 32768), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    await writeFile(join(context.paths.agent, 'settings.json'), JSON.stringify({ packages: [], extensions: [], skills: [], retry: { enabled: false },
      defaultProvider: model.provider, defaultModel: model.id, enabledModels: [`${model.provider}/${model.id}`], defaultThinkingLevel: 'medium' }));
    sources = await evaluationSources(root);
    sources.runnerSha256 = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
    sources.oracleSha256 = createHash('sha256').update(await readFile(new URL('./desktop-e2e/spatial-oracle.mjs', import.meta.url))).digest('hex');
    sources.requestClassifierSha256 = createHash('sha256').update(await readFile(new URL('./desktop-e2e/spatial-request.mjs', import.meta.url))).digest('hex');
    await persist();
  },
  async run({ page, origin, step, waitUntil, reload, screenshot }) {
    // Model generation has its separate bounded wait. Missing UI controls should
    // fail promptly instead of consuming that entire model-response allowance.
    page.setDefaultTimeout(30_000); page.setDefaultNavigationTimeout(90_000);
    let outputUrl;
    page.on('response', async response => {
      if (/\/api\/mini-app\/environment$/.test(response.url()) && response.request().method() === 'POST') {
        environments.push({ status: response.status(), ...response.request().postDataJSON() }); await persist();
      }
      if (/\/api\/sessions\/[^/]+\/mini-app\?/.test(response.url()) && response.request().method() === 'GET' && response.status() === 200
        && (!recording || new URL(response.url()).searchParams.get('toolCallId') === recording.toolCallId)) outputUrl = response.url();
    });
    const surface = recording ? page.locator(`[data-chat-entry-id="${recording.entryId}"] [data-mini-app-surface]`) : page.locator('[data-mini-app-surface]').first();
    const frame = surface.frameLocator('iframe[title="Interactive answer"]');
    async function revealOriginal() {
      if (!recording) return;
      const scroll = page.locator('#chat-scroll-container');
      for (let attempt = 0; attempt < 60; attempt++) {
        if (await surface.count() && await frame.locator('canvas').count()) return;
        await scroll.hover({ position: { x: 8, y: 8 } }); await page.mouse.wheel(0, -550); await page.waitForTimeout(80);
      }
      assert.fail('Original spatial entry did not mount after bounded UI scrolling');
    }
    async function captureScene(name) {
      await revealOriginal();
      const canvas = frame.locator('canvas'), scroll = page.locator('#chat-scroll-container');
      // Scroll the real chat instead of fighting its virtual-list anchor with
      // an iframe scrollIntoView while the restored transcript settles.
      for (let attempt = 0; attempt < 12; attempt++) {
        const box = await canvas.boundingBox(), area = await scroll.boundingBox(); assert.ok(box && area);
        const offset = box.y + box.height / 2 - area.y - area.height / 2;
        if (Math.abs(offset) < 25) break;
        await scroll.hover({ position: { x: 8, y: 8 } }); await page.mouse.wheel(0, Math.max(-450, Math.min(450, offset))); await page.waitForTimeout(100);
      }
      await screenshot(name);
      await canvas.screenshot({ path: join(directory, name.replace(/\.png$/, '-canvas.png')) });
    }
    async function healthy() {
      for (const name of ['runtime', 'state', 'action']) {
        const code = await surface.getAttribute(`data-mini-app-${name}-error`);
        if (code) { runtimeFindings.push({ name, code, text: await surface.innerText() }); await persist(); }
        assert.ok(!code, `Mini app ${name} failed: ${code}`);
      }
    }
    async function guardedStep(name, work) {
      return step(name, async () => {
        let active = true;
        const watch = async () => {
          while (active) {
            const faults = await surface.evaluateAll(nodes => nodes.flatMap(node => ['runtime', 'state', 'action'].flatMap(kind => {
              const code = node.getAttribute(`data-mini-app-${kind}-error`);
              return code ? [{ name: kind, code, text: node.innerText }] : [];
            }))).catch(error => {
              // A deliberate reload destroys the old document between polls.
              // Resume on the new document; real runtime faults and closed
              // targets still fail, and the surrounding step remains timed.
              if (!page.isClosed() && /Execution context was destroyed, most likely because of a navigation/.test(error.message)) return [];
              throw error;
            });
            if (!active) return;
            if (faults.length) {
              runtimeFindings.push(...faults); await persist();
              throw new Error(`Mini app ${faults[0].name} failed: ${faults[0].code}`);
            }
            await new Promise(done => setTimeout(done, 100));
          }
        };
        try { return await Promise.race([work(), watch()]); }
        finally { active = false; }
      });
    }
    async function send(text) { await page.locator('textarea').first().fill(text); await page.getByRole('button', { name: /^(Send|发送)$/ }).click(); }
    async function readOutput() {
      assert.ok(outputUrl, 'Production output read URL was observed');
      const response = await page.evaluate(async url => { const result = await fetch(url, { cache: 'no-store' }); return { status: result.status, data: await result.json() }; }, outputUrl);
      assert.equal(response.status, 200); return response.data;
    }
    async function save(label) {
      const button = surface.getByRole('button', { name: /^(Save|保存)$/ }); await button.click();
      await waitUntil(async () => { await healthy(); return await button.isEnabled() && await surface.getByText(/^(Saved · ready for your next message|已保存 · 后续追问可读取当前状态)$/).isVisible(); }, 'saved spatial checkpoint');
      const output = await readOutput(); checkpoints.push({ label, output, uiText: await frame.locator('body').innerText() }); await persist(); return output;
    }
    await guardedStep(recording ? 'load-original-program' : 'natural-language-generation', async () => {
      if (recording) {
        await page.goto(`${origin}/?session=${encodeURIComponent(recording.sessionId)}`, { waitUntil: 'domcontentloaded' });
        outputUrl = `${origin}/api/sessions/${encodeURIComponent(recording.sessionId)}/mini-app?toolCallId=${encodeURIComponent(recording.toolCallId)}`;
        await revealOriginal();
        await waitUntil(async () => { if (!await surface.count()) return false; await healthy(); return frame.locator('canvas').isVisible(); }, 'original spatial program');
        const output = await readOutput(); checkpoints.push({ label: 'recorded-original', output }); await persist();
        assert.equal(createHash('sha256').update(await readFile(recording.path)).digest('hex'), recording.sha256, 'Original journal remains unchanged');
        await captureScene('spatial-recorded.png'); return;
      }
      await send(prompt);
      await waitUntil(async () => {
        assert.ok(!responses.some(response => response.status !== 200), 'Real model request failed');
        assert.ok(!responses.some(response => response.phase === 'generation' && response.finishReasons?.includes('length') && !response.tools?.length), 'Generation exhausted its output budget before producing a UI');
        if (!await surface.count()) {
          const last = responses.findLast(response => response.phase === 'generation');
          const settled = last?.finishReasons?.includes('stop') && Date.now() - last.receivedAt > 2000
            && await page.getByRole('button', { name: /^(Send|发送)$/ }).isVisible();
          assert.ok(!settled, 'Model completed without publishing the requested 3D interface');
          return false;
        }
        await healthy(); return frame.locator('canvas').isVisible();
      }, 'generated 3D surface');
      await waitUntil(() => page.getByRole('button', { name: /^(Send|发送)$/ }).isVisible(), 'generation settled');
      assert.ok(environments.some(report => report.action === 'prepare' && report.status === 200 && report.report.webgl), 'Current window actually reported WebGL');
      const output = await readOutput(); checkpoints.push({ label: 'generated', output }); await persist();
      assert.ok(output.plan.viewports.some(view => view.kind === 'scene3d' && view.picking && view.cameraControls), 'Generated plan enables requested spatial controls');
      await captureScene('spatial-generated.png');
    });
    let edited;
    await guardedStep('operate-and-save', async () => {
      const output = checkpoints[0].output, view = output.plan.viewports.find(view => view.kind === 'scene3d');
      const input = output.plan.inputs.find(input => ['number', 'range'].includes(input.type)); assert.ok(input, 'An editable angle is present');
      const previous = output.result.snapshot.inputs[input.id], min = input.min ?? -180, max = input.max ?? 180;
      const value = [45, 0, min, max].map(value => Math.min(max, Math.max(min, value))).find(value => value !== previous);
      assert.notEqual(value, undefined, 'The declared angle permits a different value');
      const control = frame.locator(`[data-input="${input.id}"]`);
      if (await control.getAttribute('type') === 'range') {
        await control.focus(); await page.keyboard.press('Home');
        for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
        if (Number(await control.inputValue()) === previous) await page.keyboard.press('End');
      }
      else { await control.fill(String(value)); await control.press('Tab'); }
      const selector = frame.getByRole('combobox', { name: new RegExp(`^${escapeRegExp(view.label)} · (Select object|选择对象)$`) });
      const oldSelection = output.result.frame.scenes[view.id].selected;
      const options = await selector.locator('option').evaluateAll(options => options.map(option => option.value));
      const optionIndex = bindings?.selection ? options.indexOf(bindings.selection) : options.findIndex(value => value && value !== oldSelection);
      assert.ok(optionIndex > 0, 'Select an explicit bound task object when another object intentionally clears selection');
      const option = options[optionIndex];
      await selector.focus(); await page.keyboard.press('Home');
      for (let i = 0; i < optionIndex; i++) await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await frame.getByRole('button', { name: new RegExp(`^${escapeRegExp(view.label)} · (Rotate right|向右旋转)$`) }).click();
      edited = await save('edited');
      const scene = edited.result.frame.scenes[view.id]; assert.equal(scene.selected, option); assert.ok(edited.result.snapshot.view?.cameras[view.id]);
      assert.notDeepEqual(edited.result.snapshot.inputs, output.result.snapshot.inputs);
      await captureScene('spatial-edited.png');
    });
    if (args.includes('--presets')) await guardedStep('declared-input-presets', async () => {
      assert.ok(edited.plan.inputPresets?.length, 'This fixture requires declared input presets for its angle controls');
      for (const preset of edited.plan.inputPresets) {
        const expected = { ...edited.result.snapshot.inputs, ...preset.values };
        await frame.getByRole('button', { name: preset.label, exact: true }).click();
        edited = await save(`preset:${preset.id}`);
        assert.deepEqual(edited.result.snapshot.inputs, expected, 'Preset updates only its declared input values');
        for (const [id, value] of Object.entries(preset.values)) {
          const control = frame.locator(`[data-input="${id}"]`);
          if (typeof value === 'boolean') assert.equal(await control.isChecked(), value);
          else assert.equal(await control.inputValue(), String(value));
        }
      }
      // Some legitimate input handlers reset task selection. Make a new native
      // selection so the following checkpoint-context assertion is meaningful.
      const view = edited.plan.viewports.find(view => view.kind === 'scene3d');
      if (!edited.result.frame.scenes[view.id].selected) {
        const selector = frame.getByRole('combobox', { name: new RegExp(`^${escapeRegExp(view.label)} · (Select object|选择对象)$`) });
        await selector.focus(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
        edited = await save('preset-selection'); assert.ok(edited.result.frame.scenes[view.id].selected);
      }
      await captureScene('spatial-presets.png');
    });
    if (bindings) {
      assert.equal(edited.publication.planDigest, bindings.planDigest, 'Audit binds the exact original plan');
      const view = edited.plan.viewports.find(view => view.id === bindings.viewport);
      assert.ok(view?.kind === 'scene3d');
      for (const pose of bindings.steps) await guardedStep(`geometry:${pose.name}`, async () => {
        const before = edited.result.snapshot;
        for (const [id, value] of Object.entries(pose.inputs ?? {})) {
          const input = edited.plan.inputs.find(input => input.id === id); assert.ok(input && ['number', 'range'].includes(input.type));
          const control = frame.locator(`[data-input="${id}"]`);
          if (await control.getAttribute('type') === 'range') {
            const choices = [{ from: Number(await control.inputValue()) }, { from: input.min, start: 'Home' }, { from: input.max, start: 'End' }]
              .map(choice => ({ ...choice, presses: Math.abs(value - choice.from) / input.step })).sort((a,b) => a.presses - b.presses);
            const choice = choices[0];
            assert.ok(Number.isInteger(choice.presses) && choice.presses <= 1000 && value >= input.min && value <= input.max, 'Bounded native slider sequence');
            await control.focus(); if (choice.start) await control.press(choice.start);
            for (let i = 0; i < choice.presses; i++) await control.press(value > choice.from ? 'ArrowRight' : 'ArrowLeft');
          } else { await control.fill(String(value)); await control.press('Tab'); }
        }
        edited = await save(`pose:${pose.name}`);
        for (const [id, value] of Object.entries(pose.inputs ?? {})) assert.equal(edited.result.snapshot.inputs[id], value);
        assert.deepEqual(edited.result.snapshot.view, before.view, 'Editing posture preserves the user camera');
        const scene = edited.result.frame.scenes[view.id], checks = checkSpatialExpectations(scene, pose);
        const audit = { name: pose.name, checks, meshCount: scene.meshes.length, groupCount: scene.groups?.length ?? 0 };
        audits.push(audit); await persist();
        assert.ok(checks.every(check => check.passed), JSON.stringify(checks.filter(check => !check.passed)));
        if (pose.pick) {
          const world = worldPoint(scene, pose.pick.object, pose.pick.local);
          const camera = edited.result.snapshot.view?.cameras[view.id]?.camera ?? scene.camera;
          const pixel = projectPoint(camera, world, view.width, view.height);
          const canvas = frame.getByRole('img', { name: view.label, exact: true });
          await canvas.scrollIntoViewIfNeeded(); const box = await canvas.boundingBox(); assert.ok(box);
          await canvas.click({ position: { x: pixel.x * box.width / view.width, y: pixel.y * box.height / view.height } });
          edited = await save(`pick:${pose.name}`);
          audit.pick = { world, pixel, expected: pose.pick.selected ?? pose.pick.object, actual: edited.result.frame.scenes[view.id].selected };
          await persist(); assert.equal(audit.pick.actual, audit.pick.expected, 'Independent projection hits the intended object');
        }
        if (pose.cameraKeys) {
          const previous = edited.result.snapshot;
          const canvas = frame.getByRole('img', { name: view.label, exact: true }); await canvas.focus();
          for (const key of pose.cameraKeys) { assert.ok(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','-','Home'].includes(key)); await canvas.press(key); }
          edited = await save(`camera:${pose.name}`);
          assert.deepEqual(edited.result.snapshot.inputs, previous.inputs, 'Camera controls preserve task parameters');
          assert.deepEqual(edited.result.snapshot.state, previous.state, 'Camera controls preserve task state and selection');
          assert.notDeepEqual(edited.result.snapshot.view, previous.view, 'Camera keys actually change the view');
          audit.cameraIndependent = true; await persist();
        }
        await captureScene(`spatial-audit-${audits.length}.png`);
      });
    }
    await guardedStep('reload-and-explain', async () => {
      await reload(); await revealOriginal(); await waitUntil(() => frame.locator('canvas').isVisible(), 'restored scene'); await healthy();
      const restored = await readOutput(); assert.deepEqual(restored.result.snapshot, edited.result.snapshot);
      const view = restored.plan.viewports.find(view => view.kind === 'scene3d');
      assert.equal(await frame.getByRole('combobox', { name: new RegExp(`^${escapeRegExp(view.label)} · (Select object|选择对象)$`) }).inputValue(), restored.result.frame.scenes[view.id].selected);
      await captureScene('spatial-restored.png'); phase = 'followup'; await send(followup);
      await waitUntil(() => responses.some(response => response.phase === 'followup' && response.text), 'real spatial follow-up');
      await waitUntil(() => page.getByRole('button', { name: /^(Send|发送)$/ }).isVisible(), 'follow-up settled');
      const replies = responses.filter(response => response.phase === 'followup');
      if (args.includes('--inspect-inputs')) {
        const names = replies.flatMap(response => (response.tools ?? []).map(tool => tool.function?.name).filter(Boolean));
        assert.ok(names.length && names.every(name => name === 'piora_inspect_mini_app'), 'Parameter questions use only the declared read-only inspection tool');
        assert.ok(replies.every(response => response.status === 200));
        const observations = requests.filter(request => request.phase === 'followup').flatMap(request => request.context)
          .filter(text => text.startsWith('Read-only mini app input observations'))
          .map(text => JSON.parse(text.slice(text.indexOf('\n') + 1)));
        assert.ok(observations.length, 'Real model receives input inspection evidence');
        for (const observation of observations) {
          assert.equal(observation.appId, restored.plan.id);
          assert.equal(observation.source.stateRevision, restored.stateRevision);
          assert.equal(observation.sourceCheckpointDigest, restored.checkpointDigest);
          assert.equal(observation.scope, 'independent-single-input-events');
        }
        assert.ok(bindings?.inspectionCases?.length, 'Requested numerical comparisons need independent expectations');
        for (const expected of bindings.inspectionCases) {
          const actual = observations.flatMap(item => item.cases).find(item => item.inputId === expected.inputId && item.value === expected.value);
          assert.ok(actual, 'The requested parameter value was actually inspected');
          for (const [id, text] of Object.entries(expected.projectionText)) assert.equal(actual.projectionText.values.find(item => item.id === id)?.text, text);
        }
        const after = await readOutput();
        assert.deepEqual(after.result.snapshot, restored.result.snapshot, 'Inspection cannot apply hypothetical inputs or state');
        assert.equal(after.stateRevision, restored.stateRevision, 'Inspection cannot create a saved revision');
      } else assert.ok(replies.every(response => response.status === 200 && !response.tools?.length), 'Follow-up answers directly');
      const saved = requests.filter(request => request.phase === 'followup').flatMap(request => request.context).filter(text => text.startsWith('Saved mini app parameters and host publication results')).map(text => JSON.parse(text.slice(text.indexOf('\n') + 1)));
      assert.ok(saved.some(context => context.apps.some(app => app.id === restored.plan.id && app.scenes?.some(scene => scene.selected?.id === restored.result.frame.scenes[view.id].selected && scene.cameraSource === 'saved-user-view'))), 'Real follow-up receives confirmed object selection and user camera');
      const app = saved.flatMap(context => context.apps).find(app => app.id === restored.plan.id);
      assert.ok(app?.projectionText?.values.length, 'Real follow-up receives current projected text values');
      for (const value of app.projectionText.values) assert.equal(value.text, String(restored.result.frame.bindings[value.id]), 'Projection values match the confirmed frame');
      assert.ok(app?.saveHistory?.transitions.length, 'Real follow-up receives host-confirmed saved comparisons');
      assert.equal(app.saveHistory.eventHistory, 'unavailable', 'Saved comparisons cannot claim to be click history');
      assert.equal(app.saveHistory.transitions.at(-1).toRevision, restored.stateRevision, 'Evidence ends at the confirmed current checkpoint');
      assert.ok(app.saveHistory.transitions.some(transition => transition.changes.items.some(change => change.path.startsWith('/inputs/'))), 'Retained comparisons include actual parameter edits');
      const contextScene = app.scenes.find(scene => scene.id === view.id), camera = restored.result.snapshot.view.cameras[view.id].camera;
      assert.ok(Math.abs(contextScene.cameraMetrics.distanceToTarget - Math.hypot(...camera.position.map((n,i) => n - camera.target[i]))) < 1e-9, 'Distance refers to the camera target, not horizontal radius');
      assert.ok(responses.every(response => response.status === 200 || response.cancelled), 'Non-cancelled model relay failures must not be hidden by successful UI steps');
      await screenshot('spatial-followup.png'); await persist();
    });
  },
};
const result = await runDesktopScenario({ root, scenario, signal: cancellation.signal, timeoutMs: 1_200_000, stepTimeoutMs: 480_000 });
assert.equal((await evaluationSources(root)).sha256, sources.sha256, 'Task sources must stay frozen during the run');
assert.equal(createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'), sources.runnerSha256, 'Runner must stay frozen during the run');
assert.equal(createHash('sha256').update(await readFile(new URL('./desktop-e2e/spatial-oracle.mjs', import.meta.url))).digest('hex'), sources.oracleSha256, 'Oracle must stay frozen during the run');
assert.equal(createHash('sha256').update(await readFile(new URL('./desktop-e2e/spatial-request.mjs', import.meta.url))).digest('hex'), sources.requestClassifierSha256, 'Request classifier must stay frozen during the run');
console.log(JSON.stringify({ directory: result.directory, status: result.report.status, error: result.report.error, cleanupErrors: result.report.cleanupErrors }));
if (result.report.status !== 'passed') process.exitCode = 1;
