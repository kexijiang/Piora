import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {createJiti} from 'jiti';
import {chromium} from 'playwright-core';
import {actionRouteFixture,route as actions} from './mini-app-action-route-fixtures.mjs';
import {prepareMiniAppRuntime} from '../scripts/prepare-mini-app-runtime.mjs';
const repo=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url),webpack=require('next/dist/compiled/webpack/webpack').webpack;
const jiti=createJiti(import.meta.url,{alias:{'@':repo}}),state=await jiti.import('../app/api/sessions/[id]/mini-app/route.ts');
const {miniAppEnvelope}=await jiti.import('./mini-app/journal.ts');

test('mini app host actions use native controls, real permissions, disk receipts and restored UI', {timeout:120_000},async t=>{
 const directory=await mkdtemp(path.join(repo,'.verification','mini-app-actions-browser-'));
 let server,browser,completed=false;const errors=[],posts=[];
 const cleanups=[],f=await actionRouteFixture({after:fn=>cleanups.push(fn)});
 t.after(async()=>{await browser?.close();if(server)await new Promise(done=>server.close(done));for(const fn of cleanups)await fn();
  await writeFile(path.join(directory,'result.json'),JSON.stringify({status:completed?'passed':'failed',scope:'Headless Edge, actual React/iframe/Worker, production API and wrapper permission gate, SDK files; fixed inner-session tools, no model/native window',errors,posts},null,2));});
 await prepareMiniAppRuntime(repo);await writeFile(path.join(f.root,'parameters.json'),'{"start":8}');
 const source=await readFile(path.join(repo,'.mini-app-runtime/renderer.js'),'utf8'),wasm=await readFile(path.join(repo,'.mini-app-runtime/quickjs.wasm'));
 const manifest=JSON.parse(await readFile(path.join(repo,'.mini-app-runtime/manifest.json'),'utf8'));
 await writeFile(path.join(directory,'entry.tsx'),`
 import{createRoot}from'react-dom/client';import MiniAppSurface from ${JSON.stringify(path.join(repo,'components/mini-app/MiniAppSurface.tsx'))};
 import{I18nProvider}from ${JSON.stringify(path.join(repo,'hooks/useI18n.tsx'))};
 localStorage.setItem('pi-locale','zh-CN');fetch('/fixture').then(r=>r.json()).then(c=>createRoot(document.getElementById('root')).render(<I18nProvider>{[1,2].map(key=><MiniAppSurface key={key} sessionId={c.id} toolCallId="call" payload={c.payload} snapshot="Counter" envelopeVersion={1}/>)}</I18nProvider>));`);
 await writeFile(path.join(directory,'css-loader.cjs'),`module.exports=function(source){const names=Object.fromEntries([...source.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]]));return 'const s=document.createElement("style");s.textContent='+JSON.stringify(source)+';document.head.append(s);export default '+JSON.stringify(names)+';';};`);
 const compiler=webpack({mode:'development',target:'web',devtool:false,entry:path.join(directory,'entry.tsx'),output:{path:directory,filename:'app.js'},resolve:{extensions:['.tsx','.ts','.js'],alias:{'@':repo},modules:[path.join(repo,'node_modules'),'node_modules']},module:{rules:[{test:/\.tsx?$/,exclude:/node_modules/,use:path.join(repo,'scripts/mini-app-typescript-loader.cjs')},{test:/\.css$/,use:path.join(directory,'css-loader.cjs')}]}});
 await new Promise((done,fail)=>compiler.run((error,stats)=>compiler.close(()=>error||stats.hasErrors()?fail(error||new Error(stats.toString({all:false,errors:true}))):done())));
 server=createServer(async(req,res)=>{try{
  const url=new URL(req.url,`http://${req.headers.host}`);
  if(url.pathname==='/fixture'){const journal=JSON.parse(await readFile(f.journalPath,'utf8'));res.setHeader('content-type','application/json');res.end(JSON.stringify({id:f.id,payload:miniAppEnvelope(journal.records[0]).answerOutput.payload}));return;}
  if(url.pathname==='/api/mini-app/renderer'){res.setHeader('content-type','application/json');res.end(JSON.stringify({source,sha256:manifest.sha256}));return;}
  if(url.pathname==='/api/mini-app/runtime'){res.setHeader('content-type','application/wasm');res.end(wasm);return;}
  if(url.pathname.startsWith('/api/sessions/')){
   const chunks=[];for await(const chunk of req)chunks.push(chunk);
   const isAction=url.pathname.endsWith('/actions');if(isAction&&req.method==='POST')posts.push(JSON.parse(Buffer.concat(chunks).toString()));
   const request=new Request(url,{method:req.method,headers:req.headers,...(['POST','PUT'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});
   const response=await(isAction?actions[req.method]:state[req.method])(request,f.context);
   res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());return;
  }
  if(url.pathname.endsWith('.js')){res.setHeader('content-type','application/javascript');res.end(await readFile(path.join(directory,path.basename(url.pathname))));return;}
  res.setHeader('content-type','text/html');res.end('<html><head><meta charset="utf-8"><style>:root{--text:#182832;--bg:#fff;--bg-panel:#f7f9fa;--border:#d8dfe3;--text-muted:#516471;--accent:#177b8a;}body{font:14px system-ui;margin:28px;}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
 }catch(error){res.writeHead(500);res.end(String(error));}});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));const url=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({channel:process.platform==='win32'?'msedge':'chromium',headless:true});
 const page=await browser.newPage({viewport:{width:1050,height:950}});page.setDefaultTimeout(15_000);page.on('pageerror',error=>errors.push(error.message));
 await page.goto(url);const panel=page.getByRole('region',{name:'操作',exact:true}).first();
 const save=panel.getByRole('button',{name:'保存报告',exact:true});await save.waitFor();
 await page.waitForFunction(()=>document.querySelector('iframe')&&document.querySelector('[data-mini-app-surface]')?.innerText.includes('已暂停'));
 await save.evaluate(button=>button.click());assert.equal(posts.length,0,'Synthetic clicks cannot start host actions');
 await save.click();await panel.getByRole('button',{name:'允许这一次',exact:true}).waitFor();
 await assert.rejects(readFile(path.join(f.root,'report.json')),{code:'ENOENT'});
 await page.screenshot({path:path.join(directory,'approval.png'),fullPage:true});
 await panel.getByRole('button',{name:'允许这一次',exact:true}).click();await panel.getByText('已完成',{exact:true}).waitFor();
 assert.equal(JSON.parse(await readFile(path.join(f.root,'report.json'),'utf8')).checkpoint.state.count,19);
 await panel.getByRole('button',{name:'读取参数',exact:true}).click();await panel.getByRole('button',{name:'采用这些参数',exact:true}).waitFor();
 assert.equal((await f.read()).result.snapshot.state.count,19);
 await page.screenshot({path:path.join(directory,'parameters-review.png'),fullPage:true});
 await panel.getByRole('button',{name:'采用这些参数',exact:true}).click();await panel.getByText('已采用参数',{exact:true}).waitFor();
 for(const index of [0,1])await page.frameLocator('iframe').nth(index).locator('[data-text="count"]').filter({hasText:'27'}).waitFor();
 const after=(await f.read()).result.snapshot;assert.deepEqual(after.inputs,{start:8});assert.equal(after.state.count,27);assert.equal(after.tick,13);assert.equal(after.rng,12345);
 await page.reload();for(const index of [0,1])await page.frameLocator('iframe').nth(index).locator('[data-text="count"]').filter({hasText:'27'}).waitFor();await panel.getByText('已采用参数',{exact:true}).waitFor();
 await page.screenshot({path:path.join(directory,'restored.png'),fullPage:true});
 assert.equal(posts.filter(p=>p.command==='start').length,2);assert.equal(posts.filter(p=>p.command==='apply').length,1);assert.deepEqual(errors,[]);
 completed=true;
});
