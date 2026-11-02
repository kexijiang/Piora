import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createJiti } from 'jiti';
import { chromium } from 'playwright-core';
import { prepareMiniAppRuntime } from '../scripts/prepare-mini-app-runtime.mjs';
import { counterPlan } from './mini-app-fixtures.mjs';

// Real browser, IndexedDB, VM, SDK disk session and production route handlers.
// The HTTP shell supplies deterministic publication data and transport faults;
// it is not the Next/Electron launcher and does not invoke an answer model.
const require = createRequire(import.meta.url), repo = path.resolve(import.meta.dirname, '..');
const { webpack } = require('next/dist/compiled/webpack/webpack.js');
const jiti = createJiti(import.meta.url, { alias: { '@': repo } });
const { createOwnedSessionManager } = await jiti.import('./session-owned-manager.ts');
const { persistLazySessionManager } = await jiti.import('./session-persistence.ts');
const { cacheSessionPath, invalidateSessionPathCache } = await jiti.import('./session-reader.ts');
const { writeBetaFeatures } = await jiti.import('./beta-features.ts');
const { MiniAppJournal, miniAppEnvelope } = await jiti.import('./mini-app/journal.ts');
const { readMiniAppOutput } = await jiti.import('./mini-app/state-service.ts');
const { GET, PUT } = await jiti.import('../app/api/sessions/[id]/mini-app/route.ts');

