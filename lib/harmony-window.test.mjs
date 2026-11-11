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
const { mirrorBounds, applyMirrorBounds, updateMirrorAspectRatio } = await createJiti(import.meta.url).import("../desktop/src/harmony-window-bounds.ts");
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
test("desktop mirrors isolate devices, preserve minimized windows, and fence recording close", { timeout: 30000 }, async () => {
  const root=await mkdtemp(join(tmpdir(),"piora-mirror-window-"));
  const handlers=new Map(), windows=[], handoffTimers=new Map();
  class Window extends EventEmitter {
    constructor(options={}) { super();this.options=options;this.bounds=options;this.webContents=new EventEmitter();this.webContents.mainFrame={url:"https://local.test/"};this.webContents.send=()=>{};this.webContents.setWindowOpenHandler=()=>{};this.webContents.setZoomFactor=()=>{};this.webContents.setVisualZoomLevelLimits=async()=>{};windows.push(this); }
    isDestroyed(){return !!this.dead;} getBounds(){return this.bounds;} setBounds(b){this.bounds=b;this.boundsWrites=(this.boundsWrites??0)+1;} setAlwaysOnTop(v){this.top=v;} setAspectRatio(r, extra){this.ratio=r;this.extra=extra;}
    loadURL(url){this.webContents.mainFrame.url=url;return Promise.resolve();} show(){} showInactive(){} hide(){this.hidden=true;} focus(){} restore(){} minimize(){}
    destroy(){this.dead=true;this.emit("closed");} close(){let cancelled=false;this.emit("close",{preventDefault:()=>cancelled=true});if(!cancelled)this.destroy();}
  }
  const area={x:0,y:0,width:1600,height:1000};const screen=new EventEmitter();screen.getPrimaryDisplay=()=>({workArea:area});screen.getDisplayNearestPoint=screen.getDisplayMatching=screen.getPrimaryDisplay;
  const main=new Window(), mainEvent={sender:main.webContents,senderFrame:main.webContents.mainFrame};
  let recording=null, stopFailure=false, stops=0;
  const context={exports:{},require:name=>name==="electron"?{app:{getPath:()=>root},BrowserWindow:Window,screen,Menu:{buildFromTemplate:()=>({popup(){}})},ipcMain:{handle:(id,fn)=>handlers.set(id,fn)}}:name.includes("harmony-window-bounds")?{mirrorBounds,applyMirrorBounds,updateMirrorAspectRatio}:require(name),URL,
    setTimeout:(callback,ms)=>{const timer=setTimeout(callback,ms);if(ms===30000)handoffTimers.set(timer,callback);return timer;},
    clearTimeout:timer=>{handoffTimers.delete(timer);clearTimeout(timer);},
  };
  runInNewContext(compiled,context);
  const controller=new context.exports.HarmonyWindows({origin:new URL("https://local.test/"),partition:"fixture",preload:"fixture",main:()=>main,trustedMain:e=>e===mainEvent,workbench(){},request:async(_path,body)=>{if(_path.includes("/media/history"))return {artifacts:[{path:new URL(_path,"https://local.test").searchParams.get("serial")+".mp4"}]};if(body){stops++;if(stopFailure)throw Error("disk full");recording=null;return {artifact:{}};}return {recording};}});
  const call=(name,value,event=mainEvent)=>handlers.get("pi:harmony-window-"+name)(event,value);
  const present=async value=>{
    const pending=await call("presentation",value);
    if(pending.pendingPresentation){
      const window=windows.findLast(w=>!w.dead&&w.webContents.mainFrame.url.endsWith("desktop-harmony")&&call("state",undefined,{sender:w.webContents,senderFrame:w.webContents.mainFrame}).serial===pending.serial);
      const event=value==="sidebar"?mainEvent:{sender:window.webContents,senderFrame:window.webContents.mainFrame};
      await call("frame",{serial:pending.serial,width:360,height:720,presentation:value,transition:pending.presentationTransition},event);
    }
    return call("state");
  };
  const answer=async id=>{for(let i=0;i<100;i++){const w=windows.findLast(w=>!w.dead&&w.webContents.mainFrame.url.endsWith("desktop-message"));if(w){const e={sender:w.webContents,senderFrame:w.webContents.mainFrame};handlers.get("pi:message-finish")(e,id);return;}await new Promise(r=>setTimeout(r,1));}throw Error("dialog missing");};
  try {
    await assert.rejects(call("open","phone",{sender:{}}),/Untrusted/);
    const state=await call("open","phone");assert.equal(state.scale,75);
    const mirror=windows.at(-1);const event={sender:mirror.webContents,senderFrame:mirror.webContents.mainFrame};
    call("frame",{serial:"phone",width:360,height:720,chromeHeight:85},event);
    await new Promise(resolve=>setTimeout(resolve,80));
    assert.equal(mirror.extra.height,85);
    call("frame",{serial:"phone",width:360,height:720,chromeHeight:38},event);
    await new Promise(resolve=>setTimeout(resolve,80));
    assert.equal(mirror.extra.height,38,"hiding controls updates the native aspect constraint");
    call("frame",{serial:"phone",width:360,height:720,chromeHeight:-1},event);
    await new Promise(resolve=>setTimeout(resolve,80));
    assert.equal(mirror.extra.height,38,"invalid chrome heights cannot change bounds");
    call("frame",{serial:"phone",width:360,height:720,chromeHeight:85},event);
    await call("open","phone");assert.equal(windows.length,2);
    const handoff=await call("presentation","sidebar");
    assert.equal(handoff.presentation,"floating","keep the old renderer active while the destination connects");
    assert.equal(handoff.pendingPresentation,"sidebar");assert.notEqual(mirror.hidden,true);
    call("frame",{serial:"phone",width:360,height:720,presentation:"sidebar",transition:"stale"});
    assert.equal(call("state").presentation,"floating","late readiness cannot complete a newer handoff");
    call("frame",{serial:"phone",width:360,height:720,presentation:"sidebar",transition:handoff.presentationTransition},event);
    assert.equal(call("state").presentation,"floating","floating renderers cannot acknowledge sidebar readiness");
    call("frame",{serial:"phone",width:360,height:720,presentation:"sidebar",transition:handoff.presentationTransition});
    const docked=call("state");assert.equal(docked.presentation,"sidebar");assert.equal(mirror.hidden,true);assert.equal(docked.open,true);
    await present("floating");assert.equal(windows.length,2,"presentation switches keep one native mirror window");
    const abandoned=await call("presentation","sidebar");
    const [timer,expire]=[...handoffTimers][0];clearTimeout(timer);expire();
    assert.equal(call("state").presentation,"floating");assert.equal(call("state").open,true);
    assert.equal(call("state").presentationFailed,true,"timeout retains the old view and reports the failed move");
    call("frame",{serial:"phone",width:360,height:720,presentation:"sidebar",transition:abandoned.presentationTransition});
    assert.equal(call("state").presentation,"floating","late first frames cannot revive a timed-out handoff");
    await present("floating");
    assert.equal(mirror.options.resizable,true);
    assert.equal(mirror.options.webPreferences.backgroundThrottling,false,"background windows keep timers and decoding active");
    await new Promise(resolve=>setTimeout(resolve,80)); // Let acknowledged frame geometry finish its native bounds update.
    mirror.bounds={...mirror.bounds,width:227,height:538};mirror.emit("resized");
    mirror.emit("moved");await new Promise(r=>setTimeout(r,80));assert.equal(mirror.bounds.height,538);
    const smallBounds={...mirror.bounds}, boundsWrites=mirror.boundsWrites;
    for (const chromeHeight of [38,81,115,81,38,115,85]) {
      call("frame",{serial:"phone",width:360,height:720,chromeHeight},event);
      await new Promise(resolve=>setTimeout(resolve,80));
      assert.deepEqual(mirror.bounds,smallBounds,"toggling or wrapping controls preserves the user's small window bounds");
      assert.equal(mirror.extra.height,chromeHeight,"native drag sizing still follows the visible controls");
    }
    assert.equal(mirror.boundsWrites-boundsWrites,7,"toolbar-only geometry restores bounds once per change without a placement loop");
    mirror.bounds={...mirror.bounds,x:mirror.bounds.x-20,y:mirror.bounds.y+20};mirror.emit("moved");
    const movedBounds={...mirror.bounds};
    call("frame",{serial:"phone",width:360,height:720,chromeHeight:38},event);
    await new Promise(resolve=>setTimeout(resolve,80));
    assert.deepEqual(mirror.bounds,movedBounds,"toolbar updates cannot restore a stale position after the user moves the window");
    assert.throws(()=>call("scale",40),/Invalid/);
    const before=mirror.bounds;call("frame",{serial:"old",width:1000,height:200},event);assert.equal(mirror.bounds,before);
    call("frame",{serial:"phone",width:1000,height:200},event);await new Promise(r=>setTimeout(r,80));assert.ok(mirror.bounds.width>mirror.bounds.height);
    recording={recordingId:"one",ownerId:state.ownerId,startedAt:new Date().toISOString()};
    const beforeSwitch=windows.length;await present("sidebar");assert.equal(stops,0);assert.equal(recording.recordingId,"one");await present("floating");assert.equal(windows.length,beforeSwitch,"switching presentation while recording does not stop or duplicate it");
    const cancel=call("close");assert.equal(call("close"),cancel,"repeated close clicks share one confirmation");await answer("cancel");assert.equal(await cancel,false);assert.equal(call("state").open,true);
    const second=await call("open","other");const other=windows.at(-1);
    const otherEvent={sender:other.webContents,senderFrame:other.webContents.mainFrame};
    assert.notEqual(second.ownerId,state.ownerId);
    assert.equal(call("state",undefined,event).serial,"phone");
    assert.equal(call("state",undefined,otherEvent).serial,"other");
    assert.equal(mirror.dead,undefined);assert.equal(stops,0);
    mirror.emit("minimize");assert.equal(call("state",undefined,event).minimized,true);
    assert.equal(call("state").serial,"other","background window updates do not select another device");
    await call("open","phone");assert.equal(windows.at(-1),other,"reopening a device reuses its renderer");
    mirror.emit("restore");assert.equal(call("state",undefined,event).minimized,false);
    assert.equal(controller.trustedMirror(otherEvent),true);
    assert.equal(await controller.trustedMediaFile(otherEvent,"other.mp4"),true);
    assert.equal(await controller.trustedMediaFile(otherEvent,"phone.mp4"),false,"media access stays within the sender device");
    call("top",true,otherEvent);assert.equal(other.top,true);assert.notEqual(mirror.top,true);
    call("frame",{serial:"phone",width:300,height:900},otherEvent);assert.notEqual(other.ratio,1/3);

    stopFailure=true;const failed=call("close");await answer("confirm");await answer("done");assert.equal(await failed,false);assert.equal(call("state").open,true);
    stopFailure=false;const closed=call("close");await answer("confirm");assert.equal(await closed,true);assert.equal(call("state").open,false);assert.equal(stops,2);
    assert.equal(other.dead,undefined,"closing the recording window leaves the other device open");
    assert.equal(call("state",undefined,otherEvent).open,true);
    // Selecting a previously unseen tablet must preserve an already-visible
    // mirror, both floating and docked; a closed mirror remains closed.
    recording=null;
    await call("select","other");
    const tablet=await call("select","tablet");
    assert.equal(tablet.open,true);assert.equal(tablet.presentation,"floating");
    assert.equal(tablet.serial,"tablet");assert.notEqual(tablet.ownerId,second.ownerId);
    const tabletWindow=windows.at(-1);
    const tabletEvent={sender:tabletWindow.webContents,senderFrame:tabletWindow.webContents.mainFrame};
    call("frame",{serial:"tablet",width:2880,height:1920},tabletEvent);
    assert.equal(tabletWindow.ratio,1.5,"landscape tablets report their own aspect ratio");
    await present("sidebar");
    const windowCount=windows.length;
    const dockedPhone=await call("select","phone");
    assert.equal(dockedPhone.open,true);assert.equal(dockedPhone.presentation,"sidebar");
    assert.equal(call("state",undefined,tabletEvent).open,false,"the previous sidebar no longer claims to be presenting");
    const dockedTablet=await call("select","new-tablet");
    assert.equal(dockedTablet.open,true);assert.equal(dockedTablet.presentation,"sidebar");
    assert.equal(windows.length,windowCount,"docked selection does not create a floating surface");
    const rapid=await Promise.all([call("select","phone"),call("select","tablet"),call("select","new-tablet")]);
    assert.deepEqual(rapid.map(state=>state.serial),["phone","tablet","new-tablet"]);
    assert.equal(call("state").serial,"new-tablet","rapid selections settle in user order");
    await call("close");
    assert.equal((await call("select","unopened")).open,false,"selection alone does not open a closed mirror");
    await call("open","phone");assert.equal(mirror.options.resizable,true);
    recording={recordingId:"other",ownerId:"agent",startedAt:new Date().toISOString()};
    const leave=call("close");await answer("confirm");await leave;assert.equal(stops,2,"another controller's recording is never stopped");
    const notice={title:"Saved",message:"video.mp4",notificationKey:"recording-one",actions:[{id:"done",label:"Done"}]};
    const first=handlers.get("pi:message-show")(mainEvent,notice);
    assert.equal(await handlers.get("pi:message-show")(mainEvent,notice),null,"one recording result is shown once across windows");
    await answer("done");assert.equal(await first,"done");
    const light=handlers.get("pi:message-show")(mainEvent,{title:"Saved",message:"Copied",presentation:"notice",tone:"success",durationMs:1200,actions:[{id:"done",label:"Close"}]});
    await new Promise(resolve=>setImmediate(resolve));const popup=windows.at(-1);
    assert.equal(popup.options.modal,false);assert.equal(popup.options.focusable,false);assert.equal(popup.options.height,76);assert.equal(popup.options.width,300);
    await answer("done");await light;
    recording=null;
    await call("select","handoff-failure-device");await present("sidebar");
    const failedDestination=await call("presentation","floating");
    assert.equal(failedDestination.presentation,"sidebar");
    windows.at(-1).destroy();
    assert.equal(call("state").presentation,"sidebar");assert.equal(call("state").open,true);
    assert.equal(call("state").presentationFailed,true,"a failed destination window must not close the working sidebar");
    assert.throws(()=>handlers.get("pi:message-show")({sender:{}},notice),/Untrusted/);
  } finally {controller.destroy();await rm(root,{recursive:true,force:true});}
});

