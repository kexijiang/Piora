import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { discreteCounterPlan } from '../../../lib/mini-app-fixtures.mjs';

const provider = 'desktop-mini-app-fixture', model = 'mini-app-fixture';
function savedApp(messages) {
  const texts = messages.flatMap(message => typeof message.content === 'string' ? [message.content] : (message.content ?? []).filter(block => block.type === 'text').map(block => block.text));
  const text = texts.findLast(value => value.startsWith('Saved mini app parameters and host publication results'));
  return text ? JSON.parse(text.slice(text.indexOf('\n') + 1)).apps.find(app => app.id === 'counter') : undefined;
}

export const intelligentUiMiniApp = {
  id: 'intelligent-ui-mini-app',
  mode: 'local-model-fixture',
  scope: 'real Electron and Next chat; production mini app extension, QuickJS/WASM, iframe and persistence; deterministic local model',
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
        const priorCall = body.messages?.some(message => message.role === 'tool' && message.tool_call_id === 'desktop-mini-app-create');
        const create = tools.includes('piora_render_mini_app') && !priorCall;
        const plan = discreteCounterPlan();plan.program=plan.program.replace('state.count>=5','state.count>=12');
        const lastUser=body.messages?.findLast(message=>message.role==='user');
        if(JSON.stringify(lastUser?.content ?? '').includes('event-only fixture'))plan.playback={mode:'none'};
        requests.push({ at: Date.now(), tools, create, savedState: app ?? null });
        assert.ok(requests.length < 20, 'Unexpected fixture model loop');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: `mini-${requests.length}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        emit({ role: 'assistant', ...(create ? { tool_calls: [{ index: 0, id: 'desktop-mini-app-create', type: 'function', function: { name: 'piora_render_mini_app', arguments: JSON.stringify(plan) } }] }
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
  },
};
