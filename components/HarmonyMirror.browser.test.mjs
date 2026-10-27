import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("mirror is read-only, resizes through the desktop bridge, and shows common messages", { timeout: 120000 }, async () => {
  const root=await mkdtemp(path.join(tmpdir(),"piora-mirror-ui-"));let browser, recording = null, completion = null;
  try {
    await writeFile(path.join(root,"loader.cjs"),`const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root,"css.cjs"),'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    await writeFile(path.join(root,"stub.tsx"),`import {useEffect} from "react";export const useI18n=()=>({locale:"zh-CN"});export const AliIcon=({name})=><span>{name==="save"?"▣":name==="close"?"×":"●"}</span>;export const useHarmonyLiveFrame=o=>{window.frameOptions={active:o.active,serial:o.serial};useEffect(()=>{const c=o.canvasRef.current;c.width=360;c.height=720;const g=c.getContext("2d");g.fillStyle="#eef3fa";g.fillRect(0,0,360,720);g.fillStyle="#243047";g.font="24px sans-serif";g.fillText("设置 · 示例画面",24,80);g.font="16px sans-serif";["无线网络","蓝牙","显示与亮度","声音和振动","通知","应用管理"].forEach((t,i)=>{g.fillStyle="#fff";g.fillRect(18,120+i*80,324,64);g.fillStyle="#333";g.fillText(t,34,160+i*80);});},[o.canvasRef]);return {status:"live",mode:"video",frame:{width:360,height:720},refresh:()=>{window.reconnected=true;}};};`);
    await writeFile(path.join(root,"entry.tsx"),`import React from "react";import {createRoot} from "react-dom/client";import {MirrorWindow} from "@/components/workspace/harmony/MirrorWindow";import {PioraMessageHost,showPioraMessage} from "@/components/PioraMessage";import {useTheme} from "@/hooks/useTheme";window.showMessage=showPioraMessage;function Fixture(){const {setTheme,themes}=useTheme();window.setMirrorTheme=setTheme;window.mirrorThemes=themes;return <><MirrorWindow/><PioraMessageHost/></>;}createRoot(document.getElementById("root")).render(<Fixture/>);`);
    const aliases=Object.fromEntries(["@/hooks/useI18n","@/hooks/useHarmonyLiveFrame"].map(k=>[k,path.join(root,"stub.tsx")]));
    const compiler=webpack({mode:"development",target:"web",devtool:false,entry:path.join(root,"entry.tsx"),output:{path:root,filename:"bundle.js"},resolve:{extensions:[".tsx",".ts",".js"],modules:[path.join(repo,"node_modules")],alias:{...aliases,"@":repo}},module:{rules:[{test:/\.tsx?$/,exclude:/node_modules/,use:path.join(root,"loader.cjs")},{test:/\.css$/,use:path.join(root,"css.cjs")}]}});
    await new Promise((resolve,reject)=>compiler.run((error,stats)=>compiler.close(()=>error||stats.hasErrors()?reject(error||Error(stats.toString({all:false,errors:true}))):resolve())));
    browser=await chromium.launch({channel:process.platform==="win32"?"msedge":"chromium",headless:true});
    const page=await browser.newPage({viewport:{width:362,height:758}});const requests=[],errors=[];
    page.on("pageerror",e=>errors.push(e.message));
    await page.addInitScript(()=>{let state={serial:"phone",ownerId:"desktop-media",scale:75,open:true,minimized:false,alwaysOnTop:false},listeners=[];window.calls=[];window.updateMirror=patch=>{state={...state,...patch};listeners.forEach(f=>f(state));};window.piDesktop={harmonyMirror:{getState:async()=>state,onStateChange:f=>{listeners.push(f);return()=>listeners=listeners.filter(x=>x!==f);},onCommand:f=>{window.command=f;return()=>{};},reportFrame:async f=>window.geometry=f,setScale:async scale=>{window.calls.push(scale);window.updateMirror({scale});return state;},setPresentation:async presentation=>{window.updateMirror({presentation});return state;},showMenu:async()=>window.menu=true,close:async()=>{window.closed=true;return true;}},clipboard:{copyHarmonyMedia:async f=>{window.copy=f;}}};window.EventSource=class{close(){}};});
    const globals=(await readFile(path.join(repo,"app/globals.css"),"utf8")).replace(/^@import.*$/gm,"");
    const css=globals+await readFile(path.join(repo,"components/workspace/harmony/MirrorWindow.module.css"),"utf8")+await readFile(path.join(repo,"components/ConfirmDialog.module.css"),"utf8");
    await page.route("https://mirror.test/**",async route=>{const r=route.request(),u=new URL(r.url());if(u.pathname==="/themes/codex-dream-skin/skin.css")return route.fulfill({contentType:"text/css",body:await readFile(path.join(repo,"public/themes/codex-dream-skin/skin.css"),"utf8")});if(u.pathname==="/bundle.js")return route.fulfill({contentType:"text/javascript",body:await readFile(path.join(root,"bundle.js"))});if(u.pathname==="/api/harmony/devices")return route.fulfill({json:{devices:[{serial:"phone",name:"BRA-AL00",model:"BRA-AL00",product:"HUAWEI Mate 60 ",state:"online",generation:1,capabilities:{screenshot:true}}]}});if(u.pathname==="/api/harmony/media"){if(r.method()==="POST"){requests.push(r.postDataJSON());return route.fulfill({json:{artifact:{kind:"screenshot",serial:"phone",path:"C:/media/screen.png",filename:"screen.png"}}});}return route.fulfill({json:{recording,completion}});}if(u.pathname.startsWith('/api/'))return route.fulfill({json:{}});return route.fulfill({contentType:"text/html",body:`<meta charset="utf-8"><style>:root{--bg:#fff;--bg-panel:#fafafa;--bg-hover:#eee;--border:#ddd;--text:#222;--text-muted:#666;--text-dim:#888;--accent:#3478f6;--btn-primary-bg:#3478f6;--btn-primary-fg:#fff;--radius-surface:12px;--radius-control:6px;--font-ui:system-ui;--text-base:14px;--text-sm:13px}body{margin:0;font:14px system-ui}${css}</style><div id="root"></div><script src="/bundle.js"></script>`});});
    await page.goto("https://mirror.test/");await page.waitForFunction(()=>window.geometry?.width===360);
    await page.locator("canvas").click();await page.locator("canvas").press("a");assert.equal(requests.length,0);
    assert.equal(await page.locator("footer").count(),0);
    assert.equal(await page.locator(".device").innerText(), "HUAWEI Mate 60");
    const themes=await page.evaluate(()=>window.mirrorThemes);
    for(const theme of themes){
      await page.evaluate(id=>window.setMirrorTheme(id),theme.id);
      await page.waitForFunction(dark=>document.querySelector('header').dataset.dark===String(dark),theme.isDark);
      if(theme.id==="dream")await page.waitForFunction(()=>document.querySelector('link[data-theme-pack]')?.sheet);
      const colors=await page.locator('header').evaluate(header=>{
        const rgb=value=>value.match(/[\d.]+/g).slice(0,3).map(Number);
        const luminance=value=>rgb(value).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
        const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
        const surface=getComputedStyle(header).backgroundColor;
        return {surface,ratios:[...header.querySelectorAll('button:not(:disabled),select,.device')].map(el=>contrast(getComputedStyle(el).color,surface)),icons:[...header.querySelectorAll('button:not(:disabled) svg')].map(el=>contrast(getComputedStyle(el).stroke,surface))};
      });
      assert.ok(!colors.surface.includes('rgba'),theme.id+' toolbar is opaque');
      assert.ok(colors.ratios.every(r=>r>=4.5),theme.id+' text contrast '+JSON.stringify(colors));
      assert.ok(colors.icons.length>=4&&colors.icons.every(r=>r>=4.5),theme.id+' real icon contrast');
      await page.getByRole('combobox',{name:'画面缩放'}).focus();
      assert.notEqual(await page.getByRole('combobox',{name:'画面缩放'}).evaluate(el=>getComputedStyle(el).outlineStyle),'none');
      if(process.env.PIORA_HARMONY_SCREENSHOT_DIR&&['light','anime-neon','dream'].includes(theme.id)){
        await mkdir(process.env.PIORA_HARMONY_SCREENSHOT_DIR,{recursive:true});
        await page.screenshot({path:path.join(process.env.PIORA_HARMONY_SCREENSHOT_DIR,'toolbar-'+theme.id+'.png')});
      }
    }
    await page.evaluate(()=>window.setMirrorTheme('light'));
    await page.waitForFunction(()=>document.querySelector('header').dataset.dark==='false');
    await page.getByRole("button", {name:"在侧栏显示"}).click();
    await page.waitForFunction(()=>window.frameOptions.active===false);
    await page.evaluate(()=>window.updateMirror({presentation:"floating"}));
    await page.waitForFunction(()=>window.frameOptions.active===true);
    const screen=await page.locator("canvas").boundingBox();assert.ok(screen.y<=38&&screen.y+screen.height>=757);
    recording={serial:"phone",ownerId:"desktop-media",recordingId:"recording-limit",startedAt:new Date().toISOString(),phase:"recording"};
    await page.getByRole("button",{name:"停止录屏",exact:true}).waitFor();
    recording=null;completion={stopReason:"duration-limit",artifact:{kind:"recording",serial:"phone",path:"C:/media/video.mp4",filename:"video.mp4"}};
    await page.getByRole("status").filter({hasText:"录屏已保存"}).waitFor();assert.match(await page.getByRole("status").innerText(),/30分钟上限/);
    assert.equal(await page.getByRole("dialog").count(),0);
    if(process.env.PIORA_HARMONY_SCREENSHOT_DIR){await mkdir(process.env.PIORA_HARMONY_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.PIORA_HARMONY_SCREENSHOT_DIR,"media-notice.png")});}
    await page.getByRole("status").getByRole("button",{name:"关闭",exact:true}).click();completion=null;
    await page.getByRole("combobox",{name:"画面缩放"}).selectOption("25");assert.deepEqual(await page.evaluate(()=>window.calls),[25]);
    await page.setViewportSize({width:122,height:278});await page.getByRole("button",{name:"投屏菜单"}).click();assert.equal(await page.evaluate(()=>window.menu),true);
    assert.equal(await page.getByRole("button",{name:"关闭投屏"}).isVisible(),true);
    assert.equal(await page.getByRole("button",{name:"截图",exact:true}).isVisible(),false);
    await page.evaluate(()=>window.updateMirror({minimized:true}));await page.waitForFunction(()=>window.frameOptions.active===false);
    await page.evaluate(()=>window.updateMirror({minimized:false}));await page.waitForFunction(()=>window.frameOptions.active===true);
    const out=process.env.PIORA_HARMONY_SCREENSHOT_DIR;
    if(out){await mkdir(out,{recursive:true});await page.screenshot({path:path.join(out,"mirror-25.png")});await page.setViewportSize({width:362,height:758});await page.evaluate(()=>window.updateMirror({scale:75}));await page.screenshot({path:path.join(out,"mirror-75.png")});}
    await page.setViewportSize({width:700,height:700});
    await page.evaluate(()=>{window.showMessage({title:"停止录屏并关闭？",message:"录屏已进行 08:32。停止后将保存到媒体库。",tone:"confirm",actions:[{id:"cancel",label:"继续录屏"},{id:"stop",label:"停止并保存",primary:true}]}).then(v=>window.answer=v);});
    await page.getByRole("dialog").waitFor();await page.keyboard.press("Escape");await page.waitForFunction(()=>window.answer===null);
    await page.evaluate(()=>{window.showMessage({title:"截图已保存并复制",message:"screen.png",tone:"success",actions:[{id:"folder",label:"打开文件夹"},{id:"done",label:"完成",primary:true}]}).then(v=>window.answer=v);});
    await page.getByRole("dialog").waitFor();if(out)await page.screenshot({path:path.join(out,"common-message.png")});await page.getByRole("button",{name:"完成",exact:true}).click();await page.waitForFunction(()=>window.answer==="done");
    assert.deepEqual(errors,[]);
  } finally {await browser?.close();await rm(root,{recursive:true,force:true});}
});
