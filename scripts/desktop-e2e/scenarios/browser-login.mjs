import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

let fixture;
export const browserLogin = {
  id: 'browser-login',
  mode: 'local-model-fixture',
  scope: 'real Electron chat and embedded browser; deterministic local model and login website',
  coverage: ['UI send without approval modes', 'automatic browser reveal without login cards', 'user sign-in through UI', 'automatic continuation through the real SDK', 'removed settings menu and launcher content'],
  limits: ['real model providers', 'third-party login providers and SSO', 'packaged releases', 'background Playwright handoff', 'non-Windows platforms'],
  async prepare({ paths, registerCleanup, report }) {
    const requests = [], metadataRequests = [];
    const server = createServer(async (req, res) => {
      if (!req.url.startsWith('/v1/')) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        if (req.method === 'POST') { res.writeHead(303, { 'Set-Cookie': 'fixture_login=yes; HttpOnly; SameSite=Lax; Path=/', Location: '/home' }); res.end(); return; }
        const signedIn = req.headers.cookie?.includes('fixture_login=yes');
        res.end(signedIn ? '<!doctype html><title>Signed in</title><h1>Signed in</h1><button>Log out</button>' : '<!doctype html><title>Sign in</title><form method="post"><label>User <input autocomplete="username" name="user"></label><label>Password <input type="password" name="password"></label><button>Sign in</button></form>');
        return;
      }
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const tools = body.messages.filter(message => message.role === 'tool').length;
        const browserRequest = body.tools?.some(tool => tool.function?.name === 'browser') === true;
        const action = !browserRequest ? null : tools === 0 ? { action: 'open', url: fixture.origin + '/login' }
          : tools === 1 ? { action: 'wait_for_user', purpose: 'login', reason: 'Sign in to the local test site' }
          : tools === 2 ? { action: 'snapshot' } : null;
        if (browserRequest) requests.push({ action: action?.action ?? 'final', tools });
        else metadataRequests.push({ kind: 'session-title' });
        assert.ok(requests.length <= 4, 'No extra browser-tool requests or repeated handoffs');
        if (action) assert.ok(body.tools.some(tool => tool.function.name === 'browser'), 'Browser tool must be enabled');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'login-fixture', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'browser-login', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        emit({ role: 'assistant', ...(action ? { tool_calls: [{ index: 0, id: `login-${tools}`, type: 'function', function: { name: 'browser', arguments: JSON.stringify(action) } }] } : { content: browserRequest ? 'LOGIN_AUTO_RESUMED' : 'Local browser login fixture' }) });
        emit({}, action ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n');
      } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(JSON.stringify({ error: { message: error.message } })); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    registerCleanup(() => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
    fixture = { origin: `http://127.0.0.1:${server.address().port}`, requests };
    report.fixture = { ...fixture, metadataRequests, credentials: 'synthetic local inputs only' };
    await writeFile(join(paths.agent, 'models.json'), JSON.stringify({ providers: { 'desktop-login-fixture': {
      api: 'openai-completions', baseUrl: fixture.origin + '/v1', apiKey: 'local-test-only',
      models: [{ id: 'browser-login', name: 'Browser Login Fixture', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    const settings = JSON.parse(await readFile(join(paths.agent, 'settings.json'), 'utf8'));
    await writeFile(join(paths.agent, 'settings.json'), JSON.stringify({ ...settings, enabledModels: ['desktop-login-fixture/browser-login'] }));
    await mkdir(join(paths.agent, 'piora/tool-permissions'), { recursive: true });
    await writeFile(join(paths.agent, 'piora/tool-permissions/default.json'), JSON.stringify({ mode: 'ask', revision: 9, schemaVersion: 2 }));
  },
  async run({ page, getBrowser, step, waitUntil, screenshot }) {
    await step('verify-clean-launcher-and-settings', async () => {
      assert.equal(await page.locator('[data-permission-trigger]').count(), 0);
      assert.equal(await page.getByText('先描述结果，项目和模型都可以直接在输入框里调整。', { exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: /审阅当前未提交的改动|Review uncommitted changes/ }).count(), 0);
      await page.getByRole('button', { name: /^(Settings|设置)$/ }).click();
      await page.getByRole('button', { name: /^(返回 Piora|Back to Piora)$/ }).first().waitFor();
      assert.equal(await page.getByRole('button', { name: /^(能力包|Capability bundles)$/ }).count(), 0);
      await page.getByRole('button', { name: /^(返回 Piora|Back to Piora)$/ }).first().click();
      await page.locator('textarea').first().waitFor({ state: 'visible' });
    });
    await step('send-and-reveal-login-without-cards', async () => {
      await page.locator('textarea').first().fill('Open the local fixture and continue automatically after I sign in.');
      await page.getByRole('button', { name: /^(Send|发送)$/ }).click();
      await page.getByRole('textbox', { name: /^(Address|地址)$/ }).waitFor({ state: 'visible' });
      await waitUntil(() => fixture.requests.some(request => request.action === 'wait_for_user'), 'login tool to begin');
      await page.getByText(/Sign in in the browser|请在浏览器中登录/).waitFor();
      assert.equal(await page.locator('.browser-user-wait, .browser-handoff-notice, [data-permission-trigger]').count(), 0);
      assert.equal(await page.getByRole('button', { name: /我已完成，继续|Done, continue/ }).count(), 0);
      await screenshot('login-visible.png');
    });
    await step('sign-in-through-native-browser', async () => {
      const site = await waitUntil(() => getBrowser().contexts().flatMap(context => context.pages()).find(candidate => candidate.url() === fixture.origin + '/login'), 'native login page');
      await site.getByLabel('User').fill('fixture-user');
      await site.getByLabel('Password').fill('fixture-password');
      await site.getByRole('button', { name: 'Sign in', exact: true }).click();
      await site.getByRole('heading', { name: 'Signed in' }).waitFor();
    });
    await step('verify-automatic-continuation', async () => {
      await page.getByText('LOGIN_AUTO_RESUMED', { exact: true }).waitFor();
      await waitUntil(() => page.getByRole('button', { name: /^(Send|发送)$/ }).isVisible(), 'session idle');
      assert.deepEqual(fixture.requests.map(request => request.action), ['open', 'wait_for_user', 'snapshot', 'final']);
      assert.equal(await page.locator('.browser-user-wait, .browser-handoff-notice, [data-permission-trigger]').count(), 0);
      await screenshot('login-resumed.png');
    });
  },
};
