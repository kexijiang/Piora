import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {createJiti} from 'jiti';
import {chromium} from 'playwright-core';
import {conversionFixture} from './answer-output-conversion-fixtures.mjs';
import {prepareMiniAppRuntime} from '../scripts/prepare-mini-app-runtime.mjs';
const repo=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url),webpack=require('next/dist/compiled/webpack/webpack').webpack;
const jiti=createJiti(import.meta.url,{alias:{'@':repo}});
const outputRoute=await jiti.import('../app/api/sessions/[id]/intelligent-ui/route.ts');
const miniRoute=await jiti.import('../app/api/sessions/[id]/mini-app/route.ts');
const conversionRoute=await jiti.import('../app/api/sessions/[id]/answer-output/conversion/route.ts');
const actionRoute=await jiti.import('../app/api/sessions/[id]/intelligent-ui/actions/route.ts');
test('actual component and iframe controls convert in both directions, survive lost responses and restore on reload',{timeout:120_000},async t=>{
  const directory=await mkdtemp(path.join(repo,'.verification','output-conversion-browser-'));
  let server,browser,active,completed=false,drop=false;const pageErrors=[],posts=[],failures=[];
  t.after(async()=>{await browser?.close();if(server)await new Promise(done=>server.close(done));await writeFile(path.join(directory,'result.json'),JSON.stringify({status:completed?'passed':'failed',scope:'Headless Edge, real React components/iframe/Worker and production API, SDK files; deterministic fixture plans, no model or native desktop',pageErrors,posts,failures},null,2));});
  await prepareMiniAppRuntime(repo);
  const source=await readFile(path.join(repo,'.mini-app-runtime/renderer.js'),'utf8'),wasm=await readFile(path.join(repo,'.mini-app-runtime/quickjs.wasm'));
  const manifest=JSON.parse(await readFile(path.join(repo,'.mini-app-runtime/manifest.json'),'utf8'));
  await writeFile(path.join(directory,'entry.tsx'),`
    import {createRoot} from 'react-dom/client';
    import MiniAppSurface from ${JSON.stringify(path.join(repo,'components/mini-app/MiniAppSurface.tsx'))};
    import IntelligentUiSurface from ${JSON.stringify(path.join(repo,'components/intelligent-ui/IntelligentUiSurface.tsx'))};
    import {I18nProvider} from ${JSON.stringify(path.join(repo,'hooks/useI18n.tsx'))};
    localStorage.setItem('pi-locale','zh-CN');
    fetch('/fixture').then(r=>r.json()).then(c=>createRoot(document.getElementById('root')).render(<I18nProvider>{c.outputs.map(o=><div key={o.toolCallId} data-output={o.toolCallId}>{o.kind==='mini-app'?<MiniAppSurface sessionId={c.sessionId} toolCallId={o.toolCallId} payload={o.payload} snapshot="Counter" envelopeVersion={1}/>:<IntelligentUiSurface sessionId={c.sessionId} toolCallId={o.toolCallId} payload={o.payload} snapshot="Counter" envelopeVersion={2}/>}</div>)}</I18nProvider>));
  `);
  await writeFile(path.join(directory,'css-loader.cjs'),`module.exports=function(source){const names=Object.fromEntries([...source.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]]));return 'const s=document.createElement("style");s.textContent='+JSON.stringify(source)+';document.head.append(s);export default '+JSON.stringify(names)+';';};`);
  const compiler=webpack({mode:'development',target:'web',devtool:false,entry:path.join(directory,'entry.tsx'),output:{path:directory,filename:'app.js'},resolve:{extensions:['.tsx','.ts','.js'],alias:{'@':repo},modules:[path.join(repo,'node_modules'),'node_modules']},module:{rules:[{test:/\.tsx?$/,exclude:/node_modules/,use:path.join(repo,'scripts/mini-app-typescript-loader.cjs')},{test:/\.css$/,use:path.join(directory,'css-loader.cjs')}]}});
  await new Promise((done,fail)=>compiler.run((error,stats)=>compiler.close(()=>error||stats.hasErrors()?fail(error||new Error(stats.toString({all:false,errors:true}))):done())));
  server=createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,`http://${req.headers.host}`);
      if(url.pathname==='/fixture'){res.setHeader('content-type','application/json');res.end(JSON.stringify({sessionId:active.id,outputs:[active.old,active.next].map(o=>({kind:o.kind,toolCallId:o.toolCallId,payload:o.envelope.answerOutput.payload}))}));return;}
      if(url.pathname==='/api/mini-app/renderer'){res.setHeader('content-type','application/json');res.end(JSON.stringify({source,sha256:manifest.sha256}));return;}
      if(url.pathname==='/api/mini-app/runtime'){res.setHeader('content-type','application/wasm');res.end(wasm);return;}
      if(url.pathname.startsWith('/api/sessions/')){
        const parts=[];for await(const part of req)parts.push(part);
        const request=new Request(url,{method:req.method,headers:req.headers,...(['POST','PUT'].includes(req.method)?{body:Buffer.concat(parts)}:{})});
        const conversion=url.pathname.endsWith('/conversion'),route=conversion?conversionRoute:url.pathname.endsWith('/actions')?actionRoute:url.pathname.endsWith('/mini-app')?miniRoute:outputRoute;
        if(conversion&&req.method==='POST')posts.push(JSON.parse(Buffer.concat(parts).toString()));
        const response=await route[req.method](request,active.context);
        if(conversion&&req.method==='POST'&&drop&&response.ok){drop=false;res.writeHead(200,{'content-type':'application/json'});res.end('{"status":');return;}
        res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());return;
      }
      if(url.pathname.endsWith('.js')){res.setHeader('content-type','application/javascript');res.end(await readFile(path.join(directory,path.basename(url.pathname))));return;}
      res.setHeader('content-type','text/html');res.end('<html><head><meta charset="utf-8"><style>:root{--text:#182832;--bg:#fff;--bg-panel:#f7f9fa;--border:#d8dfe3;--text-muted:#516471;--accent:#177b8a;}body{font:14px system-ui;margin:28px;}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
    }catch(error){res.writeHead(500);res.end(String(error));}
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));const url=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({channel:process.platform==='win32'?'msedge':'chromium',headless:true});
  for(const targetKind of ['mini-app','intelligent-ui'])await t.test(targetKind,async st=>{
    active=await conversionFixture(st,{targetKind});const start=posts.length;
    const context=await browser.newContext({viewport:{width:1100,height:1000}}),page=await context.newPage();page.setDefaultTimeout(12_000);page.on('pageerror',e=>pageErrors.push(e.message));
    st.after(async()=>{if(!page.isClosed())await writeFile(path.join(directory,targetKind+'-state.json'),JSON.stringify({body:await page.locator('body').innerText(),pageErrors,posts},null,2));await context.close();});
    try{
      await page.goto(url);const next=page.locator('[data-output="new"]'),old=page.locator('[data-output="old"]');
      const review=next.getByRole('button',{name:'核对切换 / 刷新',exact:true});await review.click();
      const panel=next.getByRole('region',{name:'核对界面切换'});await panel.getByRole('button',{name:'确认切换',exact:true}).waitFor();
      await panel.getByRole('combobox',{name:'为此参数选取旧值 Starting value'}).selectOption('start');
      const expected=targetKind==='mini-app'?3:7;
      assert.equal(await panel.getByRole('spinbutton',{name:'Starting value'}).inputValue(),String(expected));
      await page.screenshot({path:path.join(directory,targetKind+'-review.png'),fullPage:true});
      await panel.getByRole('button',{name:'确认切换',exact:true}).evaluate(button=>button.click());assert.equal(posts.length,start,'synthetic clicks cannot confirm');
      drop=true;await panel.getByRole('button',{name:'确认切换',exact:true}).click();
      await panel.getByRole('alert').filter({hasText:'尚未确认切换成功'}).waitFor();await review.click();
      await page.waitForFunction(()=>!document.querySelector('[aria-label="核对界面切换"]'));
      assert.equal(posts.length,start+1);assert.equal(posts.at(-1).inputs.start,expected);
      await old.getByText(/仅供查看/).first().waitFor();
      if(targetKind==='mini-app')assert.equal(await old.getByRole('spinbutton',{name:/Starting value/}).isDisabled(),true);
      else assert.equal(await old.locator('iframe').count(),0);
      assert.equal((await active.read()).publication.status,'committed');
      await page.reload();
      if(targetKind==='mini-app')await next.frameLocator('iframe').locator('[data-text="count"]').filter({hasText:String(expected)}).waitFor();
      else {await next.getByRole('spinbutton',{name:/Starting value/}).waitFor();assert.equal(await next.getByRole('spinbutton',{name:/Starting value/}).inputValue(),String(expected));}
      await page.screenshot({path:path.join(directory,targetKind+'-restored.png'),fullPage:true});
    }catch(error){failures.push({targetKind,error:String(error)});throw error;}
  });
  assert.deepEqual(pageErrors,[]);assert.deepEqual(failures,[]);completed=true;
});
