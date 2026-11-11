import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const { webpack } = require('next/dist/compiled/webpack/webpack.js');
const repo = path.resolve(import.meta.dirname, '..');

test('one chat settings page preserves controls, legacy entries and searchable targets', { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'piora-chat-settings-'));
  let browser;
  try {
    await writeFile(path.join(directory, 'ts.cjs'), `const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, 'css.cjs'), `module.exports=function(s){const prefix=require('node:path').basename(this.resourcePath).replace(/\\W/g,'_');const names=Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],prefix+'_'+m[1]]));const css=s.replace(/\\.([a-zA-Z][\\w-]*)/g,(_,n)=>'.'+names[n]);return 'const style=document.createElement("style");style.textContent='+JSON.stringify(css)+';document.head.append(style);export default '+JSON.stringify(names)}`);
    await writeFile(path.join(directory, 'entry.tsx'), `import{useState}from'react';import{createRoot}from'react-dom/client';import{I18nProvider}from'@/hooks/useI18n';import{SettingsDialog}from'@/components/SettingsDialog';import{ToolPermissionControl}from'@/components/ToolPermissionControl';const noop=()=>{};function App(){const[key,setKey]=useState('prompts');window.openPage=setKey;return <I18nProvider><ToolPermissionControl state={{mode:"auto",revision:1}} onChange={noop}/><SettingsDialog open activeKey={key} onActiveKeyChange={setKey} onClose={noop} conversation={{systemPrompt:'Example system prompt',onSystemPromptSaved:noop,notificationEnabled:false,notificationCapability:'unsupported',onNotificationToggle:noop}} desktop={{available:false}}/></I18nProvider>}createRoot(document.getElementById('root')).render(<App/>);`);
    const compiler = webpack({ mode: 'development', target: 'web', devtool: false, entry: path.join(directory, 'entry.tsx'), output: { path: directory, filename: 'bundle.js' }, resolve: { extensions: ['.tsx', '.ts', '.js'], modules: [path.join(repo, 'node_modules')], alias: { '@': repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, 'ts.cjs') }, { test: /\.css$/, use: path.join(directory, 'css.cjs') }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const css = (await readFile(path.join(repo, 'app/globals.css'), 'utf8')).replace(/^@import.*$/gm, '');
    browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chromium', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('pi-locale', 'zh-CN'));
    let approvalsEnabled = true;
    await page.route('https://chat-settings.test/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/settings/tool-approval') {
        if (route.request().method() === 'PUT') approvalsEnabled = route.request().postDataJSON().enabled;
        return route.fulfill({ json: { enabled: approvalsEnabled } });
      }
      if (url.pathname.endsWith('.js')) return route.fulfill({ contentType: 'text/javascript', body: await readFile(path.join(directory, path.basename(url.pathname))) });
      if (url.pathname === '/api/models-config/retry') return route.fulfill({ json: { enabled: true, maxRetries: 3, baseDelayMs: 2000, provider: { timeoutMs: null, maxRetries: null, maxRetryDelayMs: 60000 }, httpIdleTimeoutMs: 120000 } });
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { enabled: false, reserveTokens: 16384, templates: [], defaultTemplateId: null, settings: { enabled: true, maxRetries: 3, baseDelayMs: 2000, provider: { timeoutMs: null, maxRetries: null, maxRetryDelayMs: 60000 }, httpIdleTimeoutMs: 120000 }, modelList: [], models: [], files: [] } });
      return route.fulfill({ contentType: 'text/html', body: `<meta charset="utf-8"><style>${css}body{margin:0}</style><div id="root"></div><script src="/bundle.js"></script>` });
    });
    await page.goto('https://chat-settings.test/');
    await page.getByRole('heading', { name: '对话与任务', exact: true }).waitFor().catch(async error => { throw new Error(`${error.message}; renderer: ${errors.join('; ')}; visible: ${(await page.locator('body').innerText()).slice(0, 1500)}`); });
    assert.equal(await page.getByRole('button', { name: '对话与任务', exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: /^(运行策略|提示词与标题|鸿蒙开发)$/ }).count(), 0);
    assert.equal(await page.getByText('下一轮输入预测', { exact: true }).count(), 0);
    const toggle = page.getByRole('switch', { name: '权限控制', exact: true });
    await toggle.waitFor();
    assert.equal(await toggle.isChecked(), true);
    await page.locator('[data-permission-trigger]').waitFor();
    await toggle.click();
    await page.locator('[data-permission-trigger]').waitFor({ state: 'hidden' });
    assert.equal(approvalsEnabled, false);
    await page.reload();
    await toggle.waitFor();
    assert.equal(await toggle.isChecked(), false);
    await toggle.click();
    await page.locator('[data-permission-trigger]').waitFor();
    assert.equal(approvalsEnabled, true);
    const groups = await page.locator('[class*="settingsSectionHeading"]').allTextContents();
    assert.deepEqual(groups, ['1. 消息输入与阅读', '2. 回复辅助', '3. 任务运行', '4. 权限控制', '5. 系统提示词与优化', '6. 自动标题']);
    assert.equal(await toggle.locator('xpath=ancestor::*[contains(@class, "runtimeCards")]').count(), 0, 'permissions have their own section outside task execution');
    for (const id of ['permission.settings', 'conversation.autoScroll', 'conversation.notifications', 'conversation.runningSendMode', 'general.runningStatusLabel', 'general.modelRetry', 'models.compaction', 'conversation.systemPrompt', 'conversation.promptOptimizer', 'conversation.titleModel']) {
      assert.equal(await page.locator(`[data-settings-id="${id}"]`).count(), 1, `${id} remains available exactly once`);
    }
    const autoScroll = page.getByRole('switch', { name: '自动跟随最新输出', exact: true });
    await autoScroll.click();
    assert.equal(await autoScroll.getAttribute('aria-checked'), 'false');
    await page.reload();
    await page.getByRole('heading', { name: '对话与任务', exact: true }).waitFor();
    assert.equal(await autoScroll.getAttribute('aria-checked'), 'false', 'moving the setting preserves its saved value');
    await page.evaluate(() => window.openPage('modelRuntime'));
    await page.getByRole('heading', { name: '对话与任务', exact: true }).waitFor();
    await page.getByPlaceholder('搜索设置…').fill('模型请求超时');
    await page.getByRole('button', { name: /模型请求超时与重试/ }).click();
    await page.locator('[data-settings-id="general.modelRetry"][data-settings-highlighted="true"]').waitFor();
    assert.deepEqual(errors, []);
    await mkdir(path.join(repo, '.verification/chat-settings'), { recursive: true });
    await page.screenshot({ path: path.join(repo, '.verification/chat-settings/consolidated.png') });
  } finally {
    await browser?.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});
