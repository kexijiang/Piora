import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,rm,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {createJiti} from 'jiti';
import {chromium} from 'playwright-core';
import {prepareMiniAppRuntime} from '../scripts/prepare-mini-app-runtime.mjs';
const require=createRequire(import.meta.url),repo=path.resolve(import.meta.dirname,'..');
const {webpack}=require('next/dist/compiled/webpack/webpack.js');
const {miniAppRepeatExample}=await createJiti(import.meta.url).import('./mini-app/repeat-example.ts');

test('keyed list preserves native edits, focus and identity through reorder, deletion and saved recreation',{timeout:120_000},async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'piora-mini-repeat-'));let browser,server;
  await mkdir(path.join(repo,'.verification'),{recursive:true});
  const artifacts=await mkdtemp(path.join(repo,'.verification','mini-app-repeat-browser-'));
  const observations=[];
  t.after(async()=>{
    await writeFile(path.join(artifacts,'observations.json'),JSON.stringify({scope:'Real Chromium/Edge Controller, iframe and QuickJS; localStorage checkpoint fixture, not product API or real model',observations},null,2)+'\n');
    await browser?.close();await new Promise(done=>server?server.close(done):done());await rm(directory,{recursive:true,force:true});
  });
  const runtime=path.join(directory,'runtime'),manifest=await prepareMiniAppRuntime(repo,runtime);
  const source=await readFile(path.join(runtime,'renderer.js'),'utf8'),wasm=await readFile(require.resolve('quickjs-wasi/quickjs.wasm'));
  await writeFile(path.join(directory,'entry.ts'),`
    import {MiniAppController} from ${JSON.stringify(path.join(repo,'lib/mini-app/controller.ts'))};
    let host;window.failures=[];
    async function start(restore){host?.stop();host=await MiniAppController.create(document.getElementById('surface'),${JSON.stringify(miniAppRepeatExample())},{
      snapshot:restore?JSON.parse(localStorage.getItem('checkpoint')):undefined,
      onChange(value){window.latest=value;document.getElementById('summary').textContent=value.frame.summary;},
      onStatus(value){document.getElementById('status').textContent=value;},onError(error){window.failures.push(error.code);}
    });}
    document.getElementById('start').onclick=()=>start(false);
    document.getElementById('restore').onclick=()=>start(true);
    document.getElementById('save').onclick=()=>host.withCheckpoint(async snapshot=>{localStorage.setItem('checkpoint',JSON.stringify(snapshot));document.getElementById('saved').textContent='saved';});
  `);
  const compiler=webpack({mode:'development',target:'web',devtool:false,entry:path.join(directory,'entry.ts'),output:{path:directory,filename:'bundle.js',publicPath:'/'},resolve:{extensions:['.ts','.js'],modules:[path.join(repo,'node_modules'),'node_modules']},module:{rules:[{test:/\.ts$/,exclude:/node_modules/,use:path.join(repo,'scripts/mini-app-typescript-loader.cjs')}]}});
  await new Promise((done,fail)=>compiler.run((error,stats)=>compiler.close(()=>error||stats.hasErrors()?fail(error||new Error(stats.toString({all:false,errors:true}))):done())));
  server=createServer(async(req,res)=>{try{
    if(req.url==='/api/mini-app/renderer'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({source,sha256:manifest.sha256}));return;}
    if(req.url.startsWith('/api/mini-app/runtime')){res.setHeader('Content-Type','application/wasm');res.end(wasm);return;}
    if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><title>清单任务验证</title><style>body{font:16px system-ui;max-width:900px;margin:24px auto}</style><button id="start">Start</button><button id="restore">Restore</button><button id="save">Save</button><p id="status"></p><p id="summary"></p><p id="saved"></p><div id="surface"></div><script src="/bundle.js"></script>');return;}
    const name=path.basename(new URL(req.url,'http://localhost').pathname);if(!name.endsWith('.js')){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type','application/javascript');res.end(await readFile(path.join(directory,name)));
  }catch{res.writeHead(404);res.end();}});
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  browser=await chromium.launch({channel:process.platform==='win32'?'msedge':'chromium',headless:true});
  const page=await browser.newPage({viewport:{width:1120,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.getByRole('button',{name:'Start',exact:true}).click();
  const frame=page.frameLocator('iframe'),row=key=>frame.locator(`[data-row-key="${key}"]`);
  await row('task2').getByLabel('事项名称').waitFor();
  const original=await row('task2').elementHandle();
  await row('task2').getByLabel('事项名称').fill('');
  await row('task2').getByLabel('事项名称').pressSequentially('Raincoat and umbrella',{delay:0});
  await page.waitForFunction(()=>window.latest.snapshot.state.items.find(x=>x.key==='task2').title==='Raincoat and umbrella');
  assert.equal(await row('task2').getByLabel('事项名称').inputValue(),'Raincoat and umbrella');
  await row('task2').getByLabel('完成',{exact:true}).check();
  await row('task2').getByLabel('优先级').focus();await page.keyboard.press('Home');await page.keyboard.press('Enter');
  await page.waitForFunction(()=>window.latest.snapshot.state.items.find(x=>x.key==='task2').priority==='high');
  await row('task2').getByRole('button',{name:'上移'}).focus();await page.keyboard.press('Space');
  await page.waitForFunction(()=>window.latest.snapshot.state.items[0].key==='task2');
  await row('task2').getByRole('button',{name:'上移'}).evaluate(element=>{if(document.activeElement!==element)throw new Error('Reordering lost focused row action');});
  assert.equal(await original.evaluate(element=>element===document.querySelector('[data-row-key="task2"]')),true);
  assert.equal(await row('task2').getByLabel('完成',{exact:true}).isChecked(),true);
  observations.push({step:'edited-reordered',snapshot:await page.evaluate(()=>window.latest.snapshot)});
  await page.screenshot({path:path.join(artifacts,'edited-reordered.png')});
  await row('task2').getByRole('button',{name:'删除'}).click();
  await page.waitForFunction(()=>window.latest.snapshot.state.items.length===2);
  await row('task1').getByRole('button',{name:'删除'}).evaluate(element=>{if(document.activeElement!==element)throw new Error('Deletion did not focus the neighboring row');});
  await frame.getByLabel('新增事项',{exact:true}).fill('护照');await frame.getByRole('button',{name:'添加',exact:true}).click();
  await row('task4').getByLabel('事项名称').waitFor();
  await row('task4').getByLabel('完成',{exact:true}).check();
  await page.getByRole('button',{name:'Save',exact:true}).click();await page.waitForFunction(()=>document.getElementById('saved').textContent==='saved');
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('checkpoint')));
  assert.deepEqual(saved.state.items.map(x=>x.key),['task1','task3','task4']);assert.equal(saved.state.items[2].title,'护照');assert.equal(saved.state.items[2].done,true);
  await page.reload();await page.getByRole('button',{name:'Restore',exact:true}).click();
  await row('task4').getByLabel('事项名称').waitFor();
  assert.equal(await row('task4').getByLabel('事项名称').inputValue(),'护照');
  assert.equal(await row('task4').getByLabel('完成',{exact:true}).isChecked(),true);
  assert.deepEqual(await page.evaluate(()=>window.latest.snapshot),saved);
  observations.push({step:'saved-recreated',snapshot:saved});
  for(const key of ['task1','task3','task4']){await row(key).getByRole('button',{name:'删除'}).click();await row(key).waitFor({state:'detached'});}
  assert.equal(await frame.locator('[data-repeat="tasks"]').evaluate(element=>document.activeElement===element),true);
  assert.deepEqual(await page.evaluate(()=>window.latest.snapshot.state.items),[]);
  await frame.getByRole('button',{name:'添加',exact:true}).click();await row('task5').getByLabel('事项名称').waitFor();
  assert.equal(await row('task5').getByLabel('事项名称').inputValue(),'护照');
  observations.push({step:'empty-and-add',snapshot:await page.evaluate(()=>window.latest.snapshot)});
  assert.deepEqual(await page.evaluate(()=>window.failures),[]);assert.deepEqual(errors,[]);
  console.log('Repeat workflow evidence: '+artifacts);
});
