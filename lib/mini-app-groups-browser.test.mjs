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
const {miniAppSceneGroupsExample}=await createJiti(import.meta.url).import('./mini-app/scene-groups-example.ts');

test('nested transforms raycast at the independently calculated position and survive restore, reparent and deletion',{timeout:120_000},async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'piora-mini-groups-'));let browser,server;const errors=[];
  await mkdir(path.join(repo,'.verification'),{recursive:true});
  const artifacts=await mkdtemp(path.join(repo,'.verification','mini-app-groups-browser-')),observations=[];
  t.after(async()=>{
    const page=browser?.contexts()[0]?.pages()[0];
    if(page&&!page.isClosed()){
      observations.push({step:'final',...await page.evaluate(()=>({failures:window.failures,snapshot:window.latest?.snapshot})).catch(()=>({unavailable:true}))});
      await page.screenshot({path:path.join(artifacts,'final.png')}).catch(()=>{});
    }
    await writeFile(path.join(artifacts,'observations.json'),JSON.stringify({scope:'Hand-authored development fixture, real Controller/QuickJS/iframe and software WebGL; UI actions with localStorage checkpoint fixture, not real model, production save API or native GPU acceptance',observations,errors},null,2)+'\n');
    await browser?.close();await new Promise(done=>server?server.close(done):done());
    assert.equal(path.dirname(directory),path.resolve(tmpdir()));await rm(directory,{recursive:true,force:true});
  });
  const rendererDir=path.join(directory,'renderer'),manifest=await prepareMiniAppRuntime(repo,rendererDir);
  const source=await readFile(path.join(rendererDir,'renderer.js'),'utf8');
  const wasm=await readFile(path.join(rendererDir,'quickjs.wasm')),plan=miniAppSceneGroupsExample();
  plan.inputs.push({id:'mode',label:'Topology',meaning:'Hand-authored topology test mode',type:'select',value:'normal',options:[{value:'normal',label:'Normal'},{value:'reverse',label:'Reverse parents'},{value:'detached',label:'Detach parts'},{value:'deleted',label:'Delete parts'}]});
  plan.inputPresets=[{id:'bodyZero',label:'Zero body only',values:{bodyAngle:0}},{id:'zero',label:'Zero angles',values:{bodyAngle:0,jointAngle:0}}];
  plan.document.html=plan.document.html.replace('</section>','<button data-preset="bodyZero"></button><button data-preset="zero"></button></section>');
  plan.document.html=plan.document.html.replace('<div data-viewport=', '<label>Topology<select data-input="mode"><option value="normal">Normal</option><option value="reverse">Reverse parents</option><option value="detached">Detach parts</option><option value="deleted">Delete parts</option></select></label><div data-viewport=');
  plan.program=plan.program.replace('function project(', 'function originalProject(').replace('function reduce(', 'function originalReduce(')+`
function reduce(state,event,ctx){state=originalReduce(state,event,ctx);if(event.type==="input"&&event.id==="mode")state.selected="";return state;}
function project(state,inputs,ctx){const frame=originalProject(state,inputs,ctx);const scene=frame.scenes.assembly;
 if(inputs.mode==="reverse"){scene.groups[0].parent="joint";scene.groups[0].position=[1,0,0];delete scene.groups[1].parent;scene.groups[1].position=[0,0,0];scene.groups[1].rotation=[0,0,0];}
 if(inputs.mode==="detached"){scene.groups=[];for(const mesh of scene.meshes)delete mesh.parent;}
 if(inputs.mode==="deleted"){scene.groups=scene.groups.slice(0,1);scene.meshes=scene.meshes.slice(0,1);}
 return frame;}`;
  await writeFile(path.join(directory,'entry.ts'),`
import {MiniAppController} from ${JSON.stringify(path.join(repo,'lib/mini-app/controller.ts'))};
const plan=${JSON.stringify(plan)};let host;window.failures=[];
async function start(restore){host?.stop();host=await MiniAppController.create(document.getElementById('surface'),plan,{...(restore?{snapshot:JSON.parse(localStorage.getItem('checkpoint'))}:{}),onChange(result){window.latest=result;},onStatus(status){document.getElementById('status').textContent=status;},onError(error){window.failures.push(error.code);}});}
document.getElementById('start').onclick=()=>start(false);document.getElementById('restore').onclick=()=>start(true);
document.getElementById('save').onclick=async()=>{const button=document.getElementById('save');button.disabled=true;document.getElementById('saved').textContent='';try{await host.withCheckpoint(async snapshot=>{localStorage.setItem('checkpoint',JSON.stringify(snapshot));document.getElementById('saved').textContent='saved';});}finally{button.disabled=false;}};
`);
  const compiler=webpack({mode:'development',target:'web',devtool:false,entry:path.join(directory,'entry.ts'),output:{path:directory,filename:'bundle.js',publicPath:'/'},resolve:{extensions:['.ts','.js'],modules:[path.join(repo,'node_modules'),'node_modules']},module:{rules:[{test:/\.ts$/,exclude:/node_modules/,use:path.join(repo,'scripts/mini-app-typescript-loader.cjs')}]}});
  await new Promise((done,fail)=>compiler.run((error,stats)=>compiler.close(()=>error||stats.hasErrors()?fail(error||new Error(stats.toString({all:false,errors:true}))):done())));
  server=createServer(async(req,res)=>{try{
    if(req.url==='/api/mini-app/renderer'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({source,sha256:manifest.sha256}));return;}
    if(req.url.startsWith('/api/mini-app/runtime')){res.setHeader('Content-Type','application/wasm');res.end(wasm);return;}
    if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>Group transforms</title><button id="start">Start</button><button id="restore">Restore</button><button id="save">Save</button><p id="status"></p><p id="saved"></p><div id="surface"></div><script src="/bundle.js"></script>');return;}
    const name=path.basename(new URL(req.url,'http://localhost').pathname);if(!name.endsWith('.js')){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type','application/javascript');res.end(await readFile(path.join(directory,name)));
  }catch{res.writeHead(404);res.end();}});
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  browser=await chromium.launch({channel:process.platform==='win32'?'msedge':'chromium',headless:true,args:['--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1000,height:900}});page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.getByRole('button',{name:'Start',exact:true}).click();
  const frame=page.frameLocator('iframe'),canvas=frame.getByRole('img',{name:'组合结构',exact:true});
  await canvas.waitFor({state:'visible'});
  for(const id of ['bodyAngle','jointAngle']){await frame.locator(`[data-input="${id}"]`).fill('90');await frame.locator(`[data-input="${id}"]`).press('Tab');}
  await page.waitForFunction(()=>window.latest?.snapshot.inputs.bodyAngle===90&&window.latest?.snapshot.inputs.jointAngle===90);
  // Independent math: the joint is (1.5,0); its local tip (2,0) rotated
  // by 90deg is (0,2). A second 90deg root rotation yields (-2,1.5).
  const pixel=([x,y])=>({x:200+x*150/(9*Math.tan(Math.PI/8)),y:150-y*150/(9*Math.tan(Math.PI/8))});
  await canvas.click({position:pixel([-2,1.5])});await page.waitForFunction(()=>window.latest?.snapshot.state.selected==='tip');
  await canvas.screenshot({path:path.join(artifacts,'nested.png')});
  observations.push({step:'nested-raycast',worldPoint:[-2,1.5,0],selected:await page.evaluate(()=>window.latest.snapshot.state.selected)});
  await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('saved',{exact:true}).waitFor();
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('checkpoint')));
  await page.reload();await page.getByRole('button',{name:'Restore',exact:true}).click();await canvas.waitFor({state:'visible'});
  await page.waitForFunction(()=>window.latest?.snapshot.state.selected==='tip');
  assert.deepEqual(await page.evaluate(()=>window.latest.snapshot),saved);
  await canvas.click({position:pixel([3.5,0])});await page.waitForFunction(()=>window.latest?.snapshot.state.selected==='');
  await canvas.click({position:pixel([-2,1.5])});await page.waitForFunction(()=>window.latest?.snapshot.state.selected==='tip');
  const mode=frame.locator('[data-input="mode"]');
  for(const [index,name] of ['reverse','detached','deleted','normal'].entries()){
    await mode.focus();await page.keyboard.press('Home');
    const steps=name==='normal'?0:index+1;for(let i=0;i<steps;i++)await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
    await page.waitForFunction(mode=>window.latest?.snapshot.inputs.mode===mode,name);
    if(name==='deleted'){
      assert.equal(await frame.getByRole('combobox',{name:/Select object$/}).locator('option[value="tip"]').count(),0);
      await canvas.click({position:pixel([2,0])});await page.waitForFunction(()=>window.latest?.snapshot.state.selected==='');
    }else{
      await canvas.click({position:pixel(name==='normal'?[-2,1.5]:[2,0])});await page.waitForFunction(()=>window.latest?.snapshot.state.selected==='tip');
    }
    observations.push({step:name,selected:await page.evaluate(()=>window.latest.snapshot.state.selected)});
  }
  await frame.getByRole('button',{name:'组合结构 · Rotate right',exact:true}).click();
  await page.waitForFunction(()=>!!window.latest.snapshot.view?.cameras.assembly);
  const camera=await page.evaluate(()=>window.latest.snapshot.view);
  // Negative trust probe only; positive acceptance below uses native clicks.
  await frame.locator('[data-preset="zero"]').evaluate(button=>button.click());
  assert.equal(await frame.locator('[data-input="bodyAngle"]').inputValue(),'90');
  await frame.getByRole('button',{name:'Zero body only',exact:true}).click();
  await page.waitForFunction(()=>window.latest.snapshot.inputs.bodyAngle===0);
  assert.equal(await frame.locator('[data-input="bodyAngle"]').inputValue(),'0');
  assert.equal(await frame.locator('[data-input="jointAngle"]').inputValue(),'90');
  await frame.getByRole('button',{name:'Zero angles',exact:true}).click();
  await page.waitForFunction(()=>window.latest.snapshot.inputs.jointAngle===0);
  assert.equal(await frame.locator('[data-input="jointAngle"]').inputValue(),'0');
  assert.deepEqual(await page.evaluate(()=>window.latest.snapshot.view),camera);
  assert.equal(await page.evaluate(()=>window.latest.snapshot.state.selected),'tip');
  await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('saved',{exact:true}).waitFor();
  const presetSnapshot=await page.evaluate(()=>JSON.parse(localStorage.getItem('checkpoint')));
  await page.reload();await page.getByRole('button',{name:'Restore',exact:true}).click();await canvas.waitFor({state:'visible'});
  await page.waitForFunction(()=>window.latest?.snapshot.inputs.bodyAngle===0);
  assert.deepEqual(await page.evaluate(()=>window.latest.snapshot),presetSnapshot);
  assert.equal(await frame.locator('[data-input="bodyAngle"]').inputValue(),'0');
  assert.equal(await frame.locator('[data-input="jointAngle"]').inputValue(),'0');
  observations.push({step:'presets-and-restore',snapshot:await page.evaluate(()=>window.latest.snapshot)});
  assert.deepEqual(await page.evaluate(()=>window.failures),[]);assert.deepEqual(errors,[]);
});
