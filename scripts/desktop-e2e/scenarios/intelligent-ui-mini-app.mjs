import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { discreteCounterPlan } from '../../../lib/mini-app-fixtures.mjs';
import {createJiti} from 'jiti';
const {a2uiExplodedExample}=await createJiti(import.meta.url).import('../../../lib/a2ui/exploded-example.ts');

const provider = 'desktop-mini-app-fixture', model = 'mini-app-fixture';
function savedApp(messages) {
  const texts = messages.flatMap(message => typeof message.content === 'string' ? [message.content] : (message.content ?? []).filter(block => block.type === 'text').map(block => block.text));
  const text = texts.findLast(value => value.startsWith('Saved mini app parameters and host publication results'));
  return text ? JSON.parse(text.slice(text.indexOf('\n') + 1)).apps.find(app => app.id === 'counter') : undefined;
}

export const intelligentUiMiniApp = {
  id: 'intelligent-ui-mini-app',
  mode: 'local-model-fixture',
  scope: 'real Electron and Next chat; A2UI 1.0 authoring, production mini app extension, QuickJS/WASM, iframe and persistence; deterministic local model',
  coverage: ['Beta switch through settings', 'chat tool publication and actual runtime assets', 'iframe input and click', 'shared discrete step and playback completion', 'event-only tools omit playback controls', 'save and reload', 'follow-up receives confirmed state', 'disable and restore saved interactive output'],
  limits: ['real model selection or generation quality', '3D and continuous simulations', 'multi-window recovery and migration', 'packaged builds', 'visual acceptance and other platforms'],
  async prepare({ paths, registerCleanup, report }) {
    const requests = [];
    report.credentials = 'synthetic-local-fixture-only; no user credentials';
    report.fixture = { provider, model, requests };
    const server = createServer(async (req, res) => {
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const tools = (body.tools ?? []).map(tool => tool.function?.name), app = savedApp(body.messages ?? []);
        // SDK context entries may follow the actual user as additional user-role
        // messages. Classify only this fixture's explicit task markers.
        const userTexts = (body.messages ?? []).filter(message => message.role === 'user').map(message => JSON.stringify(message.content ?? ''));
        const componentTask = userTexts.some(text => text.includes('费用对比 fixture'));
        const explodedTask = userTexts.some(text => text.includes('自行车拆解 fixture'));
        const eventOnlyTask = userTexts.some(text => text.includes('Create an event-only fixture:'));
        const selectedTool = componentTask ? 'piora_render_ui_plan' : 'piora_render_mini_app';
        const callId = componentTask ? 'desktop-a2ui-create' : explodedTask ? 'desktop-bike-create' : 'desktop-mini-app-create';
        const priorCall = body.messages?.some(message => message.role === 'tool' && message.tool_call_id === callId);
        const create = tools.includes(selectedTool) && !priorCall;
        const plan = discreteCounterPlan();plan.program=plan.program.replace('state.count>=5','state.count>=12');
        plan.document = {messages:[{version:'1.0',createSurface:{surfaceId:'counter',catalogId:'urn:piora:a2ui:interactive:1',dataModel:{inputs:{start:2}},components:[
          {id:'root',component:'Column',children:['startControl','count','increment']},
          {id:'startControl',component:'PioraNumber',label:'Starting value',value:{'@path':'/inputs/start'},min:0,max:20,step:1},
          {id:'count',component:'Text',text:{'@path':'/frame/count'}},
          {id:'increment',component:'Button',child:'incrementLabel',action:{functionCall:{'@call':'pioraEvent',args:{id:'increment'}}}},
          {id:'incrementLabel',component:'Text',text:'Add one'},
        ]}}]};
        if(create&&!componentTask)assert.ok(body.tools.find(tool=>tool.function?.name==='piora_render_mini_app')?.function.parameters.properties.document.properties.messages,'The desktop must expose the A2UI authoring contract');
        if(eventOnlyTask)plan.playback={mode:'none'};
        const answer = componentTask ? {id:'cost',title:'费用比较',messages:[{version:'1.0',createSurface:{surfaceId:'cost',catalogId:'urn:piora:a2ui:interactive:1',dataModel:{inputs:{people:2}},components:[
          {id:'root',component:'Row',children:['controls','results']},{id:'controls',component:'Card',child:'peopleControl'},
          {id:'peopleControl',component:'PioraNumber',label:'人数',value:{'@path':'/inputs/people'},min:1,step:1},
          {id:'results',component:'Card',child:'total'},{id:'total',component:'PioraMetric',label:'总费用',value:{'@call':'multiply',args:{values:[{'@path':'/inputs/people'},30]}}},
        ]}}]} : explodedTask ? a2uiExplodedExample('bike') : plan;
        requests.push({ at: Date.now(), tools, create, componentTask, eventOnlyTask, explodedTask, playback: componentTask ? null : answer.playback, savedState: app ?? null });
        assert.ok(requests.length < 20, 'Unexpected fixture model loop');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: `mini-${requests.length}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        emit({ role: 'assistant', ...(create ? { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: selectedTool, arguments: JSON.stringify(answer) } }] }
          : { content: app ? `Observed saved count: ${app.summary}` : 'Mini app desktop fixture' }) });
        emit({}, create ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n');
      } catch (error) {
        requests.push({ error: error.message }); if (!res.headersSent) res.writeHead(500);
        res.end(JSON.stringify({ error: { message: error.message } }));
      }
    });
    await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
    registerCleanup(() => new Promise((done, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : done()); }));
    await writeFile(join(paths.agent, 'models.json'), JSON.stringify({ providers: { [provider]: {
      api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'local-test-only',
      models: [{ id: model, name: 'Mini App Fixture', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    const settingsPath = join(paths.agent, 'settings.json'), settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    await writeFile(settingsPath, JSON.stringify({ ...settings, defaultProvider: provider, defaultModel: model, enabledModels: [`${provider}/${model}`] }));
  },
  async run({ page, step, waitUntil, reload, screenshot, directory }) {
    const surface = page.locator('[data-mini-app-surface]').first();
    const frame = surface.frameLocator('iframe[title="Interactive answer"]');
    const saved = surface.getByText(/^(Saved · ready for your next message|已保存 · 后续追问可读取当前状态)$/);
    async function beta(enabled) {
      await page.getByRole('button', { name: /^(Settings|设置)$/ }).click();
      const dialog = page.getByRole('dialog', { name: /^(Settings|设置)$/ });
      await dialog.getByRole('button', { name: /Beta Features/ }).click();
      const toggle = dialog.getByRole('switch', { name: 'Intelligent UI' });
      await waitUntil(() => toggle.isEnabled(), 'Beta setting loaded');
      if (await toggle.isChecked() !== enabled) await toggle.click();
      await waitUntil(async () => await toggle.isChecked() === enabled && await toggle.isEnabled(), 'Beta selection acknowledged in the UI');
      await waitUntil(async () => JSON.parse(await readFile(join(directory, 'agent', 'piora', 'beta-features.json'), 'utf8')).intelligentUi === enabled, 'persist Beta selection');
      await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    }
    async function send(text) {
      await page.locator('textarea').first().fill(text);
      await page.getByRole('button', { name: /^(Send|发送)$/ }).click();
    }
    const count = expected => waitUntil(() => frame.getByText(String(expected), { exact: true }).isVisible(), `counter ${expected}`);
    await step('enable-beta', () => beta(true));
    await step('generate-mini-app', async () => {
      await send('Create an interactive counter so I can change its starting value and add one.');
      await frame.getByRole('button', { name: 'Add one' }).waitFor(); await count(2); await saved.waitFor();
      await page.getByText('Observed saved count: Count: 2', { exact: true }).waitFor();
      // Publication can appear before the final assistant reply settles. The
      // answer host intentionally pauses interaction during reconciliation.
      await waitUntil(() => page.locator('[data-answer-output-interaction-paused="true"]').count().then(count => count === 0), 'conversation permits answer interaction');
      assert.equal(await surface.getByRole('button', { name: /^(Play|播放)$/ }).isVisible(), true);
      await screenshot('mini-app-created.png');
    });
    await step('operate-and-save', async () => {
      await frame.getByLabel('Starting value').fill('9'); await count(9);
      await frame.getByRole('button', { name: 'Add one' }).click(); await count(10);
      await surface.getByRole('button', { name: /^(Save|保存)$/ }).click(); await saved.waitFor();
      await waitUntil(() => surface.getByRole('button', { name: /^(Save|保存)$/ }).isEnabled(), 'save operation settled');
      await screenshot('mini-app-saved.png');
    });
    await step('appearance-keeps-checkpoint', async () => {
      await page.getByRole('button', { name: /^(Settings|设置)$/ }).click();
      const dialog = page.getByRole('dialog', { name: /^(Settings|设置)$/ });
      await dialog.getByRole('button', { name: /^(Appearance & Language|外观与界面)$/ }).click();
      await dialog.locator('[role="radio"][data-theme-id="dark"]').click();
      await dialog.getByRole('tab', { name: /^(Font|Fonts|字体)$/ }).click();
      await dialog.locator('[data-ui-font-size-choice="20"]').click();
      await waitUntil(() => frame.locator('body').evaluate(body => getComputedStyle(body).fontSize === '20px' && getComputedStyle(document.documentElement).colorScheme === 'dark'), 'mini app receives dark theme and user font size');
      await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
      await count(10); assert.equal(await frame.getByLabel('Starting value').inputValue(), '9');
      await screenshot('mini-app-dark-large.png');
    });
    await step('shared-step-and-completion', async () => {
      const hostStep=surface.getByRole('button',{name:/^(Step|单步)$/}),play=surface.getByRole('button',{name:/^(Play|播放)$/});
      await hostStep.click();await count(11);await play.click();await count(12);
      await waitUntil(()=>play.isDisabled(),'completed playback disables play');
      assert.equal(await hostStep.isDisabled(),true);
      await frame.getByRole('button',{name:'Add one'}).click();await count(12);
      await screenshot('mini-app-playback-finished.png');
      await surface.getByRole('button',{name:/^(Reset|复位)$/}).click();await count(9);
      await frame.getByRole('button',{name:'Add one'}).click();await count(10);
      await surface.getByRole('button',{name:/^(Save|保存)$/}).click();await saved.waitFor();
      await waitUntil(()=>surface.getByRole('button',{name:/^(Save|保存)$/}).isEnabled(),'reset checkpoint saved');
    });
    await step('reload-checkpoint', async () => {
      await reload(); await frame.getByRole('button', { name: 'Add one' }).waitFor(); await count(10);
      assert.equal(await frame.getByLabel('Starting value').inputValue(), '9');
      await waitUntil(() => frame.locator('body').evaluate(body => getComputedStyle(body).fontSize === '20px' && getComputedStyle(document.documentElement).colorScheme === 'dark'), 'reloaded app preserves appearance and checkpoint');
    });
    await step('explain-saved-result', async () => {
      await send('Explain my current count without making another interface.');
      await page.getByText('Observed saved count: Count: 10', { exact: true }).waitFor();
      assert.equal(await page.locator('[data-mini-app-surface]').count(), 1, 'explanation does not create another interactive output');
    });
    await step('disable-beta-keeps-snapshot', async () => {
      await beta(false);
      await waitUntil(async () => await page.locator('[data-mini-app-surface]').count() === 0, 'interactive surface removed');
      await waitUntil(async () => {
        const snapshot = await page.locator('[data-answer-output-snapshot]').first().textContent();
        return snapshot.includes('Count: 10') && snapshot.includes('Starting value: 9');
      }, 'disabled view shows the latest acknowledged state');
      await page.getByText('Observed saved count: Count: 10', { exact: true }).waitFor();
      await screenshot('mini-app-disabled.png');
    });
    await step('re-enable-restores-checkpoint', async () => {
      await beta(true); await frame.getByRole('button', { name: 'Add one' }).waitFor(); await count(10);
      assert.equal(await frame.getByLabel('Starting value').inputValue(), '9');
      await screenshot('mini-app-restored.png');
    });
    await step('event-only-controls-and-reload', async () => {
      await page.getByRole('button',{name:/^(New chat|新对话)$/}).first().click();
      await send('Create an event-only fixture: a counter operated only by its buttons.');
      await frame.getByRole('button',{name:'Add one'}).waitFor();await count(2);await saved.waitFor();
      assert.equal(await surface.getByRole('button',{name:/^(Play|播放|Step|单步)$/}).count(),0,'Event-only tasks have no misleading time controls');
      await frame.getByRole('button',{name:'Add one'}).click();await count(3);
      await surface.getByRole('button',{name:/^(Save|保存)$/}).click();await saved.waitFor();
      await waitUntil(()=>surface.getByRole('button',{name:/^(Save|保存)$/}).isEnabled(),'event-only checkpoint saved');
      await reload();await count(3);
      assert.equal(await surface.getByRole('button',{name:/^(Play|播放|Step|单步)$/}).count(),0);
      await screenshot('mini-app-event-only.png');
    });
    await step('a2ui-component-edit-and-reload', async () => {
      await page.getByRole('button',{name:/^(New chat|新对话)$/}).first().click();
      await send('费用对比 fixture：每人 30 元，先按两人，给我一个可以改人数的计算器。');
      const ui=page.locator('[data-a2ui-version="1.0"]');
      await ui.getByRole('spinbutton',{name:'人数'}).waitFor();
      await waitUntil(()=>ui.getByText('60',{exact:true}).isVisible(),'A2UI initial calculation');
      assert.equal(await ui.locator('[data-a2ui-component="Card"]').count(),2);
      await ui.getByRole('spinbutton',{name:'人数'}).fill('5');
      await waitUntil(()=>ui.getByText('150',{exact:true}).isVisible(),'A2UI reactive result');
      await page.getByText(/^(Saved · available to your next message|已保存 · 后续追问可读取当前参数)$/).waitFor();
      await screenshot('a2ui-component-saved.png');
      await reload();
      await waitUntil(async()=>await ui.getByRole('spinbutton',{name:'人数'}).inputValue()==='5','A2UI restored control');
      assert.equal(await ui.getByText('150',{exact:true}).isVisible(),true);
      await screenshot('a2ui-component-restored.png');
    });
    await step('a2ui-svg-explode-select-and-reload', async () => {
      await page.getByRole('button',{name:/^(New chat|新对话)$/}).first().click();
      await send('自行车拆解 fixture：展开自行车，并选择一个部件查看。');
      await frame.getByRole('button',{name:'完全展开'}).waitFor();
      await page.getByText('Mini app desktop fixture',{exact:true}).last().waitFor();
      await waitUntil(()=>page.locator('[data-answer-output-interaction-paused="true"]').count().then(count=>count===0),'SVG conversation settled');
      await frame.getByRole('button',{name:'完全展开'}).click();
      await waitUntil(async()=>await frame.locator('svg g').nth(1).getAttribute('transform')==='translate(70 25)','front wheel exploded geometry');
      // selectOption dispatches synthetic events, intentionally rejected by the
      // trusted renderer. Exercise the same native keyboard path as a person.
      await frame.getByLabel('查看部件').focus();
      await page.keyboard.press('Home');await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
      await waitUntil(async()=>await frame.locator('svg g').first().getAttribute('opacity')==='0.2','other parts dimmed');
      assert.equal(await frame.locator('svg g').nth(1).getAttribute('opacity'),'1');
      await surface.getByRole('button',{name:/^(Save|保存)$/}).click();await saved.waitFor();
      await waitUntil(()=>surface.getByRole('button',{name:/^(Save|保存)$/}).isEnabled(),'SVG checkpoint saved');
      await frame.locator('svg').scrollIntoViewIfNeeded();await screenshot('a2ui-bike-exploded.png');
      await reload();await frame.getByRole('button',{name:'完全展开'}).waitFor();
      await waitUntil(async()=>await frame.getByLabel('查看部件').inputValue()==='前轮','SVG selection restored');
      await waitUntil(async()=>await frame.locator('svg g').nth(1).getAttribute('transform')==='translate(70 25)' && await frame.locator('svg g').first().getAttribute('opacity')==='0.2','SVG restored frame');
      await frame.locator('svg').scrollIntoViewIfNeeded();await screenshot('a2ui-bike-restored.png');
    });
  },
};
