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
const {miniAppSceneExample}=await createJiti(import.meta.url).import('./mini-app/scene-example.ts');

test('spatial task raycasts geometry, preserves saved camera and selection, and stops on context loss',{timeout:120_000},async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'piora-mini-scene-'));let browser,server;
  await mkdir(path.join(repo,'.verification'),{recursive:true});
  const artifacts=await mkdtemp(path.join(repo,'.verification','mini-app-scene-browser-'));
  const observations=[];
  t.after(async()=>{
    const page=browser?.contexts()[0]?.pages()[0];
    if(page&&!page.isClosed()) {
      observations.push({step:'final-observation',...await page.evaluate(()=>({failures:window.failures,snapshot:window.latest?.snapshot})).catch(()=>({unavailable:true}))});
      await page.screenshot({path:path.join(artifacts,'final.png')}).catch(()=>{});
    }
    await writeFile(path.join(artifacts,'observations.json'),JSON.stringify({scope:'Real Chromium/Edge Controller, iframe and QuickJS; localStorage checkpoint fixture, software WebGL via SwiftShader; not product API, real model, native desktop or GPU coverage',observations},null,2)+'\n');
    await browser?.close();await new Promise(done=>server?server.close(done):done());await rm(directory,{recursive:true,force:true});
  });
  const runtime=path.join(directory,'runtime'),manifest=await prepareMiniAppRuntime(repo,runtime);
  const source=await readFile(path.join(runtime,'renderer.js'),'utf8'),wasm=await readFile(require.resolve('quickjs-wasi/quickjs.wasm'));
  await writeFile(path.join(directory,'entry.ts'),`
    import {MiniAppController} from ${JSON.stringify(path.join(repo,'lib/mini-app/controller.ts'))};
    let host;window.failures=[];
    async function start(restore){host?.stop();host=await MiniAppController.create(document.getElementById('surface'),${JSON.stringify(miniAppSceneExample())},{
      snapshot:restore?JSON.parse(localStorage.getItem('checkpoint')):undefined,
      onChange(value){window.latest=value;document.getElementById('summary').textContent=value.frame.summary;},
      onStatus(value){document.getElementById('status').textContent=value;},onError(error){window.failures.push(error.code);}
    });}
    document.getElementById('start').onclick=()=>start(false);
    document.getElementById('restore').onclick=()=>start(true);document.getElementById('reset').onclick=()=>host.reset();
    document.getElementById('save').onclick=async()=>{const button=document.getElementById('save');button.disabled=true;document.getElementById('saved').textContent='';try{await host.withCheckpoint(async snapshot=>{localStorage.setItem('checkpoint',JSON.stringify(snapshot));document.getElementById('saved').textContent='saved';});}finally{button.disabled=false;}};
  `);
  const compiler=webpack({mode:'development',target:'web',devtool:false,entry:path.join(directory,'entry.ts'),output:{path:directory,filename:'bundle.js',publicPath:'/'},resolve:{extensions:['.ts','.js'],modules:[path.join(repo,'node_modules'),'node_modules']},module:{rules:[{test:/\.ts$/,exclude:/node_modules/,use:path.join(repo,'scripts/mini-app-typescript-loader.cjs')}]}});
  await new Promise((done,fail)=>compiler.run((error,stats)=>compiler.close(()=>error||stats.hasErrors()?fail(error||new Error(stats.toString({all:false,errors:true}))):done())));
  server=createServer(async(req,res)=>{try{
    if(req.url==='/api/mini-app/renderer'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({source,sha256:manifest.sha256}));return;}
    if(req.url.startsWith('/api/mini-app/runtime')){res.setHeader('Content-Type','application/wasm');res.end(wasm);return;}
    if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>飞机姿态验证</title><style>body{font:16px system-ui;max-width:900px;margin:24px auto}</style><button id="start">Start</button><button id="restore">Restore</button><button id="save">Save</button><button id="reset">Reset task</button><p id="status"></p><p id="summary"></p><p id="saved"></p><div id="surface"></div><script src="/bundle.js"></script>');return;}
    const name=path.basename(new URL(req.url,'http://localhost').pathname);if(!name.endsWith('.js')){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type','application/javascript');res.end(await readFile(path.join(directory,name)));
  }catch{res.writeHead(404);res.end();}});
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  browser=await chromium.launch({channel:process.platform==='win32'?'msedge':'chromium',headless:true,args:['--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1120,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.getByRole('button',{name:'Start',exact:true}).click();
  const frame=page.frameLocator('iframe');
  const canvas=frame.getByRole('img',{name:'飞机与坐标轴',exact:true});
  await frame.getByLabel('飞机与坐标轴 · 选择对象').waitFor();
  await page.waitForFunction(()=>window.latest?.frame.scenes.airspace.meshes.length===4);
  // Independent perspective oracle for a point inside the right wing. It does
  // not call Three.js, the product raycaster or product projection helpers.
  const cam=[5,4,6],world=[1.3,0,.2],norm=v=>{const n=Math.hypot(...v);return v.map(x=>x/n)},dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
  const forward=norm(cam.map(x=>-x)),right=norm([-forward[2],0,forward[0]]),up=[right[1]*forward[2]-right[2]*forward[1],right[2]*forward[0]-right[0]*forward[2],right[0]*forward[1]-right[1]*forward[0]],delta=world.map((x,i)=>x-cam[i]);
  const tan=Math.tan(Math.PI/8),depth=dot(delta,forward);
  const pixel={x:(1+dot(delta,right)/depth/tan/(640/380))*320,y:(1-dot(delta,up)/depth/tan)*190};
  await canvas.click({position:pixel});
  await page.waitForFunction(()=>window.latest.snapshot.state.selected==='aircraft');
  assert.equal(await frame.getByLabel('飞机与坐标轴 · 选择对象').inputValue(),'aircraft');
  observations.push({step:'raycast-wing',pixel,snapshot:await page.evaluate(()=>window.latest.snapshot)});
  await canvas.focus();await page.keyboard.press('ArrowRight');
  await page.waitForFunction(()=>!!window.latest.snapshot.view?.cameras.airspace);
  const camera=await page.evaluate(()=>window.latest.snapshot.view.cameras.airspace.camera);
  assert.notDeepEqual(camera.position,[5,4,6]);
  await frame.getByLabel('绕 X 轴（俯仰）',{exact:true}).fill('90');
  await page.waitForFunction(()=>window.latest.snapshot.inputs.pitch===90);
  assert.deepEqual(await page.evaluate(()=>window.latest.snapshot.view.cameras.airspace.camera),camera);
  assert.deepEqual(await page.evaluate(()=>window.latest.frame.scenes.airspace.meshes[0].rotation),[Math.PI/2,0,0]);
  for(let burst=0;burst<6;burst++){
    await frame.getByLabel('飞机与坐标轴 · 选择对象').focus();await page.keyboard.press('End');await page.keyboard.press('Home');await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
    await page.waitForFunction(()=>window.latest.snapshot.state.selected==='xAxis');
    assert.equal(await frame.getByLabel('飞机与坐标轴 · 选择对象').inputValue(),'xAxis','Late frames cannot roll back the current native selection');
  }
  // Save immediately after a key: the pending camera event must cross the
  // renderer freeze barrier before the checkpoint callback runs.
  await canvas.focus();await page.keyboard.press('+');await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('saved').textContent==='saved'&&!document.getElementById('save').disabled);
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('checkpoint')));
  assert.equal(saved.state.selected,'xAxis');assert.equal(saved.inputs.pitch,90);assert.notDeepEqual(saved.view.cameras.airspace.camera.position,camera.position);
  const before=await canvas.screenshot();await page.screenshot({path:path.join(artifacts,'selected-rotated.png')});
  observations.push({step:'saved',snapshot:saved});
  await page.reload();await page.getByRole('button',{name:'Restore',exact:true}).click();await frame.getByLabel('飞机与坐标轴 · 选择对象').waitFor();
  await page.waitForFunction(()=>window.latest?.snapshot.state.selected==='xAxis');
  assert.deepEqual(await page.evaluate(()=>window.latest.snapshot),saved);
  assert.equal(await frame.getByLabel('飞机与坐标轴 · 选择对象').inputValue(),'xAxis');
  const after=await canvas.screenshot();assert.equal(Buffer.compare(before,after),0,'geometry and camera must render identically after recreation');
  await page.screenshot({path:path.join(artifacts,'restored.png')});
  await frame.getByRole('button',{name:'重新观察初始视角',exact:true}).click();
  await page.waitForFunction(()=>window.latest.snapshot.state.cameraRevision===1);
  assert.deepEqual(await page.evaluate(()=>window.latest.snapshot.view.cameras),{});
  await canvas.focus();await page.keyboard.press('ArrowLeft');await page.waitForFunction(()=>window.latest.snapshot.view?.cameras.airspace?.reset===1);
  // Interrupt a drag with a host checkpoint, then begin another gesture.
  const box=await canvas.boundingBox();await page.mouse.move(box.x+250,box.y+160);await page.mouse.down();await page.mouse.move(box.x+280,box.y+175,{steps:3});
  await page.getByRole('button',{name:'Save',exact:true}).focus();await page.keyboard.press('Enter');await page.mouse.up();
  await page.waitForFunction(()=>document.getElementById('saved').textContent==='saved'&&!document.getElementById('save').disabled);
  const afterBlur=await page.evaluate(()=>window.latest.snapshot.view.cameras.airspace.camera);
  const newBox=await canvas.boundingBox();await page.mouse.move(newBox.x+250,newBox.y+160);await page.mouse.down();await page.mouse.move(newBox.x+290,newBox.y+175,{steps:3});await page.mouse.up();
  await page.waitForFunction(old=>JSON.stringify(window.latest.snapshot.view.cameras.airspace.camera)!==old,JSON.stringify(afterBlur));
  // Existing reset semantics restart task state using the current parameters.
  await page.getByRole('button',{name:'Reset task',exact:true}).click();await page.waitForFunction(()=>window.latest.snapshot.inputs.pitch===90&&window.latest.snapshot.state.selected==='');
  assert.equal(await page.evaluate(()=>window.latest.snapshot.view),undefined);
  await canvas.focus();await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>!!window.latest.snapshot.view?.cameras.airspace);
  for(let i=0;i<65;i++)await page.keyboard.press('+');
  await page.getByRole('button',{name:'Save',exact:true}).click();await page.waitForFunction(()=>!document.getElementById('save').disabled);
  const close=await page.evaluate(()=>window.latest.snapshot.view.cameras.airspace.camera);
  const distance=Math.hypot(...close.position.map((x,i)=>x-close.target[i]));assert.ok(distance>=.05-1e-9&&distance<.063,'Zoom must stop at the near boundary');
  await canvas.focus();for(let i=0;i<65;i++)await page.keyboard.press('-');
  await page.getByRole('button',{name:'Save',exact:true}).click();await page.waitForFunction(()=>document.getElementById('saved').textContent==='saved'&&!document.getElementById('save').disabled);
  const retained=await page.evaluate(()=>window.latest.snapshot);
  // Explicit real WebGL loss extension fixture, not a native hardware fault.
  await canvas.evaluate(element=>{const gl=element.getContext('webgl2'),extension=gl?.getExtension('WEBGL_lose_context');if(!extension)throw new Error('Loss extension unavailable');extension.loseContext();});
  await page.waitForFunction(()=>window.failures.includes('CONTEXT_LOST'));
  assert.deepEqual(await page.evaluate(()=>window.latest.snapshot),retained);
  assert.deepEqual(await page.evaluate(()=>window.failures),['CONTEXT_LOST']);assert.deepEqual(errors,[]);
  observations.push({step:'context-loss-retained',snapshot:retained});
  console.log('Scene workflow evidence: '+artifacts);
});
