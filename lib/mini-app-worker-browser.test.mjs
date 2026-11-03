import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const repo = path.resolve(import.meta.dirname, "..");
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const program = `const STEP=1;
function init(inputs,ctx){return {n:2};}
function reduce(state,event,ctx){return {n:state.n+event.amount};}
function advance(state,dt,ctx){return {n:state.n+STEP};}
function project(state,inputs,ctx){return {summary:String(state.n),tick:ctx.tick};}`;

test("real browser Worker with primitive constants computes, restores, stops pending work and leaves the host responsive", { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-mini-worker-"));
  let browser, server;
  t.after(async () => { await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve()); await rm(directory,{recursive:true,force:true}); });
  await writeFile(path.join(directory,"loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;`);
  await writeFile(path.join(directory,"entry.ts"), `
    import { MiniAppWorker } from ${JSON.stringify(path.join(repo,"lib/mini-app/worker-client.ts"))};
    let host, checkpoint={inputs:{},state:null,rng:42,tick:0};
    const normal=${JSON.stringify(program)};
    const status=document.getElementById('status');
    const show=reply=>{checkpoint=reply.snapshot;status.textContent=reply.frame.summary;};
    document.getElementById('start').onclick=async()=>{host?.stop();host=await MiniAppWorker.create(normal);show(await host.run({command:'init',snapshot:checkpoint}));};
    document.getElementById('step').onclick=async()=>show(await host.run({command:'step',snapshot:checkpoint}));
    document.getElementById('change').onclick=async()=>show(await host.run({command:'event',event:{amount:7},snapshot:checkpoint}));
    document.getElementById('restore').onclick=async()=>{host?.stop();host=await MiniAppWorker.create(normal);show(await host.run({command:'project',snapshot:checkpoint}));};
    document.getElementById('stop').onclick=()=>{host?.stop();status.textContent='stopped';};
    document.getElementById('loop').onclick=async()=>{
      host?.stop();host=await MiniAppWorker.create(normal.replace('return {n:2};','while(true){}'));
      status.textContent='running';
      try{await host.run({command:'init',snapshot:checkpoint});status.textContent='unexpected';}catch(error){status.textContent=error.code;}
    };
    let count=0;document.getElementById('host').onclick=()=>document.getElementById('count').textContent=String(++count);
    window.readCheckpoint=()=>checkpoint;
  `);
  const compiler = webpack({ mode:"development", target:"web", devtool:false, entry:path.join(directory,"entry.ts"),
    output:{path:directory,filename:"bundle.js",publicPath:"/"}, resolve:{extensions:[".ts",".js"],modules:[path.join(repo,"node_modules"),"node_modules"]},
    module:{rules:[{test:/\.ts$/,exclude:/node_modules/,use:path.join(directory,"loader.cjs")}]} });
  await new Promise((resolve,reject)=>compiler.run((error,stats)=>compiler.close(()=>error||stats.hasErrors()?reject(error||new Error(stats.toString({all:false,errors:true}))):resolve())));
  const wasm=await readFile(require.resolve("quickjs-wasi/quickjs.wasm"));
  const html=`<!doctype html><meta charset="utf-8"><title>Mini app worker fixture</title><button id="start">Start</button><button id="step">Step</button><button id="change">Change</button><button id="restore">Restore</button><button id="loop">Loop</button><button id="stop">Stop</button><button id="host">Host</button><p id="status"></p><p id="count">0</p><script src="/bundle.js"></script>`;
  server=createServer(async(req,res)=>{
    try {
      if(req.url?.startsWith('/api/mini-app/runtime')){res.setHeader('Content-Type','application/wasm');res.end(wasm);return;}
      if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}
      const name=path.basename(new URL(req.url,'http://localhost').pathname);
      if(!name.endsWith('.js')){res.writeHead(404);res.end();return;}
      res.setHeader('Content-Type','application/javascript');res.end(await readFile(path.join(directory,name)));
    }catch{res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({channel:process.platform==='win32'?'msedge':'chromium',headless:true});
  const page=await browser.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.click('#start');await page.waitForFunction(()=>document.querySelector('#status').textContent==='2');
  await page.click('#change');await page.waitForFunction(()=>document.querySelector('#status').textContent==='9');
  await page.click('#step');await page.waitForFunction(()=>document.querySelector('#status').textContent==='10');
  const before=await page.evaluate(()=>window.readCheckpoint());
  await page.click('#restore');await page.waitForFunction(()=>document.querySelector('#status').textContent==='10');
  assert.deepEqual(await page.evaluate(()=>window.readCheckpoint()),before);
  await page.click('#loop');await page.waitForFunction(()=>document.querySelector('#status').textContent==='running');
  await page.click('#stop');
  await page.waitForFunction(()=>['stopped','STOPPED'].includes(document.querySelector('#status').textContent));
  await page.click('#host');assert.equal(await page.locator('#count').textContent(),'1');
  assert.deepEqual(await page.evaluate(()=>window.readCheckpoint()),before,'failed or stopped execution never replaces the acknowledged checkpoint');
  await page.click('#restore');await page.waitForFunction(()=>document.querySelector('#status').textContent==='10');
  await page.click('#loop');await page.waitForFunction(()=>document.querySelector('#status').textContent==='TIME_LIMIT');
  await page.click('#host');assert.equal(await page.locator('#count').textContent(),'2');
  await page.click('#stop');
  assert.deepEqual(errors,[]);
});
