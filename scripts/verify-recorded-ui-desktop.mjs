import assert from 'node:assert/strict';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { getAgentDir, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { runDesktopScenario } from './desktop-e2e/harness.mjs';
import { startRealModelProxy } from './desktop-e2e/real-model-proxy.mjs';

const root = process.cwd();
const cancellation = new AbortController();
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => cancellation.abort(new Error(`Interrupted by ${event}`)));
const args = process.argv.slice(2), batchArgument = args[args.indexOf('--batch') + 1];
assert.ok(args.includes('--batch') && batchArgument, 'Explicit --batch <original evaluation result.json> is required');
const batchPath = resolve(batchArgument), batch = JSON.parse(await readFile(batchPath, 'utf8'));
const selected = args.includes('--cases') ? args[args.indexOf('--cases') + 1].split(',') : undefined;
const slots = batch.slots.filter(slot => selected ? selected.includes(slot.id) : ['outing', 'discount', 'sorting', 'shopping-list'].includes(slot.taskId));
assert.ok(slots.length && slots.every(slot => slot.status === 'completed' && slot.result), 'Every selected recording must exist');
const samples = await Promise.all(slots.map(async slot => {
  const source = resolve(slot.result), bytes = await readFile(source), original = JSON.parse(bytes);
  return { ...slot, source, original, digest: createHash('sha256').update(bytes).digest('hex') };
}));
const userAgent = getAgentDir(), runtime = await ModelRuntime.create({ authPath: join(userAgent, 'auth.json'), modelsPath: join(userAgent, 'models.json'), allowModelNetwork: false });
const model = runtime.getModel('deepseek', 'deepseek-flash');
assert.ok(model && /V4\.1/.test(model.name) && runtime.hasConfiguredAuth('deepseek'), 'Configured DeepSeek V4.1 Flash is required; no fallback');
const rows = [], requests = [], responses = [];
let directory, currentCase, currentPrompt;
const persist = () => writeFile(join(directory, 'recorded-tasks.json'), JSON.stringify({ batch: batchArgument,
  scope: 'Original model outputs replayed on current Windows development desktop; new real-model follow-ups. Not a new end-to-end generation batch.',
  configuredModel: { provider: model.provider, id: model.id, name: model.name }, rows, requests, responses }, null, 2) + '\n');
const textParts = message => typeof message.content === 'string' ? [message.content] : (message.content ?? []).filter(block => block.type === 'text').map(block => block.text);
const sortedStates = [[2,6,5,1], [2,5,6,1], [2,5,1,6], [2,5,1,6], [2,1,5,6], [1,2,5,6]];
const swaps = [1,2,3,3,4,5];
const metricIds = {
  'outing-1': ['totalA', 'totalB'], 'outing-2': ['totalAMetric', 'totalBMetric'], 'outing-3': ['totalAMetric', 'totalBMetric'],
  'discount-1': ['totalMetric', 'perCupMetric'], 'discount-2': ['payableView', 'avgView'], 'discount-3': ['payView', 'avgView'],
};

