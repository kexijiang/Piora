import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { chromium } from "playwright-core";
import sharp from "sharp";
import { prepareMiniAppRuntime } from "../scripts/prepare-mini-app-runtime.mjs";

const repo=path.resolve(import.meta.dirname,".."), require=createRequire(import.meta.url);
const {webpack}=require("next/dist/compiled/webpack/webpack.js");
test("opaque iframe renders bound SVG, Canvas and real Three.js, forwards local events and blocks host access",{timeout:120_000},async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),"piora-mini-frame-"));let browser,server;
  t.after(async()=>{await browser?.close();await new Promise(done=>server?server.close(done):done());await rm(directory,{recursive:true,force:true});});
  const rendererDir=path.join(directory,"renderer");await prepareMiniAppRuntime(repo,rendererDir);
  const source=await readFile(path.join(rendererDir,"renderer.js"),"utf8"), sha256=createHash("sha256").update(source).digest("hex");
  await writeFile(path.join(directory,"entry.ts"),`
    import {MiniAppFrameHost} from ${JSON.stringify(path.join(repo,"lib/mini-app/frame-host.ts"))};
    import {compileMiniAppDocument,compileMiniAppCss} from ${JSON.stringify(path.join(repo,"lib/mini-app/document.ts"))};
    let host;window.events=[];window.failures=[];
    const document=compileMiniAppDocument({html:'<section class="grid"><div><h2>Geometry</h2><button data-event="activate">Activate</button><input type="number" data-input="amount" aria-label="Amount"><p data-text="result"></p><svg viewBox="0 0 200 100" width="200" height="100"><circle r="10" fill="blue" data-bind="cx:x;cy:y" data-event="point"></circle></svg></div><div data-viewport="plot"></div><div data-viewport="world" data-event="world" tabindex="0"></div></section>',css:'.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;color:var(--text)}'}, {inputs:['amount'],viewports:['plot','world']});
    document.css+=compileMiniAppCss('input[data-input]{border-width:3px}');
    const views=[{id:'plot',kind:'canvas2d',width:200,height:100,label:'Plot'},{id:'world',kind:'scene3d',width:320,height:200,label:'Cube'}];
    const frame=angle=>({summary:'Area and cube',bindings:{result:'Area: 10',x:40,y:40},canvases:{plot:[{kind:'rect',x:0,y:0,width:50,height:50,fill:'red'}]},scenes:{world:{camera:{position:[4,3,5],target:[0,0,0],fov:45},meshes:[{id:'cube',geometry:{kind:'box',size:[2,2,2]},position:[0,0,0],rotation:[0,angle,0],scale:[1,1,1],color:'#246a84'}]}}});
    window.start=async()=>{host=await MiniAppFrameHost.create(window.document.getElementById('surface'),{onEvent:event=>window.events.push(event),onError:error=>window.failures.push(error.code)});host.setDocument({document,inputs:{amount:2},viewports:views});host.render(frame(0),{amount:2});};
    window.rotate=()=>host.render(frame(1),{amount:7});
    window.inputProjection=(amount,ack,label)=>host.render({...frame(0),bindings:{result:label,x:40,y:40}},{amount},{revision:1,ack});
    window.flood=()=>{for(let i=0;i<1000;i++)host.render({...frame(1),bindings:{result:'Frame '+i,x:40,y:40}},{amount:7});};
    window.shutdown=()=>host.dispose();
    window.preview=async()=>{host=await MiniAppFrameHost.create(window.document.getElementById('surface'),{onEvent:event=>window.events.push(event),onError:error=>window.failures.push(error.code)});host.setDocument({document,inputs:{amount:2},viewports:views,readOnly:true});};
    window.rejectFrame=()=>{try{host.render({...frame(0),bindings:{result:'x',x:Infinity,y:3}},{amount:2});return false}catch{return true}};
    window.document.getElementById('start').onclick=window.start;window.document.getElementById('rotate').onclick=window.rotate;window.document.getElementById('stop').onclick=window.shutdown;
  `);
  const compiler=webpack({mode:"development",target:"web",devtool:false,entry:path.join(directory,"entry.ts"),output:{path:directory,filename:"bundle.js"},resolve:{extensions:[".ts",".js"],modules:[path.join(repo,"node_modules"),"node_modules"]},module:{rules:[{test:/\.ts$/,exclude:/node_modules/,use:path.join(repo,"scripts/mini-app-typescript-loader.cjs")}]}});
  await new Promise((done,fail)=>compiler.run((error,stats)=>compiler.close(()=>error||stats.hasErrors()?fail(error||new Error(stats.toString({all:false,errors:true}))):done())));
  let forbiddenRequests=0;
  server=createServer(async(req,res)=>{
    if(req.url==='/api/mini-app/renderer'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({source,sha256}));return;}
    if (/^\/fonts\/inter\/inter-latin-(400-normal|400-italic|500-normal|600-normal)\.woff2$/.test(req.url ?? '')) {
      res.setHeader('Content-Type','font/woff2');res.end(await readFile(path.join(repo,'public',req.url)));return;
    }
    if(req.url==='/secret'){forbiddenRequests++;res.end('secret');return;}
    if(req.url==='/bundle.js'){res.setHeader('Content-Type','application/javascript');res.end(await readFile(path.join(directory,'bundle.js')));return;}
    res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><button id="start">Start</button><button id="rotate">Rotate</button><button id="stop">Stop</button><div id="surface"></div><script src="/bundle.js"></script>');
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  browser=await chromium.launch({channel:process.platform==='win32'?'msedge':'chromium',headless:true,args:['--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1000,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  const origin=`http://127.0.0.1:${server.address().port}`;await page.goto(origin);await page.click('#start');
  const surface=page.frameLocator('iframe');await surface.getByText('Area: 10',{exact:true}).waitFor();
  assert.equal(await surface.getByLabel('Amount').evaluate(input=>getComputedStyle(input).borderLeftWidth),'3px','Binding attribute selectors affect the actual rendered control');
  assert.equal(await page.locator('iframe').getAttribute('sandbox'),'allow-scripts');
  const frame=page.frames().find(frame=>frame.parentFrame());assert.ok(frame);
  assert.equal(await frame.evaluate(()=>{try{return parent.location.href}catch{return 'denied'}}),'denied');
  assert.equal(await frame.evaluate(()=>{try{return localStorage.getItem('x')}catch{return 'denied'}}),'denied');
  assert.equal(await frame.evaluate(async url=>{try{await fetch(url);return 'allowed'}catch{return 'denied'}},origin+'/secret'),'denied');
  assert.equal(forbiddenRequests,0);
  const pixel=await surface.getByRole('img',{name:'Plot'}).evaluate(canvas=>Array.from(canvas.getContext('2d').getImageData(10,10,1,1).data));assert.deepEqual(pixel,[255,0,0,255]);
  await t.test('native buttons retain one keyboard activation for Space and Enter',async()=>{
    for(const key of ['Space','Enter']){
      const start=await page.evaluate(()=>window.events.length);
      await surface.getByRole('button',{name:'Activate',exact:true}).press(key);
      await page.waitForFunction(start=>window.events.slice(start).some(e=>e.type==='keyup'&&e.id==='activate'),start);
      // Let the same browser input task finish delivering the native click.
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const clicks=await page.evaluate(start=>window.events.slice(start).filter(e=>e.id==='activate'&&e.type==='click'),start);
      assert.equal(clicks.length,1,`${key} must activate the native button exactly once`);
    }
  });
  await t.test('SVG pointer coordinates follow painted geometry through letterboxing and viewport transforms',async()=>{
    const svg=surface.locator('svg'),point=surface.locator('circle');
    for(const layout of [
      {width:400,height:100,viewBox:'10 20 200 100',transform:''},
      {width:200,height:240,viewBox:'-50 -20 200 100',transform:'translate(13 9) scale(0.9)'},
    ]){
      await svg.evaluate((node,layout)=>{for(const [key,value]of Object.entries(layout))node.setAttribute(key,String(value));},layout);
      await point.scrollIntoViewIfNeeded();
      const box=await point.boundingBox();assert.ok(box);
      const start=await page.evaluate(()=>window.events.length);
      // The independent expected point is the painted circle centre (40,40),
      // not a second implementation of the renderer's coordinate conversion.
      await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.up();
      await page.waitForFunction(start=>window.events.slice(start).some(e=>e.type==='pointerup'&&e.id==='point'),start);
      const emitted=await page.evaluate(start=>window.events.slice(start).filter(e=>e.id==='point'&&['pointerdown','pointerup'].includes(e.type)),start);
      assert.equal(emitted.length,2);
      for(const event of emitted){assert.ok(Math.abs(event.x-40)<1,`Painted centre x: ${event.x}`);assert.ok(Math.abs(event.y-40)<1,`Painted centre y: ${event.y}`);}
    }
    await svg.evaluate(node=>{node.setAttribute('width','200');node.setAttribute('height','100');node.setAttribute('viewBox','0 0 200 100');node.removeAttribute('transform');});
  });
  const cube=surface.getByRole('img',{name:'Cube'});const before=await cube.screenshot();
  const stats=await sharp(before).stats();assert.ok(stats.channels.some(channel=>channel.stdev>10),'A visible 3D object must be rendered');
  await surface.getByLabel('Amount').fill('7');
  await page.waitForFunction(()=>window.events.some(e=>e.type==='input'&&e.id==='amount'&&e.value===7));
  const firstInput=await page.evaluate(()=>window.events.findLast(e=>e.type==='input'));
  assert.ok(Number.isSafeInteger(firstInput.serial)&&firstInput.serial>0);
  await page.evaluate(()=>window.inputProjection(2,0,'Old input projection'));
  await surface.getByText('Old input projection',{exact:true}).waitFor();
  assert.equal(await surface.getByLabel('Amount').inputValue(),'7','An unacknowledged native edit survives an older frame');
  await surface.getByLabel('Amount').fill('9');
  await page.waitForFunction(()=>window.events.some(e=>e.type==='input'&&e.value===9));
  const secondInput=await page.evaluate(()=>window.events.findLast(e=>e.type==='input'));
  assert.ok(secondInput.serial>firstInput.serial);
  await page.evaluate(ack=>window.inputProjection(7,ack,'First edit acknowledged'),firstInput.serial);
  await surface.getByText('First edit acknowledged',{exact:true}).waitFor();
  assert.equal(await surface.getByLabel('Amount').inputValue(),'9','Acknowledging an earlier edit cannot overwrite a later edit');
  await page.evaluate(ack=>window.inputProjection(8,ack,'Latest edit acknowledged'),secondInput.serial);
  await surface.getByText('Latest edit acknowledged',{exact:true}).waitFor();
  assert.equal(await surface.getByLabel('Amount').inputValue(),'8','Once acknowledged the authoritative host value applies');
  await surface.getByLabel('Amount').fill('7');
  await page.click('#rotate');await surface.getByLabel('Amount').waitFor();
  await page.waitForFunction(()=>window.failures.length===0);
  await page.waitForTimeout(100);
  const after=await cube.screenshot();assert.notEqual(createHash('sha256').update(before).digest('hex'),createHash('sha256').update(after).digest('hex'),'Rotation changes the actual WebGL scene');
  await page.evaluate(()=>{
    const root=document.documentElement;root.classList.add('dark');root.dataset.theme='dark';
    root.style.setProperty('--bg','#101820');root.style.setProperty('--text','#f1f5f9');root.style.setProperty('--accent','#6dd5fa');
    root.style.setProperty('--ui-font-size','24px');root.style.setProperty('--ui-font-weight','700');root.style.setProperty('--ui-font-family','Inter, sans-serif');
  });
  await frame.waitForFunction(()=>getComputedStyle(document.body).fontSize==='24px'&&getComputedStyle(document.body).backgroundColor==='rgb(16, 24, 32)');
  assert.equal(await frame.evaluate(()=>getComputedStyle(document.body).color),'rgb(241, 245, 249)');
  assert.equal(await surface.getByLabel('Amount').evaluate(input=>getComputedStyle(input).fontWeight),'700');
  assert.equal(await surface.getByLabel('Amount').inputValue(),'7','Changing appearance preserves the input');
  await frame.waitForFunction(()=>document.documentElement.dataset.miniAppFonts==='loaded');
  assert.equal(await frame.evaluate(()=>document.fonts.check('400 16px Inter')),true,'Bundled font bytes load while font-src stays disabled');
  await page.emulateMedia({reducedMotion:'reduce'});
  await frame.waitForFunction(()=>document.documentElement.dataset.reducedMotion==='true');
  await page.setViewportSize({width:420,height:900});
  await frame.waitForFunction(()=>innerWidth<=420);
  assert.equal(await surface.getByLabel('Amount').inputValue(),'7');
  await page.evaluate(()=>{document.documentElement.classList.remove('dark');document.documentElement.style.setProperty('--bg','#ffffff');document.documentElement.style.setProperty('--ui-font-size','14px');});
  await frame.waitForFunction(()=>getComputedStyle(document.body).fontSize==='14px'&&getComputedStyle(document.body).backgroundColor==='rgb(255, 255, 255)');
  assert.equal(await page.evaluate(()=>window.rejectFrame()),true);
  await surface.getByLabel('Amount').evaluate(input=>{input.value='13';input.dispatchEvent(new Event('input',{bubbles:true}));});
  assert.equal(await page.evaluate(()=>window.events.some(e=>e.type==='input'&&e.value===13)),false,'Synthetic input is not a user gesture');
  await page.evaluate(()=>window.flood());await surface.getByText('Frame 999',{exact:true}).waitFor();
  await frame.evaluate(()=>{for(let i=0;i<1000;i++)parent.postMessage({type:'event',event:{type:'action',id:'forged'}},'*');});
  await page.evaluate(()=>window.postMessage({type:'piora-mini-app-frame-ready',nonce:'forged'},'*'));
  assert.equal(await page.evaluate(()=>window.events.some(e=>e.type==='action')),false,'Window messages never become host actions');
  await page.click('#stop');assert.equal(await page.locator('iframe').count(),0);
  await page.evaluate(()=>window.preview());
  const preview=page.frameLocator('iframe');await preview.getByRole('img',{name:'Cube'}).waitFor();
  assert.equal(await preview.locator('body').evaluate(body=>getComputedStyle(body).fontSize),'14px','Read-only previews receive the same host appearance');
  assert.equal(await preview.locator('canvas').count(),0,'Layout previews create neither Canvas nor WebGL contexts');
  assert.equal(await preview.locator('#mini-app-root').evaluate(root=>root.inert),true);
  assert.equal(await preview.getByRole('img',{name:'Cube'}).textContent(),'Cube');
  await page.click('#stop');assert.equal(await page.locator('iframe').count(),0);
  assert.deepEqual(await page.evaluate(()=>window.failures),[]);assert.deepEqual(errors,[]);
});
