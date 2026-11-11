import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import ts from "typescript";

const require = createRequire(import.meta.url), repo = path.resolve(import.meta.dirname, "..");
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
async function until(check, label) {
  const deadline=Date.now()+12000;
  while(!await check()) { assert.ok(Date.now()<deadline,label); await new Promise(resolve=>setTimeout(resolve,25)); }
}

test("native small mirror keeps video filled and width stable while controls toggle", { skip: process.platform !== "win32", timeout: 120000 }, async () => {
  const root=await mkdtemp(path.join(tmpdir(),"piora-mirror-resize-"));let desktop,server,native,nativeOutput="";
  try {
    await writeFile(path.join(root,"loader.cjs"),`const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root,"css.cjs"),'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    // Capture/decoding/device input are fixtures. Renderer layout, IPC routing,
    // native window placement and the Electron/Win32 window are production code.
    await writeFile(path.join(root,"stub.tsx"),`import{useEffect,useRef}from"react";
export const useI18n=()=>({locale:"zh-CN"});export const useTheme=()=>({isDark:false});export const useFontPreferences=()=>{};
export const useApplicationShortcuts=()=>({bindings:{}});export const useMirrorInput=()=>({handlers:{},canControl:true,preparing:false,send:async()=>{}});
export const useMirrorMedia=()=>({elapsed:0,recoveries:[],recording:null,transitioning:false,action:async()=>{}});
export function useHarmonyMirror(options){const surfaceRef=useRef(null);useEffect(()=>{const canvas=document.createElement("canvas");canvas.width=360;canvas.height=720;const c=canvas.getContext("2d");c.fillStyle="#468cbe";c.fillRect(0,0,360,720);surfaceRef.current.append(canvas);return()=>canvas.remove();},[]);return{surfaceRef,state:"live",frame:{serial:options.serial,width:360,height:720,generation:1},refresh:()=>{}};}`);
    await writeFile(path.join(root,"entry.tsx"),`import{createRoot}from"react-dom/client";import{MirrorWindow}from"@/components/workspace/harmony/MirrorWindow";createRoot(document.getElementById("root")).render(<MirrorWindow/>);`);
    const aliases=Object.fromEntries(["useI18n","useTheme","useFontPreferences","useApplicationShortcuts","useMirrorInput","useMirrorMedia","useHarmonyMirror"].map(name=>["@/hooks/"+name,path.join(root,"stub.tsx")]));
    const compiler=webpack({mode:"development",target:"web",devtool:false,entry:path.join(root,"entry.tsx"),output:{path:root,filename:"bundle.js",publicPath:"/"},resolve:{extensions:[".tsx",".ts",".js"],modules:[path.join(repo,"node_modules")],alias:{...aliases,"@":repo}},module:{rules:[{test:/\.tsx?$/,exclude:/node_modules/,use:path.join(root,"loader.cjs")},{test:/\.css$/,use:path.join(root,"css.cjs")}]}});
    await new Promise((resolve,reject)=>compiler.run((error,stats)=>compiler.close(()=>error||stats.hasErrors()?reject(error||Error(stats.toString({all:false,errors:true}))):resolve())));
    const css=(await readFile(path.join(repo,"app/globals.css"),"utf8")).replace(/^@import.*$/gm,"")+(await readFile(path.join(repo,"components/workspace/harmony/MirrorWindow.module.css"),"utf8"));
    const bundle=await readFile(path.join(root,"bundle.js"));
    server=createServer((request,response)=>{
      const url=new URL(request.url,"http://localhost");
      if(url.pathname==="/bundle.js"){response.setHeader("content-type","text/javascript");response.end(bundle);return;}
      if(url.pathname.startsWith("/api/")){response.setHeader("content-type","application/json");response.end(JSON.stringify({devices:[{serial:"phone",state:"online",generation:1,capabilities:{screenshot:true}}]}));return;}
      response.setHeader("content-type","text/html");response.end(`<!doctype html><meta charset="utf-8"><style>${css}body{margin:0}</style><div id="root"></div><script src="/bundle.js"></script>`);
    });
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    const origin=`http://127.0.0.1:${server.address().port}`;
    await writeFile(path.join(root,"native-electron.cjs"),`const electron=require("electron");for(const name of ["show","showInactive","focus"])electron.BrowserWindow.prototype[name]=()=>{};module.exports=electron;`);
    for(const name of ["harmony-window-bounds","harmony-windows"]){
      const source=await readFile(path.join(repo,"desktop/src",name+".ts"),"utf8");
      const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText.replace('require("electron")','require("./native-electron.cjs")').replace('require("./harmony-window-bounds.js")','require("./harmony-window-bounds.cjs")');
      await writeFile(path.join(root,name+".cjs"),code);
    }
    await writeFile(path.join(root,"preload.cjs"),`const{contextBridge,ipcRenderer}=require("electron");contextBridge.exposeInMainWorld("fixture",{resize:size=>ipcRenderer.invoke("fixture:resize",size),clearTrace:()=>ipcRenderer.invoke("fixture:clear"),trace:()=>ipcRenderer.invoke("fixture:trace")});contextBridge.exposeInMainWorld("piDesktop",{harmonyMirror:{getState:()=>ipcRenderer.invoke("pi:harmony-window-state"),reportFrame:frame=>{window.reports??=[];window.reports.push(frame);return ipcRenderer.invoke("pi:harmony-window-frame",frame);},onStateChange:listener=>{const handler=(_,state)=>listener(state);ipcRenderer.on("pi:harmony-window-state",handler);return()=>ipcRenderer.removeListener("pi:harmony-window-state",handler);},onCommand:()=>()=>{},setAlwaysOnTop:top=>ipcRenderer.invoke("pi:harmony-window-top",top),setScale:scale=>ipcRenderer.invoke("pi:harmony-window-scale",scale),close:()=>ipcRenderer.invoke("pi:harmony-window-close"),showMenu:()=>{}}});`);
    await writeFile(path.join(root,"main.cjs"),`const{app,BrowserWindow,screen,ipcMain}=require("electron");const{HarmonyWindows}=require("./harmony-windows.cjs");app.setPath("userData",${JSON.stringify(path.join(root,"profile"))});app.whenReady().then(async()=>{const main=new BrowserWindow({show:false});const manager=new HarmonyWindows({origin:new URL(${JSON.stringify(origin)}),partition:"fixture",preload:${JSON.stringify(path.join(root,"preload.cjs"))},main:()=>main,trustedMain:event=>event.sender===main.webContents,request:async()=>({recording:null}),workbench(){}});global.fixture={manager,trace:[],window:()=>manager.devices.get("phone")?.window.mirror,area:()=>screen.getPrimaryDisplay().workArea};await manager.dispatch("pi:harmony-window-open",{sender:main.webContents,senderFrame:main.webContents.mainFrame},"phone");ipcMain.handle("fixture:resize",(_,size)=>{const w=fixture.window(),area=fixture.area();w.setBounds({x:area.x+20,y:area.y+20,width:size.width,height:Math.round((size.width-2)*2)+size.chrome});w.emit("resized");});ipcMain.handle("fixture:clear",()=>{fixture.trace=[];});ipcMain.handle("fixture:trace",()=>fixture.trace);const mirror=fixture.window();mirror.on("resize",()=>fixture.trace.push(mirror.getBounds()));}).catch(error=>{console.error(error);app.exit(1);});`);
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    let endpoint;
    native=spawn(require("electron"),[path.join(root,"main.cjs"),"--remote-debugging-port=0","--disable-background-timer-throttling","--disable-renderer-backgrounding","--disable-backgrounding-occluded-windows"],{env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    const record=data=>{nativeOutput+=data;endpoint??=nativeOutput.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];};
    native.stdout.on("data",record);native.stderr.on("data",record);
    await until(()=>{assert.equal(native.exitCode,null,nativeOutput);return Boolean(endpoint);},"native fixture did not expose CDP");
    desktop=await chromium.connectOverCDP(endpoint);
    let page;
    await until(()=>{page=desktop.contexts().flatMap(context=>context.pages()).find(p=>p.url().includes("/desktop-harmony"));return Boolean(page);},"mirror window did not open");
    const errors=[];page.on("pageerror",error=>errors.push(error.message));
    await page.getByRole("button",{name:"操控手机",exact:true}).waitFor();
    await page.waitForFunction(()=>Boolean(document.querySelector("canvas")));
    const output=path.join(repo,".verification/harmony-mirror-resize-20261111");await mkdir(output,{recursive:true});
    const samples=[];
    for(const width of [180,227,280,310]){
      const chrome=await page.locator(".root").evaluate(root=>Math.round(root.getBoundingClientRect().height-root.querySelector("main").getBoundingClientRect().height));
      await page.evaluate(size=>window.fixture.resize(size),{width,chrome});
      await page.waitForTimeout(150);
      for(let cycle=0;cycle<4;cycle++){
        await page.evaluate(()=>window.fixture.clearTrace());
        await page.getByRole("button",{name:"操控手机",exact:true}).click();
        await page.waitForFunction(()=>{const screen=document.querySelector("main").getBoundingClientRect();return Math.abs(screen.width-screen.height*.5)<=2;});
        // Hidden native windows need not paint at the monitor refresh rate.
        // Sample settled renderer layout while the main process separately
        // records every native resize, including any short-lived width bounce.
        const frames=await page.evaluate(()=>new Promise(resolve=>{const frames=[];const sample=()=>{const root=document.querySelector(".root").getBoundingClientRect(),main=document.querySelector("main").getBoundingClientRect();frames.push({width:root.width,height:root.height,screenWidth:main.width,screenHeight:main.height});if(frames.length<16)setTimeout(sample,16);else resolve(frames);};sample();}));
        const trace=await page.evaluate(()=>window.fixture.trace());
        const last=frames.at(-1);samples.push({width,cycle,frames,trace});
        await writeFile(path.join(output,"native-frames.json"),JSON.stringify(samples,null,2));
        assert.ok(Math.abs(last.screenWidth-last.screenHeight*.5)<=2,`video must fill its area after controls toggle at ${width}: ${JSON.stringify(last)}`);
        assert.ok(trace.every(bounds=>Math.abs(bounds.width-width)<=1),`native width must not bounce as controls wrap at ${width}: ${JSON.stringify(trace)}`);
        assert.ok(frames.slice(-6).every(frame=>Math.abs(frame.height-last.height)<=1&&Math.abs(frame.screenHeight-last.screenHeight)<=1),"layout must settle without alternating frame sizes");
      }
    }
    assert.deepEqual(errors,[]);
  }catch(error){
    throw new Error(`${error.stack ?? error}\nNative fixture: ${nativeOutput}`);
  }finally{
    await desktop?.close();
    if(native?.exitCode===null){const exited=new Promise(resolve=>native.once("exit",resolve));native.kill();await exited;}
    await new Promise(resolve=>server?server.close(resolve):resolve());
    assert.equal(path.dirname(root),path.resolve(tmpdir()));assert.ok(path.basename(root).startsWith("piora-mirror-resize-"));await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  }
});