const scenario = {
  id: 'recorded-intelligent-ui', mode: 'recorded-generation-with-live-model-followup',
  scope: 'Original task sessions and publication files copied into an isolated real Electron/Next profile; all task operations via UI',
  coverage: ['natural-task component input trajectories', 'sorting native and host step, playback and terminal state', 'saved disk snapshot', 'reload and continuation', 'real DeepSeek Flash follow-up from current state'],
  limits: ['new generation quality', 'other task families', 'complete recovery matrix', 'human acceptance', 'other platforms and release packages'],
  async prepare(context) {
    directory = context.directory;
    context.report.credentials = 'in-memory relay from configured DeepSeek authentication; retained profile has only a disposable local relay token';
    context.report.recordings = samples.map(sample => ({ id: sample.id, source: sample.result, sha256: sample.digest }));
    for (const sample of samples) {
      const agent = join(dirname(sample.source), 'agent');
      await cp(join(agent, 'sessions'), join(context.paths.agent, 'sessions'), { recursive: true, force: false, errorOnExist: true });
      for (const subsystem of ['intelligent-ui', 'mini-app']) {
        await mkdir(join(context.paths.agent, 'piora', subsystem), { recursive: true });
        for (const file of await readdir(join(agent, 'piora', subsystem))) {
          if (file.endsWith('.json')) await cp(join(agent, 'piora', subsystem, file), join(context.paths.agent, 'piora', subsystem, file), { force: false, errorOnExist: true });
        }
      }
    }
    await writeFile(join(context.paths.agent, 'piora', 'beta-features.json'), JSON.stringify({ version: 1, intelligentUi: true }));
    const relay = await startRealModelProxy({ runtime, model, signal: context.signal, registerCleanup: context.registerCleanup,
      onRequest: async ({ id, body }) => {
        const texts = (body.messages ?? []).flatMap(textParts);
        const purpose = currentPrompt && texts.includes(currentPrompt) ? 'follow-up' : 'background';
        requests.push({ id, caseId: currentCase, purpose, prompt: purpose === 'follow-up' ? currentPrompt : null, model: body.model, at: new Date().toISOString(),
          savedContext: texts.filter(text => /^Saved (?:interactive UI|mini app) parameters and host publication results/.test(text)),
          requestDigest: createHash('sha256').update(JSON.stringify(body)).digest('hex') });
        await persist();
      },
      onResponse: async response => { const request = requests.find(request => request.id === response.id);
        responses.push({ ...response, caseId: request?.caseId, purpose: request?.purpose }); await persist(); },
    });
    await writeFile(join(context.paths.agent, 'models.json'), JSON.stringify({ providers: { deepseek: {
      api: model.api, ...relay, models: [{ id: model.id, name: model.name, reasoning: false, input: ['text'], contextWindow: model.contextWindow,
        maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    await writeFile(join(context.paths.agent, 'settings.json'), JSON.stringify({ packages: [], extensions: [], skills: [], retry: { enabled: false },
      defaultProvider: model.provider, defaultModel: model.id, enabledModels: [`${model.provider}/${model.id}`], defaultThinkingLevel: 'off' }));
    await persist();
  },
  async run({ page, origin, step, waitUntil, reload, screenshot }) {
    page.on('response', async response => {
      if (!/\/api\/sessions\/[^/]+\/mini-app(?:\?|$)/.test(response.url()) || response.status() < 400) return;
      const sample = samples.find(sample => response.url().includes(`/sessions/${sample.original.sessionId}/`));
      const row = rows.find(row => row.id === sample?.id); if (!row) return;
      (row.apiErrors ??= []).push({ status: response.status(), body: await response.json().catch(() => ({ error: 'Non-JSON error' })) });
      await persist();
    });
    async function healthy(surface) {
      if (!await surface.count()) return;
      const runtime = await surface.getAttribute('data-mini-app-runtime-error'), state = await surface.getAttribute('data-mini-app-state-error'), action = await surface.getAttribute('data-mini-app-action-error');
      assert.ok(!runtime && !state && !action, `Mini app failed: runtime=${runtime}, state=${state}, action=${action}`);
    }
    // Read through the real renderer so Electron supplies its same-origin authentication.
    // APIRequestContext is outside that authenticated window and is correctly rejected.
    const api = async url => {
      const response = await page.evaluate(async path => {
        const result = await fetch(path, { cache: 'no-store' }); return { status: result.status, data: await result.json() };
      }, url);
      assert.equal(response.status, 200); return response.data;
    };
    async function explain(sample, prompt, row) {
      const before = responses.length;
      currentPrompt = prompt;
      await page.locator('textarea').first().fill(prompt);
      await page.getByRole('button', { name: /^(Send|发送)$/ }).click();
      const followups = () => responses.slice(before).filter(response => response.caseId === sample.id && response.purpose === 'follow-up');
      await waitUntil(() => {
        const attempts = followups();
        assert.ok(!attempts.some(response => response.status !== 200), 'Real follow-up provider failed; inspect retained status');
        return attempts.some(response => response.text);
      }, 'real model follow-up response');
      await waitUntil(() => page.getByRole('button', { name: /^(Send|发送)$/ }).isVisible(), 'follow-up completed in desktop');
      const answer = followups().map(response => response.text ?? '').join('\n');
      assert.ok(followups().every(response => !response.tools?.length), 'Explanation must not generate another UI or call unrelated tools');
      const taskRequests = requests.filter(request => request.caseId === sample.id && request.purpose === 'follow-up');
      const contexts = taskRequests.flatMap(request => request.savedContext).map(text => JSON.parse(text.slice(text.indexOf('\n') + 1)));
      if (sample.taskId === 'sorting' || sample.taskId === 'shopping-list') {
        const saved = row.checkpoints.at(-1).saved, id = saved.plan.id;
        assert.ok(contexts.some(context => context.apps?.some(app => app.id === id && !Object.hasOwn(app,'tick') && app.runtimeMetadata?.tick === saved.result.snapshot.tick && app.runtimeMetadata?.playbackMode === (saved.plan.playback?.mode ?? 'legacy') && app.summary === saved.result.frame.summary.slice(0, 2000))), 'Actual follow-up contains the latest saved mini-app summary and separately labelled host clock');
        if (sample.taskId === 'shopping-list') {
          const [listId, savedRows] = Object.entries(saved.result.frame.repeats)[0];
          assert.ok(contexts.some(context => context.apps?.some(app => app.id === id && app.lists?.some(list => list.id === listId && list.omittedRows === 0 && JSON.stringify(list.rows.map(({key,bindings})=>({key,bindings}))) === JSON.stringify(savedRows)))), 'Actual follow-up contains current row values and order');
        }
      } else {
        const input = sample.original.components[0].surface.nodes.find(node => ['number', 'slider'].includes(node.type));
        assert.ok(contexts.some(context => context.surfaces?.some(surface => surface.surfaceId === sample.original.components[0].surface.id && surface.controls[input.id] === row.checkpoints.at(-1).input)), 'Actual follow-up contains the selected component parameter');
      }
      row.followup = { prompt, answer, semanticReview: 'pending-independent-review', requestIds: taskRequests.map(request => request.id) };
      currentPrompt = undefined;
      await screenshot(`${sample.id}-followup.png`);
    }
    for (const sample of samples) {
      currentCase = sample.id;
      currentPrompt = undefined;
      const row = { id: sample.id, source: sample.result, status: 'running', checkpoints: [], findings: [] }; rows.push(row); await persist();
      try {
        await step(sample.id, async () => {
          await page.goto(`${origin}/?session=${encodeURIComponent(sample.original.sessionId)}`, { waitUntil: 'domcontentloaded' });
          if (sample.taskId === 'shopping-list') {
            const original = sample.original.journal.records.find(record => record.status === 'committed');
            assert.ok(original, 'Shopping list must have a committed generated mini app');
            const [listId, initialRows] = Object.entries(original.initial.frame.repeats)[0];
            assert.equal(initialRows.length,3);
            const titleField=Object.keys(initialRows[0].bindings).find(id=>initialRows[0].bindings[id]==='牛奶');
            const doneField=Object.keys(initialRows[0].bindings).find(id=>typeof initialRows[0].bindings[id]==='boolean');
            assert.ok(titleField && doneField, 'Generated fields must represent the requested item and purchase status');
            const keyFor=title=>initialRows.find(item=>item.bindings[titleField]===title)?.key;
            const milk=keyFor('牛奶'),eggs=keyFor('鸡蛋'),bread=keyFor('面包');assert.ok(milk&&eggs&&bread);
            const surface=page.locator('[data-mini-app-surface]').first(),frame=surface.frameLocator('iframe[title="Interactive answer"]');
            const item=key=>frame.locator(`[data-repeat="${listId}"] [data-row-key="${key}"]`);
            await waitUntil(async()=>{await healthy(surface);return item(milk).getByRole('textbox').isVisible();},'shopping list ready');
            const save=async()=>{
              const button=surface.getByRole('button',{name:/^(Save|保存)$/});await button.click();
              await waitUntil(async()=>{await healthy(surface);return surface.getByText(/^(Saved · ready for your next message|已保存 · 后续追问可读取当前状态)$/).isVisible();},'saved shopping state');
              await waitUntil(()=>button.isEnabled(),'shopping save acknowledged');
              return api(`/api/sessions/${sample.original.sessionId}/mini-app?toolCallId=${original.toolCallId}`);
            };
            await screenshot(`${sample.id}-initial.png`);
            await item(milk).getByRole('textbox').fill('低脂牛奶');await item(milk).getByRole('checkbox').check();
            await item(eggs).getByRole('button',{name:/上移|↑/}).click();
            await item(bread).getByRole('button',{name:/删除/}).click();await item(bread).waitFor({state:'detached'});
            const input=original.plan.inputs.find(input=>input.type==='text');assert.ok(input);
            await frame.locator(`[data-input="${input.id}"]`).fill('苹果');
            await frame.getByRole('button',{name:/添加|新增|加入/}).click();
            await waitUntil(()=>frame.locator(`[data-repeat="${listId}"] [data-row-key]`).count().then(count=>count===3),'new shopping row');
            const saved=await save(),savedRows=saved.result.frame.repeats[listId];
            assert.deepEqual(savedRows.map(item=>item.bindings[titleField]),['鸡蛋','低脂牛奶','苹果']);
            assert.deepEqual(savedRows.map(item=>item.bindings[doneField]),[false,true,false]);
            assert.equal(savedRows[0].key,eggs);assert.equal(savedRows[1].key,milk);assert.ok(![milk,eggs,bread].includes(savedRows[2].key));
            row.checkpoints.push({step:'edited-reordered-saved',saved,uiText:await frame.locator('body').innerText()});await persist();
            await reload();await item(milk).getByRole('textbox').waitFor();
            assert.equal(await item(milk).getByRole('textbox').inputValue(),'低脂牛奶');assert.equal(await item(milk).getByRole('checkbox').isChecked(),true);
            assert.deepEqual((await save()).result.snapshot,saved.result.snapshot);row.reload='passed';
            await screenshot(`${sample.id}-restored.png`);
            await explain(sample,'现在清单里按顺序有哪些东西？哪些已经买了？直接告诉我，不用再做界面。',row);
          } else if (sample.taskId !== 'sorting') {
            const original = sample.original.components.find(output => output.publication?.status === 'committed');
            const surface = page.getByRole('region', { name: original.surface.title, exact: true });
            const input = original.surface.nodes.find(node => ['number', 'slider'].includes(node.type));
            assert.equal(input.type, 'number', 'Discrete quantities should use number inputs');
            const control = surface.getByLabel(input.label, { exact: true });
            await control.waitFor(); await waitUntil(() => control.isEnabled(), 'recorded component writable');
            if (input.max !== undefined) row.findings.push({ kind: 'generated-semantics', message: `User supplied no upper limit, but generated ${input.id} has max=${input.max}` });
            const values = sample.taskId === 'outing' ? [2, 4, 6] : [5, 6, 8];
            const expected = sample.taskId === 'outing' ? [[180,150], [240,240], [300,330]] : [[90,18], [88,14.67], [124,15.5]];
            const metrics = metricIds[sample.id].map(id => {
              const node = original.surface.nodes.find(node => node.id === id);
              assert.ok(node); return surface.getByText(node.label, { exact: true }).locator('..').locator('output');
            });
            for (const [index, value] of values.entries()) {
              await control.fill(String(value)); await control.press('Tab');
              for (const [metric, target] of expected[index].entries()) await waitUntil(async () => Math.abs(Number(await metrics[metric].textContent()) - target) < 0.011, `numeric result ${target}`);
              await surface.getByText(/^(Saved · available to your next message|已保存 · 后续追问可读取当前参数)$/).waitFor();
              let saved;
              await waitUntil(async () => {
                saved = await api(`/api/sessions/${sample.original.sessionId}/answer-output?kind=intelligent-ui&toolCallId=${original.toolCallId}`);
                return typeof saved.snapshot === 'string' && saved.snapshot.includes(`${input.label}: ${value}`);
              }, 'disk snapshot contains the selected parameter');
              const text = await surface.innerText();
              row.checkpoints.push({ input: value, expected: expected[index], uiText: text, saved });
            }
            await screenshot(`${sample.id}-operated.png`);
            await reload(); await control.waitFor();
            await waitUntil(async () => await control.inputValue() === String(values.at(-1)), 'component parameter restored');
            for (const [metric, target] of expected.at(-1).entries()) assert.ok(Math.abs(Number(await metrics[metric].textContent()) - target) < 0.011);
            row.reload = 'passed';
            await explain(sample, sample.taskId === 'outing' ? '按我现在调的人数，哪个方案更划算，差多少钱？直接说结果就好。' : '按我现在选的杯数，实际要付多少钱，平均一杯多少钱？直接说结果就好。', row);
          } else {
            const original = sample.original.journal.records.find(record => record.status === 'committed');
            const surface = page.locator('[data-mini-app-surface]').first(), frame = surface.frameLocator('iframe[title="Interactive answer"]');
            const next = frame.getByRole('button', { name: '下一步', exact: true });
            const ready = () => waitUntil(async () => { await healthy(surface); return next.isVisible(); }, 'mini app ready');
            await ready();
            const stats = frame.locator(sample.repetition === 1 ? '[data-text="comparisons"]' : sample.repetition === 2 ? '[data-text="passInfo"]' : '[data-text="statsText"]');
            const comparisons = number => waitUntil(async () => {
              await healthy(surface);
              if (!await stats.isVisible()) return false;
              return sample.repetition === 1 ? Number(await stats.textContent()) === number : new RegExp(`比较[^0-9]{0,8}${number}\\s*次`).test(await stats.textContent());
            }, `comparison ${number}`);
            const save = async () => {
              const button = surface.getByRole('button', { name: /^(Save|保存)$/ }); await button.click();
              await waitUntil(async () => { await healthy(surface); return surface.getByText(/^(Saved · ready for your next message|已保存 · 后续追问可读取当前状态)$/).isVisible(); }, 'saved checkpoint status');
              await waitUntil(() => button.isEnabled(), 'checkpoint save acknowledged');
              return api(`/api/sessions/${sample.original.sessionId}/mini-app?toolCallId=${original.toolCallId}`);
            };
            if (/4 次交换/.test(original.plan.initialSnapshot)) row.findings.push({ kind: 'generated-semantics', message: 'Initial snapshot claims four swaps; independent bubble-sort oracle requires five' });
            await comparisons(0); await screenshot(`${sample.id}-initial.png`);
            for (let i = 0; i < sortedStates.length; i++) {
              await next.click(); await comparisons(i + 1);
              const saved = await save(), state = saved.result.snapshot.state;
              assert.deepEqual(state.arr, sortedStates[i]); assert.equal(state.comparisons, i + 1); assert.equal(state.swaps, swaps[i]);
              row.checkpoints.push({ step: i + 1, saved, uiText: await frame.locator('body').innerText() });
              await persist();
              if (i === 2) {
                await reload(); await ready(); await comparisons(3);
                const restored = await save(); assert.deepEqual(restored.result.snapshot, saved.result.snapshot);
                row.midwayReload = 'passed';
              }
            }
            const final = row.checkpoints.at(-1).saved.result.snapshot;
            await next.click(); assert.deepEqual((await save()).result.snapshot, final);
            await reload(); await ready(); await comparisons(6); assert.deepEqual((await save()).result.snapshot, final);
            row.reload = 'passed';
            await surface.getByRole('button', { name: /^(Reset|复位)$/ }).click(); await comparisons(0);
            await surface.getByRole('button', { name: /^(Step|单步)$/ }).click(); await comparisons(1);
            assert.deepEqual((await save()).result.snapshot.state.arr, sortedStates[0]);
            await surface.getByRole('button', { name: /^(Play|播放)$/ }).click(); await comparisons(6);
            const played = await save(); assert.deepEqual(played.result.snapshot, final);
            await waitUntil(() => surface.getByRole('button', { name: /^(Play|播放)$/ }).isDisabled(), 'terminal playback stopped');
            row.hostPlayback = 'passed'; await screenshot(`${sample.id}-operated.png`);
            await explain(sample, '我现在走到哪一步了？还要比较吗，一共比较和交换了多少次？直接解释，不用新界面。', row);
          }
          row.status = 'completed'; await persist();
        });
      } catch (error) { row.status = 'failed'; row.error = error.message;
        row.failureView = await page.locator('[data-mini-app-surface]').evaluateAll(nodes => nodes.map(node => ({ attributes: { ...node.dataset }, text: node.innerText })));
        await screenshot(`${sample.id}-failure.png`).catch(() => {}); }
      await persist();
    }
    for (const sample of samples) assert.equal(createHash('sha256').update(await readFile(sample.source)).digest('hex'), sample.digest, 'Original record remains unchanged');
    assert.ok(rows.every(row => row.status === 'completed'), 'Some recorded tasks failed; inspect recorded-tasks.json');
  },
};
const result = await runDesktopScenario({ root, scenario, signal: cancellation.signal, timeoutMs: 1_800_000, stepTimeoutMs: 180_000 });
console.log(JSON.stringify({ directory: result.directory, status: result.report.status, cases: rows.map(row => ({ id: row.id, status: row.status, findings: row.findings, error: row.error })), cleanupErrors: result.report.cleanupErrors }));
if (result.report.status !== 'passed') process.exitCode = 1;