test("native Windows mirror dimensions remain stable at 100 through 200 percent DPI",{skip:process.platform!=="win32",timeout:180000},async()=>{
  const root=await mkdtemp(join(tmpdir(),"piora-mirror-dpi-"));
  try {
    const input=await readFile(new URL("../desktop/src/harmony-window-bounds.ts",import.meta.url),"utf8");
    const bounds=ts.transpileModule(input,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    await writeFile(join(root,"bounds.cjs"),bounds);
    await writeFile(join(root,"probe.cjs"),`const {app,BrowserWindow,screen}=require('electron');const assert=require('node:assert/strict');const {mirrorBounds,applyMirrorBounds,updateMirrorAspectRatio}=require('./bounds.cjs');app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,frame:false,resizable:false});const area=screen.getPrimaryDisplay().workArea;for(const scale of [100,75,50,25]){for(let i=0;i<80;i++){const expected=mirrorBounds(area,.45,scale,{x:area.x+20+i,y:area.y+20+i});await applyMirrorBounds(w,expected);await new Promise(r=>setTimeout(r,2));const actual=w.getBounds();assert.ok(Math.abs(actual.width-expected.width)<=1,JSON.stringify({actual,expected}));assert.ok(Math.abs(actual.height-expected.height)<=1,JSON.stringify({actual,expected}));}}w.setResizable(true);w.setMinimumSize(180,120);for(const size of [{width:180,height:300},{width:227,height:538}]){w.setBounds({x:area.x+20,y:area.y+20,...size});await new Promise(r=>setTimeout(r,32));const before=w.getBounds();for(const chromeHeight of [38,81,115,81,38,115,85]){await updateMirrorAspectRatio(w,.5,chromeHeight,before);await new Promise(r=>setTimeout(r,16));const after=w.getBounds();for(const key of ['x','y','width','height'])assert.ok(Math.abs(after[key]-before[key])<=1,JSON.stringify({before,after,chromeHeight}));}}w.destroy();console.log('mirror-dpi-ok');app.exit(0);}).catch(e=>{console.error(e);app.exit(1);});`);
    for(const dpi of [1,1.25,1.5,1.75,2])await new Promise((resolve,reject)=>{
      const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
      const child=spawn(require('electron'),[join(root,"probe.cjs"),`--force-device-scale-factor=${dpi}`,`--user-data-dir=${join(root,String(dpi))}`],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
      let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);child.on('error',reject);child.on('exit',code=>code===0&&output.includes('mirror-dpi-ok')?resolve():reject(Error(`DPI ${dpi}: ${output}`)));
    });
  }finally{await rm(root,{recursive:true,force:true});}
});

 test("mirror bounds reserve actual toolbar height without squeezing video", () => {
  for (const chrome of [38,85,115,160]) for (const ratio of [.45, .5, 2]) {
    const area={x:0,y:0,width:1920,height:1080};
    const bounds=mirrorBounds(area,ratio,100,undefined,chrome);
    assert.ok(Math.abs((bounds.width-2)-(bounds.height-chrome)*ratio)<=1);
    assert.ok(bounds.height<=area.height && bounds.width<=area.width);
  }
});
