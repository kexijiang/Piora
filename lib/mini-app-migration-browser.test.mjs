import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { createJiti } from 'jiti';
import { chromium } from 'playwright-core';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { migrationFixture } from './mini-app-migration-fixtures.mjs';
import { counterPlan } from './mini-app-fixtures.mjs';
import { prepareMiniAppRuntime } from '../scripts/prepare-mini-app-runtime.mjs';
const repo=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url),webpack=require('next/dist/compiled/webpack/webpack').webpack;
const jiti=createJiti(import.meta.url,{alias:{'@':repo}});
const {GET,PUT}=await jiti.import('../app/api/sessions/[id]/mini-app/route.ts');
const {GET:review,POST:confirm}=await jiti.import('../app/api/sessions/[id]/mini-app/migration/route.ts');
const {POST:preview}=await jiti.import('../app/api/sessions/[id]/mini-app/migration/preview/route.ts');
const {miniAppEnvelope}=await jiti.import('./mini-app/journal.ts');
const {answerDataDigest}=await jiti.import('./answer-output-receipts.ts');
const {compileMiniAppPlan}=await jiti.import('./mini-app/plan.ts');

test('native revision review preserves compatible values, confirms once and renders restored state', {timeout:120_000},async t=>{
  const directory=await mkdtemp(path.join(repo,'.verification','mini-app-migration-browser-'));
  let server,browser,active,drop=false,completed=false;const pageErrors=[],posts=[],failures=[];
  t.after(async()=>{
    await browser?.close();if(server)await new Promise(done=>server.close(done));
    await writeFile(path.join(directory,'result.json'),JSON.stringify({status:completed?'passed':'failed',scope:'Headless Edge, actual React surfaces and production API, real SDK files and QuickJS; deterministic plans, no model or native desktop window',pageErrors,failures},null,2));
  });
  const run=(name,work)=>t.test(name,async st=>{try{await work(st);}catch(error){failures.push({name,error:String(error)});throw error;}});
  await prepareMiniAppRuntime(repo);
  const source=await readFile(path.join(repo,'.mini-app-runtime/renderer.js'),'utf8'),wasm=await readFile(path.join(repo,'.mini-app-runtime/quickjs.wasm'));
  const manifest=JSON.parse(await readFile(path.join(repo,'.mini-app-runtime/manifest.json'),'utf8'));
  await writeFile(path.join(directory,'entry.tsx'),`
    import {createRoot} from 'react-dom/client';
    import MiniAppSurface from ${JSON.stringify(path.join(repo,'components/mini-app/MiniAppSurface.tsx'))};
    import {I18nProvider} from ${JSON.stringify(path.join(repo,'hooks/useI18n.tsx'))};
    localStorage.setItem('pi-locale','zh-CN');
    fetch('/fixture').then(r=>r.json()).then(c=>createRoot(document.getElementById('root')).render(<I18nProvider>{c.outputs.map(o=><MiniAppSurface key={o.toolCallId} sessionId={c.sessionId} toolCallId={o.toolCallId} payload={o.payload} snapshot="Counter" envelopeVersion={1}/>)}</I18nProvider>));
  `);
  await writeFile(path.join(directory,'css-loader.cjs'),`module.exports=function(source){const names=Object.fromEntries([...source.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]]));return 'const s=document.createElement("style");s.textContent='+JSON.stringify(source)+';document.head.append(s);export default '+JSON.stringify(names)+';';};`);
  const compiler=webpack({mode:'development',target:'web',devtool:false,entry:path.join(directory,'entry.tsx'),output:{path:directory,filename:'app.js'},resolve:{extensions:['.tsx','.ts','.js'],alias:{'@':repo},modules:[path.join(repo,'node_modules'),'node_modules']},module:{rules:[{test:/\.tsx?$/,exclude:/node_modules/,use:path.join(repo,'scripts/mini-app-typescript-loader.cjs')},{test:/\.css$/,use:path.join(directory,'css-loader.cjs')}]}});
  await new Promise((done,fail)=>compiler.run((error,stats)=>compiler.close(()=>error||stats.hasErrors()?fail(error||new Error(stats.toString({all:false,errors:true}))):done())));
  server=createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,`http://${req.headers.host}`);
      if(url.pathname==='/fixture'){res.setHeader('content-type','application/json');res.end(JSON.stringify({sessionId:active.id,outputs:active.journal().records.map(r=>({toolCallId:r.toolCallId,payload:miniAppEnvelope(r).answerOutput.payload}))}));return;}
      if(url.pathname==='/api/mini-app/renderer'){res.setHeader('content-type','application/json');res.end(JSON.stringify({source,sha256:manifest.sha256}));return;}
      if(url.pathname==='/api/mini-app/runtime'){res.setHeader('content-type','application/wasm');res.end(wasm);return;}
      if(url.pathname.startsWith('/api/sessions/')){
        const parts=[];for await(const part of req)parts.push(part);
        const request=new Request(url,{method:req.method,headers:req.headers,...(['POST','PUT'].includes(req.method)?{body:Buffer.concat(parts)}:{})});
        const migration=url.pathname.endsWith('/migration');
        if(migration&&req.method==='POST')posts.push(JSON.parse(Buffer.concat(parts).toString()));
        const response=await (url.pathname.endsWith('/migration/preview')?preview:migration?req.method==='POST'?confirm:review:req.method==='PUT'?PUT:GET)(request,active.context);
        if(migration&&req.method==='POST'&&drop&&response.ok){drop=false;res.writeHead(200,{'content-type':'application/json'});res.end('{"status":');return;}
        res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());return;
      }
      if(url.pathname.endsWith('.js')){res.setHeader('content-type','application/javascript');res.end(await readFile(path.join(directory,path.basename(url.pathname))));return;}
      res.setHeader('content-type','text/html');res.end('<html><head><meta charset="utf-8"><style>:root{--text:#182832;--bg:#fff;--bg-panel:#f7f9fa;--border:#d8dfe3;--text-muted:#516471;--accent:#177b8a;}body{font:14px system-ui;margin:28px;}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
    }catch(error){res.writeHead(500);res.end(String(error));}
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));const url=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({channel:process.platform==='win32'?'msedge':'chromium',headless:true});
  async function setup(st,nextPlan){
    active=await migrationFixture(st,nextPlan?{next:nextPlan}:{});posts.length=0;
    const context=await browser.newContext({viewport:{width:1100,height:850}}),page=await context.newPage();page.setDefaultTimeout(12_000);page.on('pageerror',e=>pageErrors.push(e.message));st.after(async()=>{
      if(!page.isClosed())await writeFile(path.join(directory,`state-${active.id}.json`),JSON.stringify({body:await page.locator('body').innerText(),posts,pageErrors},null,2));
      await context.close();
    });
    await page.goto(url);await page.getByRole('button',{name:'核对变化 / 刷新',exact:true}).waitFor();
    return {page,old:page.locator('[data-mini-app-surface]').first(),next:page.locator('[data-mini-app-surface]').last()};
  }
  async function rehearse(surface,value,keyboard=false){
    const button=surface.getByRole('button',{name:'预演所选变化',exact:true});
    if(keyboard){await button.focus();await button.press('Enter');}else await button.click();
    const preview=surface.getByRole('region',{name:'修订预演',exact:true});await preview.waitFor();
    if(value!==undefined)await preview.getByText(`Count: ${value}`,{exact:true}).waitFor();
  }
  await run('trusted review click, editable choices, one confirmation, old version retained and reload',async st=>{
    const {page,old,next}=await setup(st);
    await next.getByText('初始预览 · 尚未应用',{exact:true}).waitFor();
    await next.getByText('这份预览尚未替换当前版本或进度。',{exact:true}).waitFor();
    assert.equal(await old.getByText('初始预览 · 尚未应用',{exact:true}).count(),0,'Active progress is not labelled as a candidate preview');
    await page.getByRole('button',{name:'核对变化 / 刷新',exact:true}).evaluate(el=>el.click());
    assert.equal(await page.getByRole('button',{name:'确认新版并重新开始进度',exact:true}).count(),0,'Synthetic clicks cannot request review');
    await page.getByRole('button',{name:'核对变化 / 刷新',exact:true}).click();
    const choice=next.locator('input[type="number"]');await choice.waitFor();assert.equal(await choice.inputValue(),'7');
    const confirmButton=page.getByRole('button',{name:'确认新版并重新开始进度',exact:true});
    assert.equal(await confirmButton.isDisabled(),true,'Confirmation waits for an actual preview');
    await next.getByText('Count: 19',{exact:true}).waitFor();
    await choice.fill('999');await next.getByRole('button',{name:'预演所选变化',exact:true}).click();
    await next.getByRole('alert').waitFor();assert.equal((await active.read('old')).writable,true);
    await page.getByRole('button',{name:'核对变化 / 刷新',exact:true}).click();
    await page.waitForFunction(()=>[...document.querySelectorAll('[data-mini-app-surface]')].at(-1)?.querySelector('input[type="number"]')?.value==='7');assert.equal(await choice.inputValue(),'7');
    await rehearse(next,7,true);assert.equal(await confirmButton.isEnabled(),true);
    await choice.fill('8');assert.equal(await confirmButton.isDisabled(),true,'Input edit invalidates preview');
    await next.getByRole('button',{name:'预演所选变化',exact:true}).evaluate(el=>el.click());assert.equal(await confirmButton.isDisabled(),true,'Synthetic preview click cannot enable confirmation');
    await rehearse(next,8);await page.screenshot({path:path.join(directory,'review.png'),fullPage:true});
    await page.getByRole('button',{name:'确认新版并重新开始进度',exact:true}).click();
    await next.frameLocator('iframe').getByLabel('Starting value').waitFor();
    assert.equal(await next.getByText('初始预览 · 尚未应用',{exact:true}).count(),0,'Committed state is no longer an unapplied preview');
    assert.equal(await next.frameLocator('iframe').getByLabel('Starting value').inputValue(),'8');
    assert.equal((await active.read()).result.snapshot.state.count,8);assert.equal((await active.read()).result.snapshot.tick,0);
    await old.getByText('已有新版本，此版本仅供查看',{exact:true}).waitFor();assert.equal((await active.read('old')).result.snapshot.state.count,19);assert.equal(posts.length,1);assert.deepEqual(posts.map(p=>p.inputs.start),[8]);assert.match(posts[0].previewDigest,/^[a-f0-9]{64}$/);
    await page.reload();await next.frameLocator('iframe').getByLabel('Starting value').waitFor();assert.equal(await next.frameLocator('iframe').getByLabel('Starting value').inputValue(),'8');
    await page.screenshot({path:path.join(directory,'confirmed.png'),fullPage:true});
  });
  await run('lost successful response is recovered by refresh without a second confirmation',async st=>{
    const {page,next}=await setup(st);await page.getByRole('button',{name:'核对变化 / 刷新',exact:true}).click();
    await rehearse(next,7);
    drop=true;await page.getByRole('button',{name:'确认新版并重新开始进度',exact:true}).click();
    await next.getByRole('alert').waitFor();await page.getByRole('button',{name:'核对变化 / 刷新',exact:true}).click();
    await next.frameLocator('iframe').getByLabel('Starting value').waitFor();assert.equal(posts.length,1);
    assert.equal(SessionManager.open(active.file).getEntries().filter(e=>e.customType==='piora-mini-app-confirmation').length,1);
  });
  await run('cancelling keeps the old playable instance and saved progress',async st=>{
    const {page,old,next}=await setup(st);await page.getByRole('button',{name:'核对变化 / 刷新',exact:true}).click();await page.getByRole('button',{name:'取消这次变更',exact:true}).click();
    await next.getByText('此版本未发布',{exact:true}).waitFor();assert.equal((await active.read('old')).writable,true);assert.equal((await active.read('old')).result.snapshot.state.count,19);
    await old.frameLocator('iframe').getByLabel('Starting value').waitFor();
  });
  await run('progress transfer requires a separate choice and preserves the confirmed logical clock after reload',async st=>{
    const plan=counterPlan();plan.migration={fromPlanDigest:answerDataDigest(compileMiniAppPlan(plan).plan),description:'保留已完成的步数，起始值变化只移动计数起点',clock:'preserve'};
    plan.program+='\nfunction migrate(previous,inputs){return {count:previous.state.count+inputs.start-previous.inputs.start};}';
    const {page,next}=await setup(st,plan);await page.getByRole('button',{name:'核对变化 / 刷新',exact:true}).click();
    const mode=page.getByRole('combobox',{name:'任务进度',exact:true});assert.equal(await mode.inputValue(),'reset');await rehearse(next,7);await mode.selectOption('migrate');
    assert.equal(await page.getByRole('button',{name:'确认新版并迁移进度',exact:true}).isDisabled(),true,'Progress mode edit invalidates preview');await next.locator('input[type="number"]').fill('8');
    await rehearse(next,20);await next.getByText('查看数据变化明细',{exact:true}).click();
    await next.getByRole('cell',{name:'19',exact:true}).waitFor();await next.getByRole('cell',{name:'20',exact:true}).waitFor();
    await page.screenshot({path:path.join(directory,'progress-review.png'),fullPage:true});
    await page.setViewportSize({width:420,height:850});
    await page.evaluate(()=>{const style=document.createElement('style');style.textContent=':root{--text:#e8edf0;--bg:#151a20;--bg-panel:#1d242c;--border:#3e4b58;--text-muted:#adbac6;--accent:#71c7e2;}body{background:var(--bg);color:var(--text)}';document.head.append(style);});
    assert.equal(await next.evaluate(node=>node.scrollWidth<=node.clientWidth+1),true,'Narrow preview must stay within the surface');
    const tableStyle=await next.evaluate(node=>{const cell=node.querySelector('td');return {actualColor:getComputedStyle(cell).color,expectedColor:getComputedStyle(node).color,actualFont:getComputedStyle(cell).fontFamily,expectedFont:getComputedStyle(node).fontFamily};});
    assert.equal(tableStyle.actualColor,tableStyle.expectedColor,'Dark table text must follow the surface theme');
    assert.equal(tableStyle.actualFont,tableStyle.expectedFont,'Table text must use the application font');
    await page.screenshot({path:path.join(directory,'progress-review-narrow-dark.png'),fullPage:true});
    await page.getByRole('button',{name:'确认新版并迁移进度',exact:true}).click();await next.frameLocator('iframe').getByLabel('Starting value').waitFor();
    const before=(await active.read()).result.snapshot;assert.equal(before.inputs.start,8);assert.equal(before.state.count,20);assert.equal(before.tick,13);
    assert.equal((await active.read('old')).result.snapshot.state.count,19);assert.equal(posts.length,1);assert.equal(posts[0].progress,'migrate');
    await page.reload();await next.frameLocator('iframe').getByLabel('Starting value').waitFor();assert.deepEqual((await active.read()).result.snapshot,before);
    await page.screenshot({path:path.join(directory,'progress-confirmed.png'),fullPage:true});
  });
  await run('two-view save conflict retains the losing draft through stale cancellation, refresh and further edits',async st=>{
    const {page,old}=await setup(st),other=await page.context().newPage();other.setDefaultTimeout(12_000);
    other.on('pageerror',e=>pageErrors.push(e.message));await other.goto(url);
    const otherOld=other.locator('[data-mini-app-surface]').first(),candidate=other.locator('[data-mini-app-surface]').last();
    const saved=surface=>surface.getByText('已保存 · 后续追问可读取当前状态',{exact:true}).waitFor();
    const edit=async(surface,value)=>{const frame=surface.frameLocator('iframe');await frame.getByLabel('Starting value').fill(String(value));await frame.getByText(String(value),{exact:true}).waitFor();await surface.getByRole('button',{name:'保存',exact:true}).click();};
    await other.getByRole('button',{name:'核对变化 / 刷新',exact:true}).click();await candidate.locator('input[type="number"]').waitFor();
    await edit(old,8);await saved(old);const winning=await active.read('old');
    await edit(otherOld,9);await otherOld.getByText('其他窗口或分支的状态已变化，本机检查点仍已保留。',{exact:true}).waitFor();
    assert.deepEqual((await active.read('old')).result.snapshot,winning.result.snapshot);
    await otherOld.getByRole('button',{name:'保留本机草稿并使用已保存状态',exact:true}).click();
    await otherOld.frameLocator('iframe').getByText('8',{exact:true}).waitFor();
    await other.getByRole('button',{name:'取消这次变更',exact:true}).click();await candidate.getByRole('alert').waitFor();
    assert.equal(active.journal().records.find(r=>r.toolCallId==='new').status,'awaiting_confirmation','Stale cancellation must not publish a decision');
    assert.deepEqual((await active.read('old')).result.snapshot,winning.result.snapshot);
    await other.getByRole('button',{name:'核对变化 / 刷新',exact:true}).click();await candidate.locator('input[type="number"]').waitFor();
    assert.equal(await candidate.locator('input[type="number"]').inputValue(),'8');
    await other.getByRole('button',{name:'取消这次变更',exact:true}).click();await candidate.getByText('此版本未发布',{exact:true}).waitFor();
    await other.reload();await otherOld.getByText('有本机检查点需要核对',{exact:true}).waitFor();
    assert.equal(await otherOld.locator('iframe').count(),0,'Retained conflict draft blocks implicit execution on reload');
    const downloadEvent=other.waitForEvent('download');await otherOld.getByRole('button',{name:'另存检查点',exact:true}).click();
    const download=await downloadEvent,retained=JSON.parse(await readFile(await download.path(),'utf8'));
    assert.equal(retained.checkpoint.inputs.start,9);assert.equal(retained.checkpoint.state.count,9);
    await otherOld.getByRole('button',{name:'保留本机草稿并使用已保存状态',exact:true}).click();await otherOld.frameLocator('iframe').getByText('8',{exact:true}).waitFor();
    await otherOld.frameLocator('iframe').getByRole('button',{name:'Add one',exact:true}).click();await otherOld.frameLocator('iframe').getByText('9',{exact:true}).waitFor();
    await otherOld.getByRole('button',{name:'保存',exact:true}).click();await saved(otherOld);
    const continued=await active.read('old');assert.equal(continued.result.snapshot.inputs.start,8);assert.equal(continued.result.snapshot.state.count,9);
    assert.equal(continued.stateRevision,winning.stateRevision+1);assert.equal(continued.writable,true);
    assert.equal(SessionManager.open(active.file).getEntries().filter(e=>e.customType==='piora-mini-app-confirmation').length,1);
    await other.screenshot({path:path.join(directory,'conflict-cancel-recovered.png'),fullPage:true});
  });
  await run('stale review is recomputed before progress migration and superseded edits remain exportable',async st=>{
    const plan=counterPlan();plan.migration={fromPlanDigest:answerDataDigest(compileMiniAppPlan(plan).plan),description:'Preserve progress relative to the starting value',clock:'preserve'};
    plan.program+='\nfunction migrate(previous,inputs){return {count:previous.state.count+inputs.start-previous.inputs.start};}';
    const {page,old}=await setup(st,plan),other=await page.context().newPage();other.setDefaultTimeout(12_000);
    other.on('pageerror',e=>pageErrors.push(e.message));await other.goto(url);
    const candidate=other.locator('[data-mini-app-surface]').last();
    await other.getByRole('button',{name:'核对变化 / 刷新',exact:true}).click();await candidate.locator('input[type="number"]').waitFor();
    await rehearse(candidate,7);
    await old.frameLocator('iframe').getByLabel('Starting value').fill('10');await old.frameLocator('iframe').getByText('10',{exact:true}).waitFor();
    await old.getByRole('button',{name:'单步',exact:true}).click();await old.frameLocator('iframe').getByText('11',{exact:true}).waitFor();
    await old.getByRole('button',{name:'保存',exact:true}).click();await old.getByText('已保存 · 后续追问可读取当前状态',{exact:true}).waitFor();
    const source=await active.read('old');assert.equal(source.result.snapshot.tick,14);
    await other.getByRole('button',{name:'确认新版并重新开始进度',exact:true}).click();await candidate.getByRole('alert').waitFor();
    assert.equal((await active.read('old')).writable,true);assert.deepEqual((await active.read('old')).result.snapshot,source.result.snapshot);
    await other.getByRole('button',{name:'核对变化 / 刷新',exact:true}).click();await candidate.locator('input[type="number"]').waitFor();
    assert.equal(await candidate.locator('input[type="number"]').inputValue(),'10');await candidate.locator('input[type="number"]').fill('12');
    await other.getByRole('combobox',{name:'任务进度',exact:true}).selectOption('migrate');await rehearse(candidate,13);await other.getByRole('button',{name:'确认新版并迁移进度',exact:true}).click();
    await candidate.frameLocator('iframe').getByText('13',{exact:true}).waitFor();
    const migrated=await active.read();assert.equal(migrated.result.snapshot.inputs.start,12);assert.equal(migrated.result.snapshot.state.count,13);
    assert.equal(migrated.result.snapshot.tick,14);assert.equal(migrated.result.snapshot.rng,source.result.snapshot.rng);
    await old.frameLocator('iframe').getByLabel('Starting value').fill('16');await old.frameLocator('iframe').getByText('16',{exact:true}).waitFor();
    // Editing starts the normal autosave. It can reject and remove the Save
    // button before a second click settles, so observe that actual response.
    await old.getByText('其他窗口或分支的状态已变化，本机检查点仍已保留。',{exact:true}).waitFor();
    assert.deepEqual((await active.read()).result.snapshot,migrated.result.snapshot);assert.deepEqual((await active.read('old')).result.snapshot,source.result.snapshot);
    await other.reload();await candidate.frameLocator('iframe').getByText('13',{exact:true}).waitFor();
    const historical=other.locator('[data-mini-app-surface]').first();await historical.getByText('已有新版本，此版本仅供查看',{exact:true}).waitFor();
    const downloadEvent=other.waitForEvent('download');await historical.getByRole('button',{name:'另存检查点',exact:true}).click();
    const download=await downloadEvent,retained=JSON.parse(await readFile(await download.path(),'utf8'));assert.equal(retained.checkpoint.state.count,16);
    await candidate.frameLocator('iframe').getByRole('button',{name:'Add one',exact:true}).click();await candidate.frameLocator('iframe').getByText('14',{exact:true}).waitFor();
    await candidate.getByRole('button',{name:'保存',exact:true}).click();await candidate.getByText('已保存 · 后续追问可读取当前状态',{exact:true}).waitFor();
    // A new publication starts at revision 0; the first persisted edit takes
    // the next session-wide revision after the last source save.
    assert.equal(migrated.stateRevision,0);
    assert.equal((await active.read()).result.snapshot.state.count,14);assert.equal((await active.read()).stateRevision,source.stateRevision+1);
    assert.equal(SessionManager.open(active.file).getEntries().filter(e=>e.customType==='piora-mini-app-confirmation').length,1);
    await other.screenshot({path:path.join(directory,'conflict-migrate-recovered.png'),fullPage:true});
  });
  assert.deepEqual(pageErrors,[]);
  assert.deepEqual(failures,[]);completed=true;
  console.log(JSON.stringify({directory,status:'passed'}));
});
