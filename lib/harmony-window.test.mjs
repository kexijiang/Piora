import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { spawn } from "node:child_process";
import { createJiti } from "jiti";
const require = createRequire(import.meta.url);
const { mirrorBounds, applyMirrorBounds } = await createJiti(import.meta.url).import("../desktop/src/harmony-window-bounds.ts");
const source = await readFile(new URL("../desktop/src/harmony-windows.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
test("mirror scale shrinks both dimensions in DIP without accumulating roundoff", () => {
  for (const dpi of [1,1.25,1.5,1.75,2]) {
    const area = { x:-800,y:0,width:1600/dpi,height:1000/dpi };
    const base = mirrorBounds(area,.5,100);
    for (const scale of [100,75,50,25]) {
      let bounds = mirrorBounds(area,.5,scale);
      assert.ok(Math.abs(bounds.width-2-(base.width-2)*scale/100)<=1);
      assert.ok(Math.abs(bounds.height-38-(base.height-38)*scale/100)<=1);
      const size = [bounds.width,bounds.height];
      for(let i=0;i<500;i++) { bounds=mirrorBounds(area,.5,scale,{x:bounds.x+1,y:bounds.y+1}); assert.deepEqual([bounds.width,bounds.height],size); }
      assert.ok(bounds.x+ bounds.width<=area.x+area.width+1);
    }
  }
  assert.deepEqual(mirrorBounds({x:0,y:0,width:1600,height:1000},1080/2400,75),mirrorBounds({x:0,y:0,width:1600,height:1000},720/1600,75));
});
test("desktop mirror is single, fenced, and cancels close/switch until recording is saved", async () => {
  const root=await mkdtemp(join(tmpdir(),"piora-mirror-window-"));
  const handlers=new Map(), windows=[];
  class Window extends EventEmitter {
    constructor(options={}) { super();this.options=options;this.bounds=options;this.webContents=new EventEmitter();this.webContents.mainFrame={url:"https://local.test/"};this.webContents.send=()=>{};this.webContents.setWindowOpenHandler=()=>{};this.webContents.setZoomFactor=()=>{};this.webContents.setVisualZoomLevelLimits=async()=>{};windows.push(this); }
    isDestroyed(){return !!this.dead;} getBounds(){return this.bounds;} setBounds(b){this.bounds=b;} setAlwaysOnTop(v){this.top=v;}
    loadURL(url){this.webContents.mainFrame.url=url;return Promise.resolve();} show(){} showInactive(){} hide(){this.hidden=true;} focus(){} restore(){} minimize(){}
    destroy(){this.dead=true;this.emit("closed");} close(){let cancelled=false;this.emit("close",{preventDefault:()=>cancelled=true});if(!cancelled)this.destroy();}
  }
  const area={x:0,y:0,width:1600,height:1000};const screen=new EventEmitter();screen.getPrimaryDisplay=()=>({workArea:area});screen.getDisplayNearestPoint=screen.getDisplayMatching=screen.getPrimaryDisplay;
  const main=new Window(), mainEvent={sender:main.webContents,senderFrame:main.webContents.mainFrame};
  let recording=null, stopFailure=false, stops=0;
  const context={exports:{},require:name=>name==="electron"?{app:{getPath:()=>root},BrowserWindow:Window,screen,Menu:{buildFromTemplate:()=>({popup(){}})},ipcMain:{handle:(id,fn)=>handlers.set(id,fn)}}:name.includes("harmony-window-bounds")?{mirrorBounds,applyMirrorBounds}:require(name),URL,setTimeout,clearTimeout};
  runInNewContext(compiled,context);
  const controller=new context.exports.HarmonyWindows({origin:new URL("https://local.test/"),partition:"fixture",preload:"fixture",main:()=>main,trustedMain:e=>e===mainEvent,workbench(){},request:async(_path,body)=>{if(body){stops++;if(stopFailure)throw Error("disk full");recording=null;return {artifact:{}};}return {recording};}});
  const call=(name,value,event=mainEvent)=>handlers.get("pi:harmony-window-"+name)(event,value);
  const answer=async id=>{for(let i=0;i<100;i++){const w=windows.findLast(w=>!w.dead&&w.webContents.mainFrame.url.endsWith("desktop-message"));if(w){const e={sender:w.webContents,senderFrame:w.webContents.mainFrame};handlers.get("pi:message-finish")(e,id);return;}await new Promise(r=>setTimeout(r,1));}throw Error("dialog missing");};
  try {
    assert.throws(()=>call("open","phone",{sender:{}}),/Untrusted/);
    const state=await call("open","phone");assert.equal(state.scale,75);
    const mirror=windows.at(-1);const event={sender:mirror.webContents,senderFrame:mirror.webContents.mainFrame};
    await call("open","phone");assert.equal(windows.length,2);
    const docked=await call("presentation","sidebar");assert.equal(docked.presentation,"sidebar");assert.equal(mirror.hidden,true);assert.equal(docked.open,true);
    await call("presentation","floating");assert.equal(windows.length,2,"presentation switches keep one native mirror window");
    await call("scale",25);await new Promise(r=>setTimeout(r,80));assert.equal(call("state").scale,25);assert.ok(mirror.bounds.width<200);
    assert.throws(()=>call("scale",40),/Invalid/);
    const before=mirror.bounds;call("frame",{serial:"old",width:1000,height:200},event);assert.equal(mirror.bounds,before);
    call("frame",{serial:"phone",width:1000,height:200},event);await new Promise(r=>setTimeout(r,80));assert.ok(mirror.bounds.width>mirror.bounds.height);
    recording={recordingId:"one",ownerId:state.ownerId,startedAt:new Date().toISOString()};
    const beforeSwitch=windows.length;await call("presentation","sidebar");assert.equal(stops,0);assert.equal(recording.recordingId,"one");await call("presentation","floating");assert.equal(windows.length,beforeSwitch,"switching presentation while recording does not stop or duplicate it");
    const cancel=call("close");assert.equal(call("close"),cancel,"repeated close clicks share one confirmation");await answer("cancel");assert.equal(await cancel,false);assert.equal(call("state").open,true);
    const switchCancel=call("select","other");await answer("cancel");assert.equal((await switchCancel).serial,"phone");
    stopFailure=true;const failed=call("close");await answer("confirm");await answer("done");assert.equal(await failed,false);assert.equal(call("state").open,true);
    stopFailure=false;const closed=call("close");await answer("confirm");assert.equal(await closed,true);assert.equal(call("state").open,false);assert.equal(stops,2);
    await call("open","phone");assert.equal(call("state").scale,25);
    recording={recordingId:"other",ownerId:"agent",startedAt:new Date().toISOString()};
    const leave=call("close");await answer("confirm");await leave;assert.equal(stops,2,"another controller's recording is never stopped");
    const notice={title:"Saved",message:"video.mp4",notificationKey:"recording-one",actions:[{id:"done",label:"Done"}]};
    const first=handlers.get("pi:message-show")(mainEvent,notice);
    assert.equal(await handlers.get("pi:message-show")(mainEvent,notice),null,"one recording result is shown once across windows");
    await answer("done");assert.equal(await first,"done");
    const light=handlers.get("pi:message-show")(mainEvent,{title:"Saved",message:"Copied",presentation:"notice",tone:"success",durationMs:1200,actions:[{id:"done",label:"Close"}]});
    await new Promise(resolve=>setImmediate(resolve));const popup=windows.at(-1);
    assert.equal(popup.options.modal,false);assert.equal(popup.options.focusable,false);assert.equal(popup.options.height,112);
    await answer("done");await light;
    assert.throws(()=>handlers.get("pi:message-show")({sender:{}},notice),/Untrusted/);
  } finally {controller.destroy();await rm(root,{recursive:true,force:true});}
});

test("native Windows mirror dimensions remain stable at 100 through 200 percent DPI",{skip:process.platform!=="win32",timeout:180000},async()=>{
  const root=await mkdtemp(join(tmpdir(),"piora-mirror-dpi-"));
  try {
    const input=await readFile(new URL("../desktop/src/harmony-window-bounds.ts",import.meta.url),"utf8");
    const bounds=ts.transpileModule(input,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    await writeFile(join(root,"bounds.cjs"),bounds);
    await writeFile(join(root,"probe.cjs"),`const {app,BrowserWindow,screen}=require('electron');const assert=require('node:assert/strict');const {mirrorBounds,applyMirrorBounds}=require('./bounds.cjs');app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,frame:false,resizable:false});const area=screen.getPrimaryDisplay().workArea;for(const scale of [100,75,50,25]){for(let i=0;i<80;i++){const expected=mirrorBounds(area,.45,scale,{x:area.x+20+i,y:area.y+20+i});await applyMirrorBounds(w,expected);await new Promise(r=>setTimeout(r,2));const actual=w.getBounds();assert.ok(Math.abs(actual.width-expected.width)<=1,JSON.stringify({actual,expected}));assert.ok(Math.abs(actual.height-expected.height)<=1,JSON.stringify({actual,expected}));}}w.destroy();console.log('mirror-dpi-ok');app.exit(0);}).catch(e=>{console.error(e);app.exit(1);});`);
    for(const dpi of [1,1.25,1.5,1.75,2])await new Promise((resolve,reject)=>{
      const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
      const child=spawn(require('electron'),[join(root,"probe.cjs"),`--force-device-scale-factor=${dpi}`,`--user-data-dir=${join(root,String(dpi))}`],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
      let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);child.on('error',reject);child.on('exit',code=>code===0&&output.includes('mirror-dpi-ok')?resolve():reject(Error(`DPI ${dpi}: ${output}`)));
    });
  }finally{await rm(root,{recursive:true,force:true});}
});