test('browser checkpoint recovery and durable follow-up', { timeout: 180_000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'piora-mini-client-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  let browser, server, active;
  const sessions = [], faults = { offline: false, drop: false, hold: undefined }, traffic = [];
  t.after(async () => {
    faults.hold?.release();
    await browser?.close();
    await new Promise(done => server ? server.close(done) : done());
    for (const session of sessions) { globalThis.__piSessions?.delete(session.id); invalidateSessionPathCache(session.id); session.owned.release(); }
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    assert.equal(path.dirname(directory), tmpdir());
    await rm(directory, { recursive: true, force: true });
  });
  const runtime = path.join(directory, 'runtime'), manifest = await prepareMiniAppRuntime(repo, runtime);
  const source = await readFile(path.join(runtime, 'renderer.js'), 'utf8');
  const wasm = await readFile(require.resolve('quickjs-wasi/quickjs.wasm'));
  await writeFile(path.join(directory, 'entry.ts'), `
    import {acquireMiniAppClient} from ${JSON.stringify(path.join(repo, 'lib/mini-app/client-cache.ts'))};
    import {MiniAppController} from ${JSON.stringify(path.join(repo, 'lib/mini-app/controller.ts'))};
    import {listMiniAppDrafts,listMiniAppDraftPage,putMiniAppDraft,confirmMiniAppDraft} from ${JSON.stringify(path.join(repo, 'lib/mini-app/drafts.ts'))};
    import {flushPendingAnswerState,setAnswerStateEnabled} from ${JSON.stringify(path.join(repo, 'lib/answer-output-client.ts'))};
    let client,controller,config,lease,unsubscribe;window.failures=[];
    const text=(id,value)=>document.getElementById(id).textContent=String(value);
    const work=async(fn)=>{text('error','');try{await fn();}catch(e){text('error',e.code||e.name);}};
    const mount=async()=>{
      controller?.stop();const view=client.getSnapshot();
      controller=await MiniAppController.create(document.getElementById('surface'),view.output.plan,{snapshot:view.current.snapshot,
        onChange:(result,changed)=>{if(changed)client.update(result);},onStatus:status=>text('run',status),onError:e=>window.failures.push(e.code)});
      client.setCheckpointGate(fn=>controller.withCheckpoint(fn));
    };
    const paint=()=>{
      const v=client.getSnapshot();text('status',v.status);text('result',v.current?.frame.summary||'');text('revision',v.output?.stateRevision??'');
      const list=document.getElementById('drafts');list.replaceChildren();
      for(const draft of v.drafts){const button=document.createElement('button');button.textContent='Recover '+draft.summary;button.onclick=()=>work(async()=>{await client.recover(draft.id);await mount();});list.append(button);}
    };
    const begin=async()=>{config=await(await fetch('/fixture')).json();lease?.release();unsubscribe?.();controller?.stop();lease=acquireMiniAppClient(config.sessionId,'mini',config.payload,'fixture',()=>controller?.stop());client=lease.client;unsubscribe=client.subscribe(paint);await client.load();await mount();text('ready','yes');};
    document.getElementById('save').onclick=()=>work(()=>client.flush());
    document.getElementById('followup').onclick=()=>work(async()=>{await flushPendingAnswerState(config.sessionId);const result=await(await fetch('/followup')).json();text('followup-result',result.summary);});
    document.getElementById('saved').onclick=()=>work(async()=>{await client.useSavedState();await mount();});
    document.getElementById('resume').onclick=()=>work(mount);
    document.getElementById('disable').onclick=()=>{setAnswerStateEnabled(false);controller.stop();};
    document.getElementById('enable').onclick=()=>{setAnswerStateEnabled(true);};
    document.getElementById('hide').onclick=()=>{controller.stop();lease.release();};
    document.getElementById('show').onclick=()=>work(begin);
    window.fixture={view:()=>client.getSnapshot(),drafts:()=>listMiniAppDrafts(config.sessionId+':mini'),
      page:(cursor,limit)=>listMiniAppDraftPage(config.sessionId+':mini',cursor,limit),
      confirm:confirmMiniAppDraft,
      refresh:()=>client.reloadDrafts(),
      racePages:()=>Promise.all([client.loadMoreDrafts(),client.reloadDrafts()]),
      seedDrafts:async(count,prefix='draft-page-',toolCallId='mini')=>{
        const output=client.getSnapshot().output;
        for(let index=0;index<count;index++){
          const id=prefix+String(index).padStart(3,'0');
          await putMiniAppDraft({id,scope:config.sessionId+':'+toolCallId,sessionId:config.sessionId,toolCallId,createdAt:Date.now()+index,
            plan:output.plan,summary:'Checkpoint '+String(index+1).padStart(3,'0'),sent:false,
            request:{requestId:'request-'+id,toolCallId,publicationId:output.publication.id,planDigest:output.publication.planDigest,
              runtimeVersion:output.publication.runtimeVersion,leafId:output.leafId,expectedRevision:output.stateRevision,
              checkpoint:{...output.result.snapshot,state:{count:index+3}}}});
        }
      }};
    void work(begin);
  `);
  await writeFile(path.join(directory, 'surface.tsx'), `
    import {createRoot} from 'react-dom/client';
    import MiniAppSurface from ${JSON.stringify(path.join(repo, 'components/mini-app/MiniAppSurface.tsx'))};
    import {I18nProvider} from ${JSON.stringify(path.join(repo, 'hooks/useI18n.tsx'))};
    import {flushPendingAnswerState} from ${JSON.stringify(path.join(repo, 'lib/answer-output-client.ts'))};
    localStorage.setItem('pi-locale','zh-CN');
    void fetch('/fixture').then(r=>r.json()).then(config=>{
      createRoot(document.getElementById('react-root')).render(<I18nProvider><MiniAppSurface sessionId={config.sessionId} toolCallId="mini" payload={config.payload} snapshot="Step counter ready" envelopeVersion={1} branchKey="fixture"/></I18nProvider>);
      document.getElementById('followup').onclick=async()=>{try{await flushPendingAnswerState(config.sessionId);const data=await(await fetch('/followup')).json();document.getElementById('followup-result').textContent=data.summary;}catch(e){document.getElementById('followup-result').textContent='blocked';}};
    });
  `);
  // Use the actual module CSS with stable class names; only Next's CSS injection
  // is replaced by this fixture loader, not the component's layout rules.
  await writeFile(path.join(directory, 'css-loader.cjs'), `module.exports=function(source){const classes=Object.fromEntries([...source.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]]));return 'const style=document.createElement("style");style.textContent='+JSON.stringify(source)+';document.head.append(style);export default '+JSON.stringify(classes)+';';};`);
  const compiler = webpack({ mode: 'development', target: 'web', devtool: false, entry: { bundle: path.join(directory, 'entry.ts'), surface: path.join(directory, 'surface.tsx') }, output: { path: directory, filename: '[name].js', publicPath: '/' }, resolve: { extensions: ['.tsx', '.ts', '.js'], alias: { '@': repo }, modules: [path.join(repo, 'node_modules'), 'node_modules'] }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(repo, 'scripts/mini-app-typescript-loader.cjs') }, { test: /\.css$/, use: path.join(directory, 'css-loader.cjs') }] } });
  await new Promise((done, fail) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? fail(error || new Error(stats.toString({ all: false, errors: true }))) : done())));
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/api/mini-app/renderer') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ source, sha256: manifest.sha256 })); return; }
      if (url.pathname === '/api/mini-app/runtime') { res.setHeader('Content-Type', 'application/wasm'); res.end(wasm); return; }
      if (url.pathname === '/fixture') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ sessionId: active.id, payload: active.payload })); return; }
      if (url.pathname === '/followup') {
        const captured = await active.journal.capture();
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ summary: captured.apps[0]?.saved.result.frame.summary })); return;
      }
      if (url.pathname.endsWith('/mini-app') && url.pathname.startsWith('/api/sessions/')) {
        traffic.push({ method: req.method, query: url.search });
        if (faults.offline) { res.destroy(); return; }
        const parts = []; for await (const part of req) parts.push(part);
        const controller = new AbortController(); res.once('close', () => { if (!res.writableEnded) controller.abort(); });
        const request = new Request(url, { method: req.method, headers: req.headers, ...(req.method === 'PUT' ? { body: Buffer.concat(parts) } : {}), signal: controller.signal });
        if (req.method === 'PUT' && faults.hold) { const hold = faults.hold; hold.entered(); await hold.promise; faults.hold = undefined; }
        const response = await (req.method === 'PUT' ? PUT : GET)(request, { params: Promise.resolve({ id: active.id }) });
        if (req.method === 'PUT' && faults.drop) {
          const mode = faults.drop; faults.drop = false; assert.equal(response.status, 200);
          if (mode === 'socket') res.destroy();
          else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"receipt":'); }
          return;
        }
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer())); return;
      }
      if (url.pathname === '/') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><meta charset="utf-8">' + ['save', 'followup', 'saved', 'resume', 'disable', 'enable', 'hide', 'show'].map(id => '<button id="' + id + '">' + id + '</button>').join('') + ['ready', 'status', 'run', 'result', 'revision', 'error', 'followup-result', 'drafts', 'surface'].map(id => '<div id="' + id + '"></div>').join('') + '<script src="/bundle.js"></script>'); return;
      }
      if (url.pathname === '/surface') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--text:#172b3a;--text-muted:#526574;--bg:#fff;--bg-panel:#f6f8fa;--bg-hover:#eaf2f5;--border:#d5e0e6;--accent:#246a84}body{margin:16px;font-family:system-ui}</style><div id="react-root"></div><button id="followup">继续追问</button><p id="followup-result"></p><script src="/surface.js"></script>'); return;
      }
      const name = path.basename(url.pathname);
      if (!name.endsWith('.js')) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', 'application/javascript'); res.end(await readFile(path.join(directory, name)));
    } catch (error) { if (!res.destroyed) { res.writeHead(500); res.end(String(error)); } }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chromium', headless: true });
  async function setup(subtest) {
    const owned = createOwnedSessionManager(directory, path.join(directory, 'sessions'), directory), manager = owned.manager, id = manager.getSessionId();
    manager.appendMessage({ role: 'user', content: 'Show an interactive counter', timestamp: Date.now() }); persistLazySessionManager(manager);
    const journal = new MiniAppJournal({ manager, root: directory, runId: 'run', assertActive: owned.assertOwned }); await journal.start(); const { context } = await journal.capture();
    const assistant = manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'mini', name: 'piora_render_mini_app', arguments: counterPlan() }], timestamp: Date.now() });
    const initial = { snapshot: { inputs: { start: 2 }, state: { count: 2 }, rng: 0x50494f52, tick: 0 }, frame: { summary: 'Count: 2', bindings: { count: 2 }, playback: { finished: false } } };
    const record = await journal.create(context.requestId, 'mini', counterPlan(), initial);
    const result = manager.appendMessage({ role: 'toolResult', toolCallId: 'mini', toolName: 'piora_render_mini_app', isError: false, content: [{ type: 'text', text: 'candidate' }], details: miniAppEnvelope(record), timestamp: Date.now() });
    await journal.publish(record.operationId, { messageEntryId: assistant, toolResultEntryIds: [result] });
    cacheSessionPath(id, manager.getSessionFile()); writeBetaFeatures({ intelligentUi: true }, directory);
    active = { owned, manager, id, journal, payload: miniAppEnvelope(record).answerOutput.payload }; sessions.push(active);
    faults.offline = false; faults.drop = false; traffic.length = 0;
    const contextBrowser = await browser.newContext(), page = await contextBrowser.newPage(), errors = [];
    contextBrowser.on('page', p => p.on('pageerror', error => errors.push(error.message))); page.on('pageerror', error => errors.push(error.message));
    subtest.after(async () => { await contextBrowser.close(); assert.deepEqual(errors, []); });
    await page.goto(url); await page.waitForFunction(() => document.getElementById('ready').textContent === 'yes');
    return { page, contextBrowser, disk: () => readMiniAppOutput({ sessionId: id, readManager: () => manager, root: directory, toolCallId: 'mini' }) };
  }
  const count = (page, value) => page.waitForFunction(expected => document.getElementById('result').textContent === 'Count: ' + expected, value);
  const saved = page => page.waitForFunction(() => document.getElementById('status').textContent === 'saved' && !document.getElementById('error').textContent);
  const input = (page, value) => page.frameLocator('iframe').getByLabel('Starting value').fill(String(value));

  await t.test('real input saves, reload restores paused, and the follow-up reads the committed checkpoint', async st => {
    const { page, disk } = await setup(st);
    await input(page, 7); await count(page, 7); await page.click('#followup');
    await page.waitForFunction(() => document.getElementById('followup-result').textContent === 'Count: 7');
    assert.equal((await disk()).result.frame.summary, 'Count: 7');
    assert.deepEqual(await page.evaluate(() => window.fixture.drafts()), []);
    await page.reload(); await page.waitForFunction(() => document.getElementById('ready').textContent === 'yes');
    await count(page, 7); assert.equal(await page.locator('#run').textContent(), 'paused');
  });
  await t.test('offline edits survive reload and explicit recovery; unresolved drafts block follow-up', async st => {
    const { page, disk } = await setup(st);
    faults.offline = true; await input(page, 11); await count(page, 11); await page.click('#save');
    await page.waitForFunction(() => document.getElementById('status').textContent === 'error');
    await page.waitForFunction(async () => (await window.fixture.drafts()).length === 1);
    assert.equal((await disk()).result.frame.summary, 'Count: 2');
    faults.offline = false; await page.reload(); await page.waitForFunction(() => document.getElementById('ready').textContent === 'yes');
    await count(page, 2); await page.click('#followup');
    await page.waitForFunction(() => document.getElementById('error').textContent === 'RECOVERY');
    assert.equal(await page.locator('#followup-result').textContent(), '');
    await page.getByRole('button', { name: 'Recover Count: 11' }).click(); await count(page, 11); await saved(page);
    assert.equal((await disk()).result.frame.summary, 'Count: 11');
    assert.deepEqual(await page.evaluate(() => window.fixture.drafts()), []);
  });
  await t.test('a virtualized view keeps its pending save gate and resumes the same checkpoint', async st => {
    const { page, disk } = await setup(st);
    await input(page, 10); await count(page, 10); await page.click('#hide');
    assert.equal(await page.locator('iframe').count(), 0);
    await page.click('#followup'); await page.waitForFunction(() => document.getElementById('followup-result').textContent === 'Count: 10');
    assert.equal((await disk()).result.frame.summary, 'Count: 10');
    await page.click('#show'); await page.waitForFunction(() => document.getElementById('run').textContent === 'paused'); await count(page, 10);
  });
  await t.test('a lost successful response is confirmed by its receipt without a second write', async st => {
    const { page, disk } = await setup(st);
    // A truncated body reaches fetch's consumer. A dropped socket alone may be
    // transparently retried by Chromium before the client sees an error.
    faults.drop = 'body'; await input(page, 13); await count(page, 13); await page.click('#save');
    await page.waitForFunction(() => document.getElementById('status').textContent === 'error', null, { timeout: 5000 }).catch(async error => {
      st.diagnostic(JSON.stringify({ status: await page.locator('#status').textContent(), error: await page.locator('#error').textContent(), traffic })); throw error;
    });
    assert.equal((await disk()).result.frame.summary, 'Count: 13');
    const puts = traffic.filter(r => r.method === 'PUT').length;
    await page.click('#save'); await saved(page);
    assert.equal(traffic.filter(r => r.method === 'PUT').length, puts);
    assert.ok(traffic.some(r => r.query.includes('requestId=')));
    assert.deepEqual(await page.evaluate(() => window.fixture.drafts()), []);
  });
  await t.test('a browser retry after a disconnected response does not create another state revision', async st => {
    const { page, disk } = await setup(st);
    faults.drop = 'socket'; await input(page, 6); await count(page, 6); await page.click('#save');
    // Chromium may retry the idempotent PUT internally, or expose the failure.
    await page.waitForFunction(() => ['saved', 'error'].includes(document.getElementById('status').textContent));
    if (await page.locator('#status').textContent() === 'error') await page.click('#save');
    await saved(page); assert.equal((await disk()).stateRevision, 1); assert.equal((await disk()).result.frame.summary, 'Count: 6');
  });
  await t.test('edits made during an autosave rebase onto its receipt and survive the next save', async st => {
    const { page, disk } = await setup(st);
    let release, entered; const enteredPromise = new Promise(resolve => { entered = resolve; });
    faults.hold = { promise: new Promise(resolve => { release = resolve; }), release: () => release(), entered };
    st.after(() => release());
    await input(page, 5); await count(page, 5); await enteredPromise;
    await input(page, 9); await count(page, 9); release();
    await page.click('#save'); await saved(page);
    const state = await disk(); assert.equal(state.result.frame.summary, 'Count: 9'); assert.equal(state.stateRevision, 2);
    assert.deepEqual(await page.evaluate(() => window.fixture.drafts()), []);
  });
  await t.test('disabling Beta during a pending write keeps the local checkpoint without committing it', async st => {
    const { page, disk } = await setup(st);
    let release, entered; const enteredPromise = new Promise(resolve => { entered = resolve; });
    faults.hold = { promise: new Promise(resolve => { release = resolve; }), release: () => release(), entered };
    st.after(() => release());
    await input(page, 16); await count(page, 16); await enteredPromise;
    await page.click('#disable'); writeBetaFeatures({ intelligentUi: false }, directory); release();
    await page.waitForFunction(() => document.getElementById('status').textContent === 'error');
    assert.equal((await disk()).result.frame.summary, 'Count: 2');
    assert.equal((await page.evaluate(() => window.fixture.drafts())).length, 1);
    writeBetaFeatures({ intelligentUi: true }, directory); await page.click('#enable'); await page.click('#save'); await saved(page);
    assert.equal((await disk()).result.frame.summary, 'Count: 16');
  });
  await t.test('a sibling-branch draft cannot be recovered into the active branch', async st => {
    const { page, disk } = await setup(st), parent = active.manager.getLeafId();
    active.manager.appendMessage({ role: 'user', content: 'Left branch', timestamp: Date.now() }); persistLazySessionManager(active.manager);
    await page.reload(); await page.waitForFunction(() => document.getElementById('ready').textContent === 'yes');
    faults.offline = true; await input(page, 17); await count(page, 17); await page.click('#save');
    await page.waitForFunction(() => document.getElementById('status').textContent === 'error');
    active.manager.branch(parent); active.manager.appendMessage({ role: 'user', content: 'Right branch', timestamp: Date.now() }); persistLazySessionManager(active.manager);
    faults.offline = false; await page.reload(); await page.waitForFunction(() => document.getElementById('ready').textContent === 'yes');
    await page.getByRole('button', { name: 'Recover Count: 17' }).click();
    await page.waitForFunction(() => document.getElementById('status').textContent === 'conflict');
    assert.equal((await disk()).result.frame.summary, 'Count: 2');
    assert.equal((await page.evaluate(() => window.fixture.drafts())).length, 1);
  });
  await t.test('another window cannot overwrite a newer checkpoint; choosing saved state retains its draft', async st => {
    const { page, contextBrowser, disk } = await setup(st);
    const other = await contextBrowser.newPage(); await other.goto(url); await other.waitForFunction(() => document.getElementById('ready').textContent === 'yes');
    await input(page, 4); await count(page, 4); await page.click('#save'); await saved(page);
    await input(other, 8); await count(other, 8); await other.click('#save');
    await other.waitForFunction(() => document.getElementById('status').textContent === 'conflict');
    assert.equal((await disk()).result.frame.summary, 'Count: 4');
    await other.click('#saved'); await count(other, 4); await saved(other);
    assert.equal((await other.evaluate(() => window.fixture.drafts())).length, 1);
    await other.click('#followup'); await other.waitForFunction(() => document.getElementById('followup-result').textContent === 'Count: 4');
  });
  await t.test('the actual React surface saves, steps, reloads paused and retains readable narrow-window layout', async st => {
    const { page, disk } = await setup(st);
    await page.setViewportSize({ width: 390, height: 760 }); await page.goto(url + '/surface');
    await page.getByRole('button', { name: '播放', exact: true }).waitFor();
    const frame = page.frameLocator('iframe'); await frame.getByLabel('Starting value').fill('12');
    await frame.getByText('12', { exact: true }).waitFor();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByText('已保存 · 后续追问可读取当前状态', { exact: true }).waitFor();
    await page.getByRole('button', { name: '单步', exact: true }).click(); await frame.getByText('13', { exact: true }).waitFor();
    await page.click('#followup'); await page.waitForFunction(() => document.getElementById('followup-result').textContent === 'Count: 13');
    assert.equal((await disk()).result.frame.summary, 'Count: 13');
    await page.reload(); await page.getByRole('button', { name: '播放', exact: true }).waitFor();
    await page.frameLocator('iframe').getByText('13', { exact: true }).waitFor();
    assert.equal(await page.getByText('已暂停', { exact: true }).count(), 1);
    assert.equal(await page.locator('[data-mini-app-surface]').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await page.waitForFunction(() => document.querySelector('iframe').clientHeight < 280, null, { timeout: 3000 });
    await mkdir(path.join(repo, '.verification'), { recursive: true });
    await page.locator('[data-mini-app-surface]').screenshot({ path: path.join(repo, '.verification/phase3-surface-browser.png') });
    faults.offline = true;
    await page.frameLocator('iframe').getByLabel('Starting value').fill('15'); await page.frameLocator('iframe').getByText('15', { exact: true }).waitFor();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByText('加载或保存未完成，请核对保留的检查点后继续。', { exact: true }).waitFor();
    assert.equal((await disk()).result.frame.summary, 'Count: 13');
    faults.offline = false; await page.reload();
    await page.getByText('有本机检查点需要核对', { exact: true }).waitFor();
    assert.equal(await page.locator('iframe').count(), 0, 'Unresolved recovery does not execute a new instance');
    await page.getByRole('button', { name: '恢复这份检查点', exact: true }).click();
    await page.frameLocator('iframe').getByText('15', { exact: true }).waitFor();
    assert.equal((await disk()).result.frame.summary, 'Count: 15');
  });
  await t.test('a local recovery-write failure stops the surface and offers the in-memory checkpoint for export', async st => {
    const { page, disk } = await setup(st);
    await page.addInitScript(() => {
      const transaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args) {
        if (window.failRecoveryWrite && args[1] === 'readwrite') throw new DOMException('Injected recovery write failure', 'QuotaExceededError');
        return transaction.apply(this, args);
      };
    });
    await page.goto(url + '/surface'); await page.getByRole('button', { name: '播放', exact: true }).waitFor();
    await page.evaluate(() => { window.failRecoveryWrite = true; });
    await page.frameLocator('iframe').getByLabel('Starting value').fill('18');
    await page.getByText('本机恢复存储不可用。请保持页面开启，重试或先另存当前检查点。', { exact: true }).waitFor();
    assert.equal(await page.locator('iframe').count(), 0);
    assert.equal((await disk()).result.frame.summary, 'Count: 2');
    const download = page.waitForEvent('download'); await page.getByRole('button', { name: '另存当前检查点', exact: true }).click();
    const file = await download, savedFile = path.join(directory, 'exported-checkpoint.json'); await file.saveAs(savedFile);
    const exported = JSON.parse(await readFile(savedFile, 'utf8'));
    assert.equal(exported.checkpoint.state.count, 18); assert.equal(exported.confirmed, false); assert.equal(exported.summary, 'Count: 18');
    await page.evaluate(() => { window.failRecoveryWrite = false; }); await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.getByText('已保存 · 后续追问可读取当前状态', { exact: true }).waitFor();
    assert.equal((await disk()).result.frame.summary, 'Count: 18');
  });
  await t.test('actual React recovery discovers and recovers checkpoints beyond the first 20 without exposing another scope',async st=>{
    const {page,disk}=await setup(st);
    await page.evaluate(async()=>{await window.fixture.seedDrafts(45);await window.fixture.seedDrafts(2,'other-page-','other-tool');});
    await page.goto(url+'/surface');
    const recover=()=>page.getByRole('button',{name:'恢复这份检查点',exact:true});
    await page.waitForFunction(()=>document.querySelectorAll('.draft').length===20);
    assert.equal(await recover().count(),20);
    assert.equal(await page.locator('iframe').count(),0,'Recovery still blocks a new interactive instance');
    await page.getByRole('button',{name:'加载更多检查点',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.draft').length===40);
    await page.getByRole('button',{name:'加载更多检查点',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.draft').length===45);
    assert.equal(await page.getByRole('button',{name:'加载更多检查点',exact:true}).count(),0);
    await page.click('#followup');await page.waitForFunction(()=>document.getElementById('followup-result').textContent==='blocked');
    const last=page.locator('.draft').filter({has:page.getByText('Checkpoint 045',{exact:true})});
    const download=page.waitForEvent('download');await last.getByRole('button',{name:'另存检查点',exact:true}).click();
    const exported=path.join(directory,'page-three-export.json');await(await download).saveAs(exported);
    assert.equal(JSON.parse(await readFile(exported,'utf8')).checkpoint.state.count,47);
    await last.getByRole('button',{name:'恢复这份检查点',exact:true}).click();
    await page.getByText('已保存 · 后续追问可读取当前状态',{exact:true}).waitFor();
    assert.equal((await disk()).result.frame.summary,'Count: 47');
    await page.getByRole('button',{name:'保留本机草稿并使用已保存状态',exact:true}).click();
    await page.frameLocator('iframe').getByText('47',{exact:true}).waitFor();
    await page.click('#followup');await page.waitForFunction(()=>document.getElementById('followup-result').textContent==='Count: 47');
    await page.reload();await page.getByText('有本机检查点需要核对',{exact:true}).waitFor();
    await page.getByRole('button',{name:'加载更多检查点',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.draft').length===40);
    await page.getByRole('button',{name:'加载更多检查点',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.draft').length===44);
    assert.equal(await page.getByText('Checkpoint 045',{exact:true}).count(),0,'Only the confirmed source was removed');
    assert.equal(await recover().count(),44,'Other tool scope was never included');
    await page.locator('[data-mini-app-surface]').screenshot({path:path.join(repo,'.verification/phase3-recovery-pagination.png')});
  });
  await t.test('draft page cursors survive deletion, reject another scope, and a refresh wins over an older page read',async st=>{
    const {page}=await setup(st);await page.evaluate(()=>window.fixture.seedDrafts(25));
    const first=await page.evaluate(()=>window.fixture.page());assert.equal(first.items.length,20);assert.ok(first.next);
    await page.evaluate(id=>window.fixture.confirm(id,'request-'+id),first.items.at(-1).id);
    const second=await page.evaluate(cursor=>window.fixture.page(cursor),first.next);
    assert.deepEqual(second.items.map(row=>row.id),Array.from({length:5},(_,i)=>'draft-page-'+String(i+20).padStart(3,'0')));
    assert.equal(second.next,undefined);
    assert.equal(await page.evaluate(async cursor=>{try{await window.fixture.page({...cursor,scope:'wrong'});return 'accepted';}catch(e){return e.code;}},first.next),'STORAGE');
    await page.evaluate(()=>window.fixture.refresh());await page.evaluate(()=>window.fixture.racePages());
    assert.equal((await page.evaluate(()=>window.fixture.view())).drafts.length,20,'A stale load-more response cannot replace refreshed first page');
    await page.addInitScript(()=>{
      const open=IDBIndex.prototype.openCursor;
      IDBIndex.prototype.openCursor=function(...args){if(window.failDraftPage)throw new DOMException('Injected read failure','UnknownError');return open.apply(this,args);};
    });
    await page.goto(url+'/surface');await page.waitForFunction(()=>document.querySelectorAll('.draft').length===20);
    await page.evaluate(()=>{window.failDraftPage=true;});
    await page.getByRole('button',{name:'加载更多检查点',exact:true}).click();
    await page.getByText('检查点读取失败，本机副本仍已保留，请重试。',{exact:true}).waitFor();
    assert.equal(await page.locator('.draft').count(),20);
    await page.evaluate(()=>{window.failDraftPage=false;});
    await page.getByRole('button',{name:'加载更多检查点',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.draft').length===24);
    await page.getByRole('button',{name:'刷新检查点列表',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.draft').length===20);
  });
});
