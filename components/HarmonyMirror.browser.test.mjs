import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { chromium } from "playwright-core";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("mirror defaults to direct control, can be disabled, and renders legible messages", { timeout: 120000 }, async () => {
  const root=await mkdtemp(path.join(tmpdir(),"piora-mirror-ui-"));let browser, recording = null, completion = null, failInput = false, geometryWidth = 360, deviceGeneration = 1;
  try {
    await writeFile(path.join(root,"loader.cjs"),`const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root,"css.cjs"),'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    await writeFile(path.join(root,"stub.tsx"),`import {useEffect,useRef,useState,useCallback} from "react";export const useI18n=()=>({locale:"zh-CN"});export const AliIcon=({name})=><span>{name==="save"?"▣":name==="close"?"×":"●"}</span>;export const useHarmonyMirror=o=>{const surfaceRef=useRef(null);const[problem,setProblem]=useState(null);window.setMirrorFailure=setProblem;window.setVideoFailure=error=>setProblem(error?{error,state:"recovering"}:null);window.frameOptions={active:o.active,serial:o.serial,generation:o.generation,worker:true};const refresh=useCallback(()=>{window.reconnected=true;window.refreshCount=(window.refreshCount??0)+1;setProblem(null);},[]);useEffect(()=>{const c=document.createElement("canvas");surfaceRef.current.appendChild(c);c.width=360;c.height=720;const g=c.getContext("2d");g.fillStyle="#eef3fa";g.fillRect(0,0,360,720);g.fillStyle="#243047";g.font="24px sans-serif";g.fillText("设置 · 示例画面",24,80);g.font="16px sans-serif";["无线网络","蓝牙","显示与亮度","声音和振动","通知","应用管理"].forEach((t,i)=>{g.fillStyle="#fff";g.fillRect(18,120+i*80,324,64);g.fillStyle="#333";g.fillText(t,34,160+i*80);});return()=>c.remove();},[surfaceRef]);return {surfaceRef,state:problem?(problem.state??"error"):"live",error:problem?.error,controlStatus:problem?.controlStatus,frame:{serial:o.serial,generation:o.generation,width:360,height:720},refresh};};`);
    await writeFile(path.join(root,"entry.tsx"),`import React,{useState} from "react";import {createRoot} from "react-dom/client";import {MirrorWindow} from "@/components/workspace/harmony/MirrorWindow";import {PioraMessageHost,showPioraMessage} from "@/components/PioraMessage";import {useTheme} from "@/hooks/useTheme";window.showMessage=showPioraMessage;function Fixture(){const[embedded,setEmbedded]=useState(false);window.setEmbedded=setEmbedded;const {setTheme,themes}=useTheme();window.setMirrorTheme=setTheme;window.mirrorThemes=themes;return <><MirrorWindow embedded={embedded} serial={embedded?"phone":undefined}/><PioraMessageHost/></>;}createRoot(document.getElementById("root")).render(<Fixture/>);`);
    const aliases=Object.fromEntries(["@/hooks/useI18n","@/hooks/useHarmonyMirror"].map(k=>[k,path.join(root,"stub.tsx")]));
    const compiler=webpack({mode:"development",target:"web",devtool:false,entry:path.join(root,"entry.tsx"),output:{path:root,filename:"bundle.js"},resolve:{extensions:[".tsx",".ts",".js"],modules:[path.join(repo,"node_modules")],alias:{...aliases,"@":repo}},module:{rules:[{test:/\.tsx?$/,exclude:/node_modules/,use:path.join(root,"loader.cjs")},{test:/\.css$/,use:path.join(root,"css.cjs")}]}});
    await new Promise((resolve,reject)=>compiler.run((error,stats)=>compiler.close(()=>error||stats.hasErrors()?reject(error||Error(stats.toString({all:false,errors:true}))):resolve())));
    browser=await chromium.launch({channel:process.platform==="win32"?"msedge":"chromium",headless:true});
    const page=await browser.newPage({viewport:{width:362,height:758}});const requests=[],errors=[],inputRequests=[];
    page.on('request',request=>{if(request.method()==='POST'&&/\/api\/harmony\/(manual|action|pointer)$/.test(new URL(request.url()).pathname))inputRequests.push({path:new URL(request.url()).pathname,body:request.postDataJSON()});});
    // Pixel assertions target the settled theme, not the compositor's temporary
    // old/new snapshots. Reduced motion also removes the transition-ready race.
    await page.emulateMedia({reducedMotion:"reduce"});
    page.on("pageerror",e=>errors.push(e.message));
    await page.addInitScript(()=>{let state={serial:"phone",ownerId:"desktop-media",scale:75,open:true,minimized:false,alwaysOnTop:false},listeners=[];window.calls=[];window.transitionId=0;window.updateMirror=patch=>{state={...state,...patch};listeners.forEach(f=>f(state));};window.piDesktop={harmonyMirror:{getState:async()=>state,onStateChange:f=>{listeners.push(f);return()=>listeners=listeners.filter(x=>x!==f);},onCommand:f=>{window.command=f;return()=>{};},reportFrame:async f=>{window.geometry=f;if(f.presentation===state.pendingPresentation&&f.transition===state.presentationTransition)window.updateMirror({presentation:f.presentation,pendingPresentation:undefined,presentationTransition:undefined});},setAlwaysOnTop:async alwaysOnTop=>{window.updateMirror({alwaysOnTop});return state;},setScale:async scale=>{window.calls.push(scale);window.updateMirror({scale});return state;},setPresentation:async pendingPresentation=>{window.updateMirror({pendingPresentation,presentationTransition:String(++window.transitionId)});return state;},showMenu:async()=>window.menu=true,close:async()=>{window.closed=true;return true;}},clipboard:{copyHarmonyMedia:async f=>{window.copy=f;}}};window.EventSource=class{close(){}};});
    const globals=(await readFile(path.join(repo,"app/globals.css"),"utf8")).replace(/^@import.*$/gm,"");
    const css=globals+await readFile(path.join(repo,"app/theme-backgrounds.css"),"utf8")+await readFile(path.join(repo,"components/workspace/harmony/MirrorWindow.module.css"),"utf8")+await readFile(path.join(repo,"components/ConfirmDialog.module.css"),"utf8");
    await page.route("https://mirror.test/**",async route=>{const r=route.request(),u=new URL(r.url());if(u.pathname==="/themes/codex-dream-skin/skin.css")return route.fulfill({contentType:"text/css",body:await readFile(path.join(repo,"public/themes/codex-dream-skin/skin.css"),"utf8")});if(u.pathname==="/bundle.js")return route.fulfill({contentType:"text/javascript",body:await readFile(path.join(root,"bundle.js"))});if(u.pathname==="/api/harmony/devices")return route.fulfill({json:{devices:[{serial:"phone",name:"BRA-AL00",model:"BRA-AL00",product:"HUAWEI Mate 60 ",state:"online",generation:deviceGeneration,capabilities:{screenshot:true}}]}});if(u.pathname==="/api/harmony/media"){if(r.method()==="POST"){requests.push(r.postDataJSON());return route.fulfill({json:{artifact:{kind:"screenshot",serial:"phone",path:"C:/media/screen.png",filename:"screen.png"}}});}return route.fulfill({json:{recording,completion}});}if(u.pathname.startsWith('/api/'))return route.fulfill({json:{}});return route.fulfill({contentType:"text/html",body:`<meta charset="utf-8"><style>:root{--bg:#fff;--bg-panel:#fafafa;--bg-hover:#eee;--border:#ddd;--text:#222;--text-muted:#666;--text-dim:#888;--accent:#3478f6;--btn-primary-bg:#3478f6;--btn-primary-fg:#fff;--radius-surface:12px;--radius-control:6px;--font-ui:system-ui;--text-base:14px;--text-sm:13px}body{margin:0;font:14px system-ui}${css}</style><div id="root"></div><script src="/bundle.js"></script>`});});
    let geometryRequested=false, geometryDuringAcquire=false, geometryGate, finishGeometry;
    await page.route('https://mirror.test/api/harmony/manual',async route=>{if(route.request().postDataJSON().action==='acquire'){await new Promise(resolve=>setTimeout(resolve,100));geometryDuringAcquire=geometryRequested;}return route.fulfill({json:{lease:{token:'fixture-lease',serial:'phone',expiresAt:new Date(Date.now()+300000).toISOString()}}});});
    await page.route('https://mirror.test/api/harmony/geometry?*',async route=>{geometryRequested=true;if(geometryGate)await geometryGate;return route.fulfill({json:{geometry:{geometryId:'current-video-geometry',frameWidth:geometryWidth,frameHeight:720}}});});
    let firstInput = true;
    await page.route('https://mirror.test/api/harmony/action',async route=>{
      // Real-device cold driver startup exceeded the former 15-second budget.
      if (firstInput) { firstInput = false; await new Promise(resolve=>setTimeout(resolve,16000)); }
      return route.fulfill(failInput?{status:409,json:{error:{code:'STALE_SNAPSHOT',message:'Input rejected by fixture'}}}:{json:{result:{}}});
    });
    await page.route('https://mirror.test/api/harmony/pointer',route=>route.fulfill(failInput
      ?{status:409,json:{error:{code:'STALE_SNAPSHOT',message:'Input rejected by fixture'}}}
      :{json:{gestureId:'c'.repeat(32),released:route.request().postDataJSON().phase==='up'}}));
    await page.goto("https://mirror.test/");await page.addStyleTag({content:"*, *::before, *::after { transition: none !important; animation: none !important; }"});await page.waitForFunction(()=>window.geometry?.width===360);
    for (const dark of [false,true]) {
      const ratios=await page.evaluate(dark=>{
        const dialog=document.createElement('div');dialog.className='dialog standalone';dialog.dataset.dark=String(dark);
        dialog.innerHTML='<div class="body"><h2>连接详情</h2><p>设备画面信息</p></div><div class="actions"><button class="primary">确定</button></div>';document.body.appendChild(dialog);
        const luminance=value=>value.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
        const ratio=(a,b)=>{a=luminance(a);b=luminance(b);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
        const style=getComputedStyle(dialog),button=getComputedStyle(dialog.querySelector('button'));
        const result=[ratio(getComputedStyle(dialog.querySelector('h2')).color,style.backgroundColor),ratio(getComputedStyle(dialog.querySelector('p')).color,style.backgroundColor),ratio(button.color,button.backgroundColor)];dialog.remove();return result;
      },dark);
      assert.ok(ratios.every(value=>value>=4.5),`standalone ${dark?'dark':'light'} message contrast: ${ratios}`);
    }
    assert.equal(await page.getByRole('button',{name:'操控手机'}).getAttribute('aria-pressed'),'true');
    assert.deepEqual(inputRequests,[],'opening the mirror must not acquire an input lease');
    assert.equal(await page.locator('footer input, footer form').count(),0,'no text entry in mirror controls');
    assert.equal(await page.getByLabel('投屏交互区域').evaluate(el=>getComputedStyle(el).cursor),'default');
    for (const width of [280, 362, 520]) {
      await page.setViewportSize({width,height:758});
      const layout=await page.locator('footer').evaluate(el=>({scroll:el.scrollWidth,width:el.clientWidth,buttons:[...el.querySelectorAll('button')].map(b=>{const r=b.getBoundingClientRect();return {x:r.x,right:r.right,h:r.height};})}));
      assert.ok(layout.scroll<=layout.width+1,'control bar fits '+width);
      assert.ok(layout.buttons.every(b=>b.x>=0&&b.right<=width&&b.h>=28),'buttons remain reachable at '+width);
      assert.ok(await page.locator('main').evaluate(el=>el.clientHeight)>500,'controls preserve video height');
      if(process.env.PIORA_HARMONY_SCREENSHOT_DIR){await mkdir(process.env.PIORA_HARMONY_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.PIORA_HARMONY_SCREENSHOT_DIR,'controls-'+width+'.png')});}
    }
    const chromeHeight=await page.evaluate(()=>window.geometry.chromeHeight);
    await page.setViewportSize({width:362,height:720+chromeHeight});
    await page.waitForFunction(()=>Math.abs(document.querySelector('main').clientHeight-720)<=1);
    const screenBox=await page.locator('main').boundingBox();
    assert.ok(Math.abs(screenBox.width/ screenBox.height-.5)<.002,'reported chrome preserves full-width video aspect');
    if(process.env.PIORA_HARMONY_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.PIORA_HARMONY_SCREENSHOT_DIR,'controls-full-width.png')});
    await page.getByRole('button',{name:'显示选项',exact:true}).click();
    await page.getByRole('button',{name:'100%',exact:true}).click();
    assert.equal(await page.locator('main').getAttribute('data-zoomed'),'true');
    await page.getByRole('button',{name:'适应',exact:true}).click();
    assert.equal(await page.locator('main').getAttribute('data-zoomed'),'false');
    await page.getByRole('button',{name:'窗口置顶',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'窗口置顶',exact:true}).getAttribute('aria-pressed'),'true');
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('button',{name:'显示选项',exact:true}).getAttribute('aria-expanded'),'false');
    assert.equal(await page.getByRole('button',{name:'显示选项',exact:true}).evaluate(el=>document.activeElement===el),true);
    await page.getByRole('button',{name:'显示选项',exact:true}).click();
    await page.locator('.device').click();
    assert.equal(await page.getByRole('button',{name:'显示选项',exact:true}).getAttribute('aria-expanded'),'false');
    assert.deepEqual(inputRequests,[],'display options never inject phone input');
    await page.evaluate(()=>window.setMirrorTheme('dark'));
    await page.waitForFunction(()=>document.querySelector('.root').dataset.dark==='true');
    const contrast=await page.locator('footer').evaluate(el=>{const c=getComputedStyle(el);const lum=v=>v.match(/[0-9.]+/g).slice(0,3).map(Number).map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((s,x,i)=>s+x*[.2126,.7152,.0722][i],0);const a=lum(c.color),b=lum(c.backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);});
    assert.ok(contrast>=4.5,'dark controls remain legible');
    if(process.env.PIORA_HARMONY_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.PIORA_HARMONY_SCREENSHOT_DIR,'controls-dark.png')});
    await page.evaluate(()=>window.setMirrorTheme('light'));
    await page.waitForFunction(()=>document.querySelector('.root').dataset.dark==='false');
    await page.getByRole('button',{name:'显示选项',exact:true}).click();
    if(process.env.PIORA_HARMONY_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.PIORA_HARMONY_SCREENSHOT_DIR,'controls-options.png')});
    await page.keyboard.press('Escape');


    await page.getByRole('button',{name:'操控手机'}).click();
    await page.locator("canvas").click();await page.locator("canvas").press("a");assert.equal(requests.length,0);assert.deepEqual(inputRequests,[],'disabled control cannot acquire input leases or send gestures');
    assert.equal(await page.locator("footer").count(),0);
    assert.equal(await page.locator(".device").innerText(), "HUAWEI Mate 60");
    const themes=await page.evaluate(()=>window.mirrorThemes);
    for(const theme of themes){
      await page.evaluate(id=>window.setMirrorTheme(id),theme.id);
      await page.waitForFunction(dark=>document.querySelector('header').dataset.dark===String(dark),theme.isDark);
      if(theme.id==="dream")await page.waitForFunction(()=>document.querySelector('link[data-theme-pack]')?.sheet);
      // The theme state commits before its view-transition snapshot disappears.
      await page.evaluate(async()=>{await Promise.all(document.getAnimations().filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})));});
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
      // Computed colors alone cannot detect wallpaper pseudo-elements painting
      // over an otherwise correctly styled titlebar. Inspect composited pixels.
      for (const wallpaper of [false, true]) {
        await page.evaluate(enabled => {
          document.documentElement.dataset.appBackgroundActive=String(enabled);
          document.documentElement.style.setProperty('--app-background-image','linear-gradient(#ff00ff,#ff00ff)');
          document.documentElement.style.setProperty('--app-background-overlay','0%');
        },wallpaper);
        const {data,info}=await sharp(await page.locator('header').screenshot()).ensureAlpha().raw().toBuffer({resolveWithObject:true});
        if(process.env.PIORA_HARMONY_SCREENSHOT_DIR){await mkdir(process.env.PIORA_HARMONY_SCREENSHOT_DIR,{recursive:true});await page.locator('header').screenshot({path:path.join(process.env.PIORA_HARMONY_SCREENSHOT_DIR,`titlebar-${theme.id}-${wallpaper?'wallpaper':'plain'}.png`)});}
        const expected=colors.surface.match(/[\d.]+/g).slice(0,3).map(Number);
        const offset=(info.width+1)*4;
        assert.deepEqual([...data.subarray(offset,offset+3)],expected,`${theme.id}: titlebar must paint above wallpaper (${wallpaper})`);
        const controls=await page.locator('header').evaluate(header=>{
          const origin=header.getBoundingClientRect();
          return [...header.querySelectorAll('button:not(:disabled),select,.device')].map(el=>{
            const rect=el.getBoundingClientRect();
            return {x:rect.left-origin.left,y:rect.top-origin.top,width:rect.width,height:rect.height,color:getComputedStyle(el).color};
          });
        });
        const luminance=channels=>channels.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
        const backgroundLuminance=luminance(expected);
        for(const control of controls){
          let visiblePixels=0;
          for(let y=Math.max(0,Math.ceil(control.y));y<Math.min(info.height,Math.floor(control.y+control.height));y++){
            for(let x=Math.max(0,Math.ceil(control.x));x<Math.min(info.width,Math.floor(control.x+control.width));x++){
              const pixel=(y*info.width+x)*4;
              // Windows subpixel text edges need not equal the CSS RGB value.
              const ink=luminance([...data.subarray(pixel,pixel+3)]);
              if((Math.max(ink,backgroundLuminance)+.05)/(Math.min(ink,backgroundLuminance)+.05)>=3)visiblePixels++;
            }
          }
          assert.ok(visiblePixels>=3,`${theme.id}: each titlebar label/icon must remain painted (${wallpaper}): ${JSON.stringify(control)}`);
        }
      }
      await page.getByRole('button',{name:'关闭投屏'}).focus();
      assert.notEqual(await page.getByRole('button',{name:'关闭投屏'}).evaluate(el=>getComputedStyle(el).outlineStyle),'none');
      if(process.env.PIORA_HARMONY_SCREENSHOT_DIR&&['light','anime-neon','dream'].includes(theme.id)){
        await mkdir(process.env.PIORA_HARMONY_SCREENSHOT_DIR,{recursive:true});
        await page.screenshot({path:path.join(process.env.PIORA_HARMONY_SCREENSHOT_DIR,'toolbar-'+theme.id+'.png')});
      }
    }
    await page.evaluate(()=>window.setMirrorTheme('light'));
    await page.waitForFunction(()=>document.querySelector('header').dataset.dark==='false');
    await page.getByRole("button", {name:"在侧栏显示"}).click();
    await page.waitForFunction(()=>window.frameOptions.active===true);
    assert.equal(await page.evaluate(()=>window.geometry.presentation),"floating","outgoing surface remains live until the destination paints");
    await page.evaluate(()=>window.setEmbedded(true));
    await page.waitForFunction(()=>document.querySelector('.root')?.classList.contains('embedded'));
    await page.waitForFunction(()=>window.frameOptions.active===true);
    assert.equal(await page.evaluate(()=>window.frameOptions.worker),true,"sidebar uses the dedicated video worker");
    await page.getByRole("button",{name:"切换到悬浮投屏"}).click();
    await page.waitForFunction(()=>window.frameOptions.active===true);
    assert.equal(await page.evaluate(()=>window.geometry.presentation),"sidebar","docking does not blank the source before the floating frame");
    await page.evaluate(()=>window.setEmbedded(false));
    await page.waitForFunction(()=>{const root=document.querySelector('.root');return root&&!root.classList.contains('embedded')&&getComputedStyle(root).borderTopWidth==='1px'});
    await page.waitForFunction(()=>window.frameOptions.active===true);
    assert.equal(await page.evaluate(()=>window.frameOptions.worker),true,"floating view uses the same dedicated video worker");
    const screen=await page.locator("canvas").boundingBox();assert.ok(screen.y<=38&&screen.y+screen.height>=757);
    const controlWasEnabled = await page.getByRole("button", {name:"操控手机"}).getAttribute("aria-pressed");
    await page.evaluate(() => { window.retainedCanvas = document.querySelector("canvas"); window.setVideoFailure("The device stopped producing decoded video (0 submitted, 0 decoded)"); });
    await page.getByRole("status").filter({hasText:"正在恢复连接"}).waitFor();
    const recoveringScreen = await page.locator("canvas").boundingBox();
    assert.deepEqual(recoveringScreen, screen, "a transient error cannot resize the phone image");
    assert.equal(await page.evaluate(() => document.querySelector("canvas") === window.retainedCanvas), true);
    assert.equal(await page.locator(".placeholder").count(), 0, "the error never covers a previously rendered frame");
    await page.getByRole("button", {name:"重连",exact:true}).click();
    await page.waitForFunction(() => window.reconnected === true);
    await page.evaluate(() => window.setVideoFailure(null));
    if (await page.getByRole("button", {name:"操控手机"}).getAttribute("aria-pressed") !== controlWasEnabled) await page.getByRole("button", {name:"操控手机"}).click();
    recording={serial:"phone",ownerId:"desktop-media",recordingId:"recording-limit",startedAt:new Date().toISOString(),phase:"recording"};
    await page.getByRole("button",{name:"停止录屏",exact:true}).waitFor();
    recording=null;completion={stopReason:"duration-limit",artifact:{kind:"recording",serial:"phone",path:"C:/media/video.mp4",filename:"video.mp4"}};
    await page.getByRole("status").filter({hasText:"录屏已保存"}).waitFor();assert.match(await page.getByRole("status").innerText(),/30分钟上限/);
    assert.equal(await page.getByRole("dialog").count(),0);
    const noticeBounds = await page.getByRole("status").filter({hasText:"录屏已保存"}).boundingBox();
    assert.ok(noticeBounds.width <= 300 && noticeBounds.height <= 76, `compact media result: ${JSON.stringify(noticeBounds)}`);
    if(process.env.PIORA_HARMONY_SCREENSHOT_DIR){await mkdir(process.env.PIORA_HARMONY_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.PIORA_HARMONY_SCREENSHOT_DIR,"media-notice.png")});}
    await page.getByRole("status").getByRole("button",{name:"关闭",exact:true}).click();completion=null;
    assert.equal(await page.getByRole("combobox",{name:"画面缩放"}).count(),0);
    await page.setViewportSize({width:122,height:278});await page.getByRole("button",{name:"投屏菜单"}).click();assert.equal(await page.evaluate(()=>window.menu),true);
    assert.equal(await page.getByRole("button",{name:"关闭投屏"}).isVisible(),true);
    assert.equal(await page.getByRole("button",{name:"截图",exact:true}).isVisible(),false);
    await page.evaluate(()=>window.updateMirror({minimized:true}));await page.waitForFunction(()=>window.frameOptions.active===true);
    await page.evaluate(()=>window.updateMirror({minimized:false}));await page.waitForFunction(()=>window.frameOptions.active===true);
    const out=process.env.PIORA_HARMONY_SCREENSHOT_DIR;
    if(out){await mkdir(out,{recursive:true});await page.screenshot({path:path.join(out,"mirror-25.png")});await page.setViewportSize({width:362,height:758});await page.evaluate(()=>window.updateMirror({scale:75}));await page.screenshot({path:path.join(out,"mirror-75.png")});}
    await page.setViewportSize({width:700,height:700});
    await page.evaluate(()=>{window.showMessage({title:"停止录屏并关闭？",message:"录屏已进行 08:32。停止后将保存到媒体库。",tone:"confirm",actions:[{id:"cancel",label:"继续录屏"},{id:"stop",label:"停止并保存",primary:true}]}).then(v=>window.answer=v);});
    await page.getByRole("dialog").waitFor();await page.keyboard.press("Escape");await page.waitForFunction(()=>window.answer===null);
    await page.evaluate(()=>{window.showMessage({title:"截图已保存并复制",message:"screen.png",tone:"success",actions:[{id:"folder",label:"打开文件夹"},{id:"done",label:"完成",primary:true}]}).then(v=>window.answer=v);});
    await page.getByRole("dialog").waitFor();if(out)await page.screenshot({path:path.join(out,"common-message.png")});await page.getByRole("button",{name:"完成",exact:true}).click();await page.waitForFunction(()=>window.answer==="done");
    const actions=()=>inputRequests.filter(request=>request.path.endsWith('/action')).map(request=>request.body);
    const pointers=()=>inputRequests.filter(request=>request.path.endsWith('/pointer')).map(request=>request.body);
    const mutations=()=>inputRequests.filter(request=>/\/(action|pointer)$/.test(request.path));
    await page.getByRole('button',{name:'操控手机'}).click();
    const surface=page.getByLabel('投屏交互区域');
    geometryGate=new Promise(resolve=>{finishGeometry=resolve});
    const warmGeometry=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/harmony/geometry');
    const beforeWarmup=inputRequests.length;
    await surface.hover();
    await page.getByRole('status').filter({hasText:'正在准备设备控制'}).waitFor();
    assert.equal(await surface.getAttribute('aria-busy'),'true');
    await surface.click();assert.equal(inputRequests.length,beforeWarmup,'a click during read-only preparation cannot claim control or inject input');
    finishGeometry();geometryGate=undefined;await warmGeometry;
    await page.waitForFunction(()=>document.querySelector('[aria-label="投屏交互区域"]').getAttribute('aria-busy')==='false');
    await Promise.all([page.waitForResponse(response=>new URL(response.url()).pathname==='/api/harmony/pointer'&&response.request().postDataJSON().phase==='up'),surface.click()]);
    assert.equal(geometryDuringAcquire,true,'geometry starts before lease acquisition finishes');
    assert.deepEqual(pointers().map(input=>input.phase),['down','up']);assert.equal(pointers()[0].generation,1);
    assert.equal(pointers()[0].geometryId,'current-video-geometry');assert.equal(pointers()[0].leaseToken,'fixture-lease');
    assert.equal(pointers()[1].gestureId,'c'.repeat(32),'release stays bound to the acknowledged gesture');
    assert.ok(Math.abs(pointers()[0].x-180)<=1&&Math.abs(pointers()[0].y-360)<=1,'letterboxed screen center maps to phone center');
    await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname==='/api/harmony/action'),surface.press('Home')]);
    assert.ok(actions().some(action=>action.action==='press_key'&&action.key==='home'));
    for (const [label,key] of [['返回','back'],['主页','home'],['最近任务','recents'],['音量−','volume_down'],['音量＋','volume_up'],['电源键','power']]) {
      await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname==='/api/harmony/action'),page.getByRole('button',{name:label,exact:true}).click()]);
      assert.equal(actions().at(-1).key,key);
      assert.equal(actions().at(-1).action,'press_key');
      assert.equal(actions().at(-1).durationMs,undefined);
    }
    geometryWidth=720;
    const staleGeometry=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/harmony/geometry');
    await surface.hover();await staleGeometry;
    await page.waitForFunction(()=>document.querySelector('[aria-label="投屏交互区域"]').getAttribute('aria-busy')==='false');
    const beforeStale=mutations().length;await surface.click();
    await page.getByRole('status').filter({hasText:'屏幕方向已变化'}).waitFor();
    assert.equal(mutations().length,beforeStale,'mismatched geometry cannot inject coordinates');
    await page.getByRole('button',{name:'操控手机'}).click();await page.getByRole('button',{name:'操控手机'}).click();
    geometryWidth=360;failInput=true;
    const failedInputGeometry=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/harmony/geometry');
    await surface.hover();await failedInputGeometry;
    await page.waitForFunction(()=>document.querySelector('[aria-label="投屏交互区域"]').getAttribute('aria-busy')==='false');
    await surface.click();
    await page.getByRole('status').filter({hasText:'Input rejected by fixture'}).waitFor();
    assert.equal(await page.getByLabel('发送文字到手机').count(),0);
    const afterFailure=mutations().length;await surface.click();
    await page.waitForTimeout(150);assert.equal(mutations().length,afterFailure,'ambiguous input failure stops queued gestures without replay');
    await page.route('https://mirror.test/api/harmony/media?*',route=>route.fulfill({status:503,json:{error:{code:'COMMAND_TIMEOUT',message:'Status read unavailable'}}}));
    await page.getByRole('button',{name:'截图',exact:true}).click();
    await page.getByRole('status').filter({hasText:'截图已保存'}).waitFor();
    await page.waitForTimeout(100);
    assert.equal(await page.getByRole('dialog').count(),0,'a successful save stays successful when the follow-up status read fails');
    const recoveryRequests=[];let needsPhysicalConfirmation=true, releaseConfirmation, noteConfirmation;
    const confirmationGate=new Promise(resolve=>{releaseConfirmation=resolve});
    const confirmationReceived=new Promise(resolve=>{noteConfirmation=resolve});
    await page.route('https://mirror.test/api/harmony/recovery',async route=>{
      const body=route.request().postDataJSON();recoveryRequests.push(body);
      if(body.action==='retry')deviceGeneration++;
      if(body.action==='confirm'){noteConfirmation();await confirmationGate;}
      return route.fulfill({json:{cleanup:body.action==='retry'?'uncertain':'manual-confirmed',controlStatus:body.action==='retry'&&needsPhysicalConfirmation?'recovering':null,device:{serial:'phone',state:'online',generation:deviceGeneration,capabilities:{screenshot:true}}}});
    });
    const beforeRecovery=mutations().length;
    await page.evaluate(()=>window.setMirrorFailure({controlStatus:'stopping',error:'设备正在停止操作，请等待清理完成后重试。'}));
    assert.equal(await page.getByRole('button',{name:'检查并恢复设备',exact:true}).count(),0);
    await page.getByRole('button',{name:'重连',exact:true}).click();
    await page.getByText('上次设备操作的清理尚未确认，请在投屏窗口点击“检查并恢复设备”。',{exact:true}).waitFor();
    for(const width of [280,362]){
      await page.setViewportSize({width,height:758});
      const layout=await page.locator('.recovery').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth,buttons:[...el.querySelectorAll('button')].map(button=>({left:button.getBoundingClientRect().left,right:button.getBoundingClientRect().right,wrap:getComputedStyle(button).whiteSpace}))}));
      assert.ok(layout.scroll<=layout.width+1,'recovery guidance fits the narrow mirror');
      assert.ok(layout.buttons.every(button=>button.left>=0&&button.right<=width&&button.wrap==='nowrap'),'recovery actions remain readable and reachable');
    }
    if(out)await page.screenshot({path:path.join(out,'cleanup-recovery.png')});
    assert.deepEqual(recoveryRequests,[{action:'retry',serial:'phone'}],'reconnect retries cleanup without confirming input release');
    await page.getByRole('button',{name:'检查并恢复设备',exact:true}).click();
    await page.getByRole('dialog',{name:'恢复设备连接'}).waitFor();
    if(out)await page.screenshot({path:path.join(out,'cleanup-confirmation.png')});
    await page.getByRole('button',{name:'取消',exact:true}).click();
    assert.equal(recoveryRequests.length,1,'cancelling physical confirmation must not send recovery');
    await page.getByRole('button',{name:'检查并恢复设备',exact:true}).click();
    const refreshBeforeConfirmation=await page.evaluate(()=>window.refreshCount??0);
    await page.getByRole('button',{name:'已检查，恢复连接',exact:true}).click();
    await confirmationReceived;
    // The earlier video reconnect and retry already satisfy the old boolean /
    // generation predicate. Hold this response to prove it is not a receipt.
    assert.equal(await page.evaluate(()=>window.reconnected&&window.frameOptions.generation===2),true);
    assert.equal(await page.evaluate(()=>window.refreshCount??0),refreshBeforeConfirmation,'an outstanding confirmation cannot refresh the viewer');
    assert.equal(await page.getByRole('button',{name:'检查并恢复设备',exact:true}).count(),1,'confirmation stays visible until its response is consumed');
    releaseConfirmation();
    await page.waitForFunction(previous=>window.refreshCount===previous+1&&window.frameOptions.generation===2,refreshBeforeConfirmation);
    await page.getByRole('button',{name:'检查并恢复设备',exact:true}).waitFor({state:'detached'});
    assert.deepEqual(recoveryRequests[1],{action:'confirm',serial:'phone',released:true,recordingStopped:true});
    assert.equal(mutations().length,beforeRecovery,'restoring the viewer does not replay failed gestures');
    assert.equal(await page.getByRole('button',{name:'检查并恢复设备',exact:true}).count(),0);
    let stalePoll;
    await page.route('https://mirror.test/api/harmony/devices',route=>{stalePoll=route;});
    for(let attempt=0;!stalePoll&&attempt<40;attempt++)await page.waitForTimeout(100);
    assert.ok(stalePoll,'a device poll started before recovery');
    needsPhysicalConfirmation=false;
    await page.evaluate(()=>{window.reconnected=false;window.setMirrorFailure({controlStatus:'recovering',error:'旧视频清理失败'});});
    await page.getByRole('button',{name:'重连',exact:true}).click();
    await page.waitForFunction(()=>window.reconnected&&window.frameOptions.generation===3);
    assert.equal(recoveryRequests.length,3,'a video-only warning needs no physical-release confirmation');
    await stalePoll.fulfill({json:{devices:[{serial:'phone',state:'online',generation:2,capabilities:{screenshot:true}}]}});
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>window.frameOptions.generation),3,'an older poll cannot replace the recovered device epoch');
    assert.equal(await page.getByRole('button',{name:'检查并恢复设备',exact:true}).count(),0);
    await page.unroute('https://mirror.test/api/harmony/devices');
    await page.evaluate(()=>{window.reconnected=false;window.command('reconnect');});
    await page.waitForFunction(()=>window.reconnected&&window.frameOptions.generation===4);
    assert.deepEqual(recoveryRequests.at(-1),{action:'retry',serial:'phone'},'the native window menu uses the same cleanup retry path');
    assert.equal(recoveryRequests.length,4);
    assert.equal(mutations().length,beforeRecovery,'menu recovery never replays device input');
    assert.deepEqual(errors,[]);
  } finally {await browser?.close();await rm(root,{recursive:true,force:true});}
});
