import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
const require = createRequire(import.meta.url);
const { webpack } = require('next/dist/compiled/webpack/webpack.js');
const repo = path.resolve(import.meta.dirname, '..');

test('hidden history retains streaming, recovery, scroll and disclosure state; selector never flashes while disabled', { timeout: 180000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'piora-chat-rendering-'));
  let browser;
  const held = [];
  try {
    await writeFile(path.join(directory, 'ts.cjs'), `const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, 'css.cjs'), 'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    // Only the expensive message body is replaced, to count presentation work
    // deterministically. Session/recovery hooks, projection, virtualization,
    // selector and settings components are the production implementations.
    // MessageView uses retained row state in production: a plain useState here
    // would incorrectly discard the user's choice whenever a row is recycled.
    await writeFile(path.join(directory, 'message.tsx'), `import{memo}from'react';import{useVirtualRowToggle}from'@/components/VirtualRowState';export const MessageView=memo(function MessageView(p){window.renders??={};window.renders[p.entryId??'live']=(window.renders[p.entryId??'live']??0)+1;const[expanded,setExpanded]=useVirtualRowToggle('user-content');return <article data-entry={p.entryId??'live'} style={{height:expanded?180:80}}><button onClick={()=>setExpanded(v=>!v)}>Disclosure {expanded?'open':'closed'}</button><span>{typeof p.message.content==='string'?p.message.content:p.message.content?.map(b=>b.text??b.thinking??'tool').join('')}</span>{p.messageActions}</article>});`);
    await writeFile(path.join(directory, 'entry.tsx'), `
import React from 'react';import{createRoot}from'react-dom/client';
import{I18nProvider}from'@/hooks/useI18n';import{useAgentSession}from'@/hooks/useAgentSession';
import{ChatHistory}from'@/components/ChatHistory';import{SystemPromptSelector}from'@/components/SystemPromptSelector';
import{SettingsDialog}from'@/components/SettingsDialog';import{loadSystemPromptCatalog,publishSystemPromptCatalog}from'@/lib/system-prompt-client';
import{readPendingPrompts,savePendingPrompt}from'@/lib/prompt-recovery';
const noop=()=>{},session={id:'fixture',cwd:'C:/fixture',name:'Fixture',modified:'one'},selection={mode:'default'};
window.sources=[];window.EventSource=class{static OPEN=1;static CLOSED=2;readyState=1;constructor(url){this.url=location.origin+url;window.sources.push(this);setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:'connected'})}),0)}close(){this.readyState=2}};
window.emit=e=>window.sources.filter(s=>s.readyState===1&&s.url.includes('transport=delta')).forEach(s=>s.onmessage?.({data:JSON.stringify(e)}));
window.pending=()=>readPendingPrompts('fixture');window.refreshCatalog=loadSystemPromptCatalog;window.publishCatalog=publishSystemPromptCatalog;
function App(){const[visible,setVisible]=React.useState(true),[selectorKey,setSelectorKey]=React.useState(0),[settings,setSettings]=React.useState(null);
const state=useAgentSession({session,newSessionCwd:null,viewVisible:visible});const history=React.useRef(null);
window.state=state;window.remountSelector=()=>setSelectorKey(k=>k+1);window.showSettings=setSettings;window.reveal=id=>{state.pauseHistoryFollow();history.current.revealEntry(id)};
return <><button id="toggle" onClick={()=>setVisible(v=>!v)}>Settings / Chat</button><output id="running">{String(state.agentRunning)}</output>
<SystemPromptSelector key={selectorKey} selection={selection} onChange={noop}/>
<div style={{display:visible?'block':'none'}}><div id="chat-scroll-container" ref={state.scrollContainerRef} style={{width:600,height:480,overflowY:'auto'}}>
{!state.loading&&<ChatHistory visible={visible} handleRef={history} scrollContainer={state.scrollContainerRef} lastUserMsgRef={state.lastUserMsgRef} pendingScrollToUserRef={state.pendingScrollToUserRef}
messages={state.messages} entryIds={state.entryIds} modelChanges={state.modelChanges} streamingMessage={state.streamState.streamingMessage} busy={state.agentRunning} streaming={state.streamState.isStreaming} isNew={false} forkingEntryId={null} highlightedEntryId={null} directProcess/>}
</div></div>{!visible&&<main id="settings">Settings remain interactive <input id="settings-input"/></main>}
{settings&&<SettingsDialog open activeKey={settings} onActiveKeyChange={setSettings} onClose={()=>setSettings(null)} sections={{appearance:<p>Appearance</p>}} desktop={{available:false}} conversation={{systemPrompt:null,onSystemPromptSaved:noop,notificationEnabled:false,notificationCapability:'unsupported',onNotificationToggle:noop}}/>}</>}
await savePendingPrompt({id:'pending-offline',scope:'fixture',message:{role:'user',content:'recover me',clientPromptId:'pending-offline',timestamp:9999},draft:{value:'recover me',images:[],files:[]}});
createRoot(document.getElementById('root')).render(<I18nProvider><App/></I18nProvider>);`);
    const compiler = webpack({ mode: 'development', target: 'web', devtool: false, entry: path.join(directory, 'entry.tsx'), output: { path: directory, filename: 'bundle.js', publicPath: '/' },
      resolve: { extensions: ['.tsx', '.ts', '.js'], modules: [path.join(repo, 'node_modules')], alias: { '@': repo } },
      plugins: [new webpack.NormalModuleReplacementPlugin(/^\.\/MessageView$/, path.join(directory, 'message.tsx'))],
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, 'ts.cjs') }, { test: /\.css$/, use: path.join(directory, 'css.cjs') }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chromium', headless: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    let holdCatalog = true, failCatalog = false, catalogRequests = 0, modelRequests = 0, running = true;
    let diskReceipts = [];
    let catalog = { templates: [], defaultTemplateId: null, selectorVisible: false, maxPromptLength: 100000, maxNameLength: 80 };
    const messages = Array.from({ length: 200 }, (_, i) => [{ role: 'user', content: `question ${i}`, timestamp: i * 3 }, { role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }], timestamp: i * 3 + 1 }]).flat();
    const ids = messages.map((_, i) => `entry-${i}`);
    const agentState = () => ({ running, state: { runtime: running ? 'running' : 'idle', isStreaming: running, isPromptRunning: running } });
    await page.route('http://127.0.0.1:38199/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('.js')) return route.fulfill({ contentType: 'text/javascript', body: await readFile(path.join(directory, path.basename(url.pathname))) });
      if (!url.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><style>body{margin:8px}article{box-sizing:border-box}</style><div id="root"></div><script src="/bundle.js"></script>' });
      if (url.pathname === '/api/system-prompt') {
        catalogRequests++;
        if (route.request().method() === 'PATCH') catalog = { ...catalog, ...route.request().postDataJSON() };
        const captured = { ...catalog };
        if (holdCatalog) await new Promise(resolve => held.push(resolve));
        return route.fulfill(failCatalog ? { status: 503, json: { error: 'offline' } } : { json: captured }).catch(() => {});
      }
      if (url.pathname === '/api/models') { modelRequests++; return route.fulfill({ json: { models: {}, modelList: [], defaultModel: null } }); }
      if (url.pathname === '/api/sessions/fixture') return route.fulfill({ json: { context: { messages, entryIds: ids }, leafId: ids.at(-1), tree: [], info: { id: 'fixture', cwd: 'C:/fixture' }, persistedPromptIds: diskReceipts } });
      if (url.pathname === '/api/sessions/fixture/state' || url.pathname === '/api/agent/fixture' && route.request().method() === 'GET') return route.fulfill({ json: agentState() });
      if (route.request().method() === 'POST') return route.fulfill({ json: { success: true, data: {} } });
      return route.fulfill({ json: { operations: [], commands: [], taskTimings: [], submissions: [], records: [], reviews: [], hasMore: false } });
    });
    await page.addInitScript(() => {
      localStorage.setItem('pi-locale', 'zh-CN');
      window.selectorFlashes = 0;
      new MutationObserver(() => { if (document.querySelector('button[aria-haspopup="listbox"]')) window.selectorFlashes++; }).observe(document, { childList: true, subtree: true });
    });
    await page.goto('http://127.0.0.1:38199/');
    await page.waitForFunction(() => window.state?.agentRunning && !window.state.loading && window.sources.some(s => s.url.includes('transport=delta')), null, { timeout: 10000 })
      .catch(async error => { throw new Error(`${error.message}; ${errors.join('; ')}; ${JSON.stringify(await page.evaluate(() => ({ text: document.body.innerText, loading: window.state?.loading, error: window.state?.error, sources: window.sources?.map(s => s.url) })))}`); });
    assert.equal(await page.locator('button[aria-haspopup="listbox"]').count(), 0, 'unknown catalog is hidden');
    holdCatalog = false; held.splice(0).forEach(resolve => resolve());
    await page.waitForTimeout(100);
    await page.evaluate(() => window.remountSelector());
    await page.waitForTimeout(100);
    assert.equal(catalogRequests, 1, 'switches reuse the catalog');
    assert.equal(await page.evaluate(() => window.selectorFlashes), 0, 'disabled selector never entered the DOM');
    failCatalog = true;
    await page.evaluate(() => window.refreshCatalog(true));
    assert.equal(await page.locator('button[aria-haspopup="listbox"]').count(), 0, 'failed reload keeps hidden preference');
    failCatalog = false; holdCatalog = true; catalog.selectorVisible = true;
    await page.evaluate(() => { void window.refreshCatalog(true); });
    await page.waitForFunction(() => window.pending !== undefined);
    await page.evaluate(value => window.publishCatalog(value), catalog);
    await page.locator('button[aria-haspopup="listbox"]').waitFor();
    await page.evaluate(value => window.publishCatalog(value), { ...catalog, selectorVisible: false });
    holdCatalog = false; held.splice(0).forEach(resolve => resolve());
    await page.waitForTimeout(100);
    assert.equal(await page.locator('button[aria-haspopup="listbox"]').count(), 0, 'stale GET cannot undo a newer save');

    await page.evaluate(() => window.reveal('entry-200'));
    const reading = page.locator('article[data-entry="entry-200"]');
    await reading.waitFor();
    await reading.getByRole('button', { name: 'Disclosure closed' }).click();
    await reading.getByRole('button', { name: 'Disclosure open' }).waitFor();
    // Exercise real row recycling before hiding the history. Focus can pin an
    // offscreen row, so move focus outside the list before scrolling it away.
    await page.locator('#toggle').focus();
    await page.locator('#chat-scroll-container').hover();
    await page.mouse.wheel(0, 100000);
    await reading.waitFor({ state: 'detached' });
    await page.evaluate(() => window.reveal('entry-200'));
    await reading.waitFor();
    assert.equal(await reading.getByRole('button').first().innerText(), 'Disclosure open', 'recycled history retains disclosure state');
    await page.waitForTimeout(200);
    const top = await page.locator('#chat-scroll-container').evaluate(el => el.scrollTop);
    const counts = await page.evaluate(() => ({ ...window.renders }));
    for (let i = 0; i < 8; i++) {
      await page.evaluate(i => window.emit({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'stream '.repeat(i + 1) }], timestamp: 10000 } }), i);
    }
    assert.equal(await page.evaluate(() => window.renders['entry-200']), counts['entry-200'], 'completed history does not rerender on live tokens');
    await page.locator('#toggle').click();
    await page.locator('#settings-input').fill('still responsive');
    const hiddenCounts = await page.evaluate(() => ({ ...window.renders }));
    await page.evaluate(() => window.emit({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'arrived while hidden' }], timestamp: 10000 } }));
    await page.waitForFunction(() => window.state.streamState.streamingMessage?.content?.[0]?.text === 'arrived while hidden');
    assert.deepEqual(await page.evaluate(() => window.renders), hiddenCounts, 'hidden presentation stays frozen while the real session hook advances');
    assert.equal((await page.evaluate(() => window.pending())).length, 1, 'unconfirmed recovery remains durable while hidden');
    await page.locator('#toggle').click();
    await reading.waitFor();
    assert.ok(Math.abs(await page.locator('#chat-scroll-container').evaluate(el => el.scrollTop) - top) <= 2, 'return preserves reading position');
    assert.equal(await reading.getByRole('button').first().innerText(), 'Disclosure open', 'hidden history retains disclosure state');
    await page.evaluate(() => window.state.handleScrollToBottom());
    await page.locator('article[data-entry="live"]').waitFor();
    assert.match(await page.locator('article[data-entry="live"]').innerText(), /arrived while hidden/);
    await page.locator('#toggle').click();
    const final = { role: 'assistant', content: [{ type: 'text', text: 'finished while hidden' }], timestamp: 10001 };
    messages.push({ role: 'user', content: 'recover me', clientPromptId: 'pending-offline', timestamp: 9999 }, final);
    ids.push('accepted-user', 'final'); running = false;
    await page.evaluate(final => { window.emit({ type: 'message_end', message: final }); window.emit({ type: 'agent_end' }); window.emit({ type: 'prompt_done' }); }, final);
    await page.waitForFunction(() => !window.state.agentRunning, null, { timeout: 15000 });
    await page.locator('#toggle').click();
    await page.evaluate(() => window.state.handleScrollToBottom());
    await page.getByText('finished while hidden', { exact: true }).waitFor();
    assert.equal(await page.locator('#running').innerText(), 'false', 'background completion is reconciled');
    assert.equal((await page.evaluate(() => window.pending())).length, 1, 'live completion alone is not a disk receipt');
    diskReceipts = ['pending-offline'];
    await page.reload();
    await page.getByText('finished while hidden', { exact: true }).waitFor();
    await page.waitForFunction(async () => (await window.pending()).length === 0);
    assert.equal(await page.getByText('recover me', { exact: true }).count(), 1, 'disk-confirmed recovery is not duplicated after reload');
    await page.locator('#chat-scroll-container').hover();
    await page.mouse.wheel(0, -1000);
    await page.waitForTimeout(200);
    const idleTop = await page.locator('#chat-scroll-container').evaluate(el => el.scrollTop);
    await page.locator('#toggle').click();
    await page.locator('#toggle').click();
    await page.waitForTimeout(300);
    assert.ok(Math.abs(await page.locator('#chat-scroll-container').evaluate(el => el.scrollTop) - idleTop) <= 2, 'reopening an idle chat must not trigger completion scrolling');

    // The real settings component must not request optimizer models on unrelated pages.
    await page.waitForTimeout(100);
    const beforeModels = modelRequests;
    await page.evaluate(() => window.showSettings('appearance'));
    await page.getByText('Appearance', { exact: true }).waitFor();
    await page.waitForTimeout(150);
    assert.equal(modelRequests, beforeModels);
    // The prompt heading can paint before passive effects start their fetches.
    // Wait for the model response, not only for an unrelated DOM label.
    const promptModelsLoaded = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/models' && response.request().method() === 'GET' && response.status() === 200);
    await page.evaluate(() => window.showSettings('prompts'));
    await promptModelsLoaded;
    await page.getByText('在对话中显示模板选择器', { exact: true }).waitFor();
    assert.ok(modelRequests > beforeModels, 'prompt page loads its model options on demand');
    const selectorSwitch = page.getByRole('switch', { name: /在对话中显示模板选择器/ });
    const waitForSelectorSetting = checked => page.waitForFunction(checked =>
      document.querySelector('section[aria-labelledby="system-prompt-heading"] input[role="switch"]')?.checked === checked, checked);
    await selectorSwitch.click();
    await waitForSelectorSetting(false);
    await page.waitForFunction(() => !document.querySelector('button[aria-haspopup="listbox"]'));
    await selectorSwitch.click();
    await waitForSelectorSetting(true);
    await page.locator('button[aria-haspopup="listbox"]').waitFor();
    await selectorSwitch.click();
    await waitForSelectorSetting(false);
    await page.waitForFunction(() => !document.querySelector('button[aria-haspopup="listbox"]'));
    await page.evaluate(() => window.remountSelector());
    assert.equal(await page.locator('button[aria-haspopup="listbox"]').count(), 0, 'saved switch value survives a conversation remount');
    assert.deepEqual(errors, []);
  } finally {
    held.splice(0).forEach(resolve => resolve());
    await browser?.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(directory).startsWith('piora-chat-rendering-'));
    await rm(directory, { recursive: true, force: true });
  }
});
