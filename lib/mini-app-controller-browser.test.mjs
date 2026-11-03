import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {chromium} from 'playwright-core';
import {prepareMiniAppRuntime} from '../scripts/prepare-mini-app-runtime.mjs';
import {counterPlan,discreteCounterPlan,heldInputPlan} from './mini-app-fixtures.mjs';

const require=createRequire(import.meta.url),repo=path.resolve(import.meta.dirname,'..');
const {webpack}=require('next/dist/compiled/webpack/webpack.js');
test('controller connects UI inputs, pointer and keyboard with Worker state, play/pause, reset and recreation',{timeout:120_000},async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'piora-mini-controller-'));let browser,server;
  t.after(async()=>{await browser?.close();await new Promise(done=>server?server.close(done):done());await rm(directory,{recursive:true,force:true});});
  const rendererDirectory=path.join(directory,'runtime'),manifest=await prepareMiniAppRuntime(repo,rendererDirectory);
  const source=await readFile(path.join(rendererDirectory,'renderer.js'),'utf8');
  const wasm=await readFile(require.resolve('quickjs-wasi/quickjs.wasm'));
  const plan=counterPlan();
  plan.inputPresets=[{id:'startFour',label:'Start from four',values:{start:4}}];
  plan.document.html+='<button data-preset="startFour"></button>';
  plan.document.html+='<div data-event="keys" tabindex="0" aria-label="Key control">Use right arrow</div><svg viewBox="0 0 100 100" width="200" height="200"><circle cx="50" cy="50" r="8" fill="blue" data-event="point"></circle></svg>';
  plan.program=plan.program.replace("event.type==='click'?state.count+1:state.count","event.type==='click'?state.count+1:event.type==='keydown'&&event.key==='ArrowRight'?state.count+1:event.type==='pointermove'&&event.buttons?Math.max(0,Math.round(event.x)):state.count");
  await writeFile(path.join(directory,'entry.ts'),`
    import {MiniAppController} from ${JSON.stringify(path.join(repo,'lib/mini-app/controller.ts'))};
    let plan=${JSON.stringify(plan)};let host,other,saved,release;window.failures=[];window.changes=[];
    const begin=async restore=>{const previous=host;host=undefined;previous?.stop();document.getElementById('status').textContent='loading';host=await MiniAppController.create(document.getElementById('surface'),plan,{snapshot:restore?saved:undefined,onChange:(result,changed)=>{saved=result.snapshot;window.changes.push(changed);document.getElementById('result').textContent=result.frame.summary;},onStatus:status=>document.getElementById('status').textContent=status,onError:error=>window.failures.push(error.code)});};
    document.getElementById('start').onclick=()=>begin(false);document.getElementById('restore').onclick=()=>begin(true);
    document.getElementById('step').onclick=()=>host.step();document.getElementById('play').onclick=()=>host.play();document.getElementById('pause').onclick=()=>host.pause();document.getElementById('reset').onclick=()=>host.reset();document.getElementById('stop').onclick=()=>host.stop();
    window.snapshot=()=>host?.snapshot;window.forge=()=>host.interact({type:'action',id:'save-file'});
    document.getElementById('checkpoint').onclick=()=>host.withCheckpoint(async snapshot=>{document.getElementById('checkpoint-result').textContent=String(snapshot.state.count);await new Promise(resolve=>release=resolve);});
    document.getElementById('release').onclick=()=>release();
    document.getElementById('other').onclick=async()=>{other=await MiniAppController.create(document.getElementById('other-surface'),plan,{onChange:()=>{},onStatus:status=>document.getElementById('other-status').textContent=status,onError:e=>window.failures.push(e.code)});other.play();};
    document.getElementById('stop-other').onclick=()=>other.stop();
    document.getElementById('discrete').onclick=()=>{plan=${JSON.stringify(discreteCounterPlan())};return begin(false);};
    document.getElementById('event-only').onclick=()=>{plan=${JSON.stringify({...counterPlan(),playback:{mode:'none'}})};return begin(false);};
    document.getElementById('lifecycle').onclick=()=>{plan=${JSON.stringify(heldInputPlan())};return begin(false);};
    document.getElementById('graceful-stop').onclick=()=>host.withCheckpoint(async()=>host.stop());
    document.getElementById('restore-held').onclick=()=>{saved={inputs:{},state:{x:77,held:true,drag:true},rng:123456,tick:42};return begin(true);};
    window.simulateVisibility=hidden=>{Object.defineProperty(document,'hidden',{configurable:true,value:hidden});document.dispatchEvent(new Event('visibilitychange'));};
    document.getElementById('simulate-hidden').onclick=()=>window.simulateVisibility(true);
    document.getElementById('simulate-visible').onclick=()=>window.simulateVisibility(false);
  `);
  const compiler=webpack({mode:'development',target:'web',devtool:false,entry:path.join(directory,'entry.ts'),output:{path:directory,filename:'bundle.js',publicPath:'/'},resolve:{extensions:['.ts','.js'],modules:[path.join(repo,'node_modules'),'node_modules']},module:{rules:[{test:/\.ts$/,exclude:/node_modules/,use:path.join(repo,'scripts/mini-app-typescript-loader.cjs')}]}});
  await new Promise((done,fail)=>compiler.run((error,stats)=>compiler.close(()=>error||stats.hasErrors()?fail(error||new Error(stats.toString({all:false,errors:true}))):done())));
  server=createServer(async(req,res)=>{
    try {
      if(req.url==='/api/mini-app/renderer'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({source,sha256:manifest.sha256}));return;}
      if(req.url.startsWith('/api/mini-app/runtime')){res.setHeader('Content-Type','application/wasm');res.end(wasm);return;}
      if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8">'+['start','restore','step','play','pause','reset','stop','checkpoint','release','other','stop-other','discrete','event-only','lifecycle','graceful-stop','restore-held','simulate-hidden','simulate-visible'].map(id=>'<button id="'+id+'">'+id+'</button>').join('')+'<p id="status"></p><p id="result"></p><p id="checkpoint-result"></p><div id="surface"></div><p id="other-status"></p><div id="other-surface"></div><script src="/bundle.js"></script>');return;}
      const name=path.basename(new URL(req.url,'http://localhost').pathname);if(!name.endsWith('.js')){res.writeHead(404);res.end();return;}
      res.setHeader('Content-Type','application/javascript');res.end(await readFile(path.join(directory,name)));
    }catch{res.writeHead(404);res.end();}
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  browser=await chromium.launch({channel:process.platform==='win32'?'msedge':'chromium',headless:true});
  const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.click('#start');
  const count=async value=>page.waitForFunction(expected=>document.getElementById('result').textContent==='Count: '+expected,value);
  await count(2);const frame=page.locator('#surface').frameLocator('iframe');
  await frame.getByLabel('Starting value').fill('7');await count(7);
  assert.equal(await frame.getByLabel('Starting value').evaluate(input=>input===document.activeElement),true);
  await frame.getByRole('button',{name:'Add one'}).click();await count(8);
  await frame.getByLabel('Key control').focus();await page.keyboard.press('ArrowRight');await count(9);
  const circle=await frame.locator('circle').boundingBox(),svg=await frame.locator('svg').boundingBox();
  await page.mouse.move(circle.x+circle.width/2,circle.y+circle.height/2);await page.mouse.down();await page.mouse.move(svg.x+svg.width*.75,svg.y+svg.height*.5,{steps:5});await page.mouse.up();
  // Pointer up is followed by a click; the fixture increments for that click.
  // Checkpoint immediately, without waiting for the last pointer computation.
  await page.click('#checkpoint');await page.waitForFunction(()=>document.getElementById('checkpoint-result').textContent==='76');
  assert.equal(await frame.locator('main').evaluate(root=>root.inert),true);
  await page.click('#step');assert.equal((await page.evaluate(()=>window.snapshot())).state.count,76);
  await page.click('#release');await page.waitForFunction(()=>document.querySelector('iframe')!==null);
  await frame.locator('main').evaluate(root=>new Promise(resolve=>{const poll=()=>root.inert?setTimeout(poll,10):resolve();poll();}));
  await count(76);
  await page.click('#step');await count(77);
  await page.click('#play');await page.waitForFunction(()=>window.snapshot().tick>=5);
  await page.click('#pause');await page.waitForTimeout(80);
  const paused=await page.evaluate(()=>window.snapshot());await page.waitForTimeout(180);assert.deepEqual(await page.evaluate(()=>window.snapshot()),paused);
  await page.evaluate(()=>{document.documentElement.style.setProperty('--ui-font-size','28px');document.documentElement.style.setProperty('--bg','#17202a');});
  const inner=page.frames().find(frame=>frame.parentFrame());
  await inner.waitForFunction(()=>getComputedStyle(document.body).fontSize==='28px');
  assert.deepEqual(await page.evaluate(()=>window.snapshot()),paused,'Theme and font changes do not reinitialize Worker state, rng, or tick');
  await page.click('#restore');await page.waitForFunction(()=>document.getElementById('status').textContent==='paused');await count(paused.state.count);assert.deepEqual(await page.evaluate(()=>window.snapshot()),paused);
  assert.equal(await page.locator('#status').textContent(),'paused');
  await page.click('#play');await page.waitForFunction(()=>document.getElementById('status').textContent==='playing');
  await page.click('#other');await page.waitForFunction(()=>document.getElementById('other-status').textContent==='playing');
  assert.equal(await page.locator('#status').textContent(),'paused','Another player in the same group pauses the first');
  await page.click('#stop-other');
  await page.click('#reset');await count(7);assert.equal((await page.evaluate(()=>window.snapshot())).tick,0);
  await page.click('#play');await page.waitForFunction(()=>document.getElementById('status').textContent==='playing');
  await frame.getByRole('button',{name:'Start from four',exact:true}).click();await count(4);
  assert.equal(await page.locator('#status').textContent(),'paused');
  assert.equal(await frame.getByLabel('Starting value').inputValue(),'4');
  const preset=await page.evaluate(()=>window.snapshot());await page.waitForTimeout(180);
  assert.deepEqual(await page.evaluate(()=>window.snapshot()),preset,'A preset pauses playback and cannot leave a queued step running');
  assert.equal((await page.evaluate(()=>window.changes))[0],false);
  assert.deepEqual(await page.evaluate(()=>window.failures),[]);assert.deepEqual(errors,[]);
  await page.evaluate(()=>window.forge());assert.equal(await page.locator('iframe').count(),0);assert.equal(await page.locator('#status').textContent(),'stopped');
  assert.deepEqual(await page.evaluate(()=>window.failures),['BINDING'],'Forged action is the only expected failure');
  await page.evaluate(()=>{window.failures=[];});
  await page.click('#restore');await page.waitForFunction(()=>document.getElementById('status').textContent==='paused');await count(4);
  assert.deepEqual(await page.evaluate(()=>window.snapshot()),preset,'Restore after rejection keeps the last confirmed preset inputs and progress');
  await page.click('#stop');assert.equal(await page.locator('iframe').count(),0);
  await page.click('#discrete');await count(2);
  await frame.getByRole('button',{name:'Add one'}).click();await count(3);
  const buttonStep=await page.evaluate(()=>window.snapshot());assert.equal(buttonStep.tick,1);
  await page.click('#reset');await count(2);await page.click('#step');await count(3);
  assert.deepEqual(await page.evaluate(()=>window.snapshot()),buttonStep,'Native step button and host step share the entire checkpoint, including tick and rng');
  await page.click('#reset');await count(2);await page.click('#play');await count(5);
  await page.waitForFunction(()=>document.getElementById('status').textContent==='paused');
  const finished=await page.evaluate(()=>window.snapshot());assert.equal(finished.tick,3);
  await page.waitForTimeout(900);assert.deepEqual(await page.evaluate(()=>window.snapshot()),finished,'Terminal completion stops future playback');
  await page.click('#step');await frame.getByRole('button',{name:'Add one'}).click();await page.click('#play');
  assert.deepEqual(await page.evaluate(()=>window.snapshot()),finished,'Completed steps are not run through either entry point');
  await page.click('#restore');await page.waitForFunction(()=>document.getElementById('status').textContent==='paused');await count(5);
  assert.deepEqual(await page.evaluate(()=>window.snapshot()),finished,'Restoring a terminal checkpoint preserves its logical clock');
  await page.click('#reset');await count(2);await page.click('#step');await count(3);
  await page.click('#event-only');await count(2);const eventOnly=await page.evaluate(()=>window.snapshot());
  await page.click('#step');await page.click('#play');await page.waitForTimeout(120);
  assert.deepEqual(await page.evaluate(()=>window.snapshot()),eventOnly,'Event-only apps reject host time transitions');
  await frame.getByRole('button',{name:'Add one'}).click();await count(3);
  assert.equal((await page.evaluate(()=>window.snapshot())).tick,0,'Ordinary event-only clicks do not advance logical time');
  assert.deepEqual(await page.evaluate(()=>window.failures),[]);assert.deepEqual(errors,[]);

  const lifecycleReady=()=>page.waitForFunction(()=>window.snapshot()?.state.x===20&&window.snapshot()?.state.held===false);
  const released=()=>page.waitForFunction(()=>window.snapshot()?.state.held===false&&window.snapshot()?.state.drag===false);
  await t.test('keyboard focus loss clears held state and repeated keydown cannot revive it',async()=>{
    await page.click('#lifecycle');await lifecycleReady();
    const keys=frame.getByLabel('Hold right arrow');await keys.focus();
    await page.keyboard.down('ArrowRight');await page.waitForFunction(()=>window.snapshot().state.held);
    await page.keyboard.press('Tab');await released();
    assert.equal(await frame.getByRole('button',{name:'Other control'}).evaluate(node=>document.activeElement===node),true);
    await keys.focus();await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(80);
    assert.equal((await page.evaluate(()=>window.snapshot())).state.held,false,'Autorepeat after focus loss is not a fresh key press');
    await page.keyboard.up('ArrowRight');await page.click('#step');
    assert.equal((await page.evaluate(()=>window.snapshot())).state.x,20,'A released key cannot keep moving the object');
  });
  await t.test('drag interruption flushes the final position and releases capture before graceful stop',async()=>{
    await page.click('#lifecycle');await lifecycleReady();
    const point=frame.getByLabel('Drag point'),box=await point.boundingBox(),space=await frame.locator('svg').boundingBox();
    // Observe the browser's real pointer id; no input is injected through the controller.
    await point.evaluate(node=>node.addEventListener('pointerdown',event=>node.dataset.lastPointer=String(event.pointerId),{once:true}));
    await point.focus();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
    await page.waitForFunction(()=>window.snapshot().state.drag);
    await page.mouse.move(space.x+space.width*.8,space.y+space.height*.5);
    // Focus leaves the frame while the physical pointer is still held.
    await page.locator('#graceful-stop').focus();
    await released();
    assert.equal(await point.evaluate(node=>node.hasPointerCapture(Number(node.dataset.lastPointer))),false);
    const before=await page.evaluate(()=>window.snapshot());assert.ok(Math.abs(before.state.x-80)<.01,'Pending pointer movement is preserved');
    await page.keyboard.press('Enter');await page.waitForFunction(()=>document.getElementById('status').textContent==='stopped');
    await page.mouse.up();assert.equal(await page.locator('#surface iframe').count(),0);
    assert.deepEqual(await page.evaluate(()=>window.snapshot()),before,'Graceful stop retains the released checkpoint');
    await page.click('#restore');await released();
    assert.deepEqual(await page.evaluate(()=>window.snapshot()),before);
  });
  await t.test('checkpoint recreation releases stale held input and marks cleanup as changed without advancing time',async()=>{
    await page.click('#restore-held');await page.waitForFunction(()=>window.snapshot()?.state.x===77);await released();
    assert.deepEqual(await page.evaluate(()=>window.snapshot()),{inputs:{},state:{x:77,held:false,drag:false},rng:123456,tick:42});
    assert.equal((await page.evaluate(()=>window.changes)).at(-1),true,'Cleanup must reach the dirty-state/save path');
    await page.click('#restore');await page.waitForFunction(()=>document.getElementById('status').textContent==='paused');
    assert.equal((await page.evaluate(()=>window.changes)).at(-1),false,'Already released state is not dirtied merely by recreation');
    await page.click('#step');await page.waitForFunction(()=>window.snapshot().tick===43);
    assert.equal((await page.evaluate(()=>window.snapshot())).state.x,77);
  });
  await t.test('visibility-event fixture pauses playback and the visible session resumes only after a new command',async()=>{
    await page.click('#lifecycle');await lifecycleReady();await page.click('#play');
    await page.waitForFunction(()=>window.snapshot().tick>0);
    await frame.getByLabel('Hold right arrow').focus();await page.keyboard.down('ArrowRight');
    await page.waitForFunction(()=>window.snapshot().state.held&&window.snapshot().state.x>20);
    // Visibility is an explicit OS-event fixture. Keep actual keyboard focus in
    // the frame so this cannot pass through the separate focus-loss handler.
    await page.evaluate(()=>window.simulateVisibility(true));await released();
    await page.waitForFunction(()=>document.getElementById('status').textContent==='paused');
    const hidden=await page.evaluate(()=>window.snapshot());
    await page.waitForTimeout(150);assert.deepEqual(await page.evaluate(()=>window.snapshot()),hidden);
    await page.evaluate(()=>window.simulateVisibility(false));await page.waitForTimeout(100);
    assert.deepEqual(await page.evaluate(()=>window.snapshot()),hidden,'Visibility restoration must not autoplay');
    await page.keyboard.up('ArrowRight');
    await page.click('#play');await page.waitForFunction(tick=>window.snapshot().tick>tick,hidden.tick);
    await page.click('#graceful-stop');await page.waitForFunction(()=>document.getElementById('status').textContent==='stopped');
  });
  assert.deepEqual(await page.evaluate(()=>window.failures),[]);assert.deepEqual(errors,[]);
});
