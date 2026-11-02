import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {createJiti} from 'jiti';
import {chromium} from 'playwright-core';
import {prepareMiniAppRuntime} from '../scripts/prepare-mini-app-runtime.mjs';
const repo=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url),jiti=createJiti(import.meta.url,{alias:{'@':repo}});
const {webpack}=require('next/dist/compiled/webpack/webpack.js');
const {GET,POST}=await jiti.import('../app/api/mini-app/environment/route.ts');
const {writeBetaFeatures}=await jiti.import('./beta-features.ts');
const {miniAppEnvironments}=await jiti.import('./mini-app/environment-store.ts');
const {readMiniAppCapabilities}=await jiti.import('./mini-app/capability-host.ts');

test('real window probe binds client submission preflight, isolates unsupported windows and revokes closed instances',{timeout:120_000},async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'piora-env-browser-'));await mkdir(path.join(repo,'.verification'),{recursive:true});
  const artifacts=await mkdtemp(path.join(repo,'.verification','mini-app-environment-browser-'));
  const previous=Object.fromEntries(['PI_CODING_AGENT_DIR','NODE_ENV','PIORA_MINI_APP_CAPABILITIES'].map(key=>[key,process.env[key]]));
  process.env.PI_CODING_AGENT_DIR=directory;process.env.NODE_ENV='development';process.env.PIORA_MINI_APP_CAPABILITIES='development';
  writeBetaFeatures({intelligentUi:true},directory);
  let browser,server;const requests=[],runs=[],errors=[];
  t.after(async()=>{
    await browser?.close();await new Promise(done=>server?server.close(done):done());
    await writeFile(path.join(artifacts,'observations.json'),JSON.stringify({scope:'Real Edge/Chromium probe, generic client transport and production environment API/store; prompt execution is an HTTP fixture, not RPC/model/desktop; unsupported window uses a null WebGL context fixture',requests,runs,errors},null,2));
    for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    for(const run of runs)miniAppEnvironments().release(run.identity);
    assert.equal(path.dirname(directory),tmpdir());await rm(directory,{recursive:true,force:true});
  });
  const manifest=await prepareMiniAppRuntime(repo),source=await readFile(path.join(repo,'.mini-app-runtime/renderer.js'),'utf8');
  await writeFile(path.join(directory,'entry.ts'),`
    import {sendAgentCommand} from ${JSON.stringify(path.join(repo,'lib/agent-client.ts'))};
    import {stopMiniAppEnvironment} from ${JSON.stringify(path.join(repo,'lib/mini-app/environment-client.ts'))};
    let count=0;window.results=[];window.errors=[];
    document.getElementById('submit').onclick=async()=>{try{const key=crypto.randomUUID();const result=await sendAgentCommand('session-browser',{type:'prompt',idempotencyKey:key,message:'展示空间关系'});window.results.push({key,result});document.getElementById('status').textContent=String(++count);}catch(error){window.errors.push(error.message);}};
    document.getElementById('stop').onclick=()=>stopMiniAppEnvironment();
  `);
  const compiler=webpack({mode:'development',target:'web',devtool:false,entry:path.join(directory,'entry.ts'),output:{path:directory,filename:'bundle.js',publicPath:'/'},resolve:{extensions:['.ts','.js'],modules:[path.join(repo,'node_modules'),'node_modules']},module:{rules:[{test:/\.ts$/,exclude:/node_modules/,use:path.join(repo,'scripts/mini-app-typescript-loader.cjs')}]}});
  await new Promise((done,fail)=>compiler.run((error,stats)=>compiler.close(()=>error||stats.hasErrors()?fail(error||new Error(stats.toString({all:false,errors:true}))):done())));
  server=createServer(async(req,res)=>{try{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks),url=`http://${req.headers.host}${req.url}`;
    if(req.url==='/api/mini-app/environment'){
      const request=new Request(url,{method:req.method,headers:req.headers,...(body.length?{body}:{} )});
      const response=await(req.method==='POST'?POST(request):GET(request));
      if(req.method==='POST')requests.push({body:JSON.parse(body.toString()),status:response.status});
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());return;
    }
    if(req.url==='/api/mini-app/renderer'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({source,sha256:manifest.sha256}));return;}
    if(req.url==='/api/agent/session-browser'){
      const command=JSON.parse(body.toString()),identity={sessionId:'session-browser',runId:'browser-run-'+runs.length,source:'ui',submissionId:command.idempotencyKey};
      miniAppEnvironments().bind(identity);const available=readMiniAppCapabilities(identity).capabilities.find(cap=>cap.id==='scene3d').available;
      runs.push({identity,available});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({success:true,data:{runId:identity.runId,available}}));return;
    }
    if(/^\/fonts\/inter\/inter-latin-(400-normal|400-italic|500-normal|600-normal)\.woff2$/.test(req.url)){res.setHeader('Content-Type','font/woff2');res.end(await readFile(path.join(repo,'public',req.url)));return;}
    if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><button id="submit">Submit</button><button id="stop">Stop environment</button><p id="status"></p><script src="/bundle.js"></script>');return;}
    const file=path.basename(new URL(url).pathname);if(!file.endsWith('.js')){res.writeHead(404);res.end();return;}res.setHeader('Content-Type','application/javascript');res.end(await readFile(path.join(directory,file)));
  }catch(error){errors.push(error.message);res.writeHead(500);res.end('Fixture failed');}});
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  browser=await chromium.launch({channel:process.platform==='win32'?'msedge':'chromium',headless:true,args:['--enable-unsafe-swiftshader']});
  const first=await browser.newPage();first.on('pageerror',error=>errors.push(error.message));await first.goto(`http://127.0.0.1:${server.address().port}`);
  await first.getByRole('button',{name:'Submit',exact:true}).click();await first.waitForFunction(()=>window.results.length===1);
  const result=await first.evaluate(()=>window.results[0]);assert.equal(result.result.available,true);
  assert.equal(requests[0].body.action,'prepare');assert.equal(requests[0].body.submissionId,result.key);assert.equal(requests[0].body.report.webgl,true);assert.equal(requests[0].body.report.rendererDigest,manifest.sha256);
  const original=runs[0].identity;assert.equal(miniAppEnvironments().webgl(original,manifest.sha256),true);
  const context=await browser.newContext();await context.addInitScript(()=>{const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(kind,...args){return kind==='webgl2'?null:original.call(this,kind,...args);};});
  const second=await context.newPage();second.on('pageerror',error=>errors.push(error.message));await second.goto(`http://127.0.0.1:${server.address().port}`);
  await second.getByRole('button',{name:'Submit',exact:true}).click();await second.waitForFunction(()=>window.results.length===1);
  assert.equal(await second.evaluate(()=>window.results[0].result.available),false);assert.equal(miniAppEnvironments().webgl(original,manifest.sha256),true,'another window cannot replace the first binding');
  await first.close();
  const deadline=Date.now()+5000;while(miniAppEnvironments().webgl(original,manifest.sha256)&&Date.now()<deadline)await new Promise(done=>setTimeout(done,20));
  assert.equal(miniAppEnvironments().webgl(original,manifest.sha256),false,'pagehide must revoke the original environment in this browser run');
  writeBetaFeatures({intelligentUi:false},directory);
  await second.getByRole('button',{name:'Submit',exact:true}).click();await second.waitForFunction(()=>window.results.length===2);
  assert.equal(await second.evaluate(()=>window.results[1].result.available),false);assert.equal(await second.locator('iframe').count(),0);
  assert.deepEqual(await second.evaluate(()=>window.errors),[]);assert.deepEqual(errors,[]);
  console.log('Environment workflow evidence: '+artifacts);
});
