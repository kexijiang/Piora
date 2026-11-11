import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {chromium} from 'playwright-core';

const require=createRequire(import.meta.url),{webpack}=require('next/dist/compiled/webpack/webpack.js');
const repo=path.resolve(import.meta.dirname,'..');

async function readable(locator,label){
 await locator.waitFor();
 const contrast=await locator.evaluate(element=>{
  // color-mix() serializes as color(srgb ...) in Chromium; normalize every CSS
  // color through the browser instead of treating its 0..1 channels as bytes.
  const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
  const context=canvas.getContext('2d',{willReadFrequently:true});
  const rgb=value=>{context.clearRect(0,0,1,1);context.fillStyle=value;context.fillRect(0,0,1,1);const data=[...context.getImageData(0,0,1,1).data];return[...data.slice(0,3),data[3]/255]};
  const blend=(top,bottom)=>top.slice(0,3).map((channel,index)=>channel*(top[3]??1)+bottom[index]*(1-(top[3]??1)));
  const ancestors=[];for(let node=element;node;node=node.parentElement)ancestors.unshift(node);
  let background=[255,255,255];for(const node of ancestors)background=blend(rgb(getComputedStyle(node).backgroundColor),background);
  const foreground=blend(rgb(getComputedStyle(element).color),background);
  const luminance=channels=>channels.map(value=>{value/=255;return value<=.04045?value/12.92:((value+.055)/1.055)**2.4}).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);
  const a=luminance(foreground),b=luminance(background);
  return{ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),foreground,background};
 });
 assert.ok(contrast.ratio>=4.5,`${label}: ${JSON.stringify(contrast)}`);
}

async function themedBackground(locator,label,token='--bg'){
 const colors=await locator.evaluate((element,token)=>{
  const probe=document.createElement('span');probe.style.backgroundColor=`var(${token})`;element.append(probe);
  const expected=getComputedStyle(probe).backgroundColor,actual=getComputedStyle(element).backgroundColor;probe.remove();
  return{expected,actual};
 },token);
 assert.equal(colors.actual,colors.expected,`${label} follows the application surface`);
}

test('log workbench surfaces and controls remain readable across actual theme palettes',{timeout:120000},async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'piora-log-contrast-'));let browser;
 try{
  await writeFile(path.join(directory,'loader.cjs'),`const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
  await writeFile(path.join(directory,'css.cjs'),'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
  await writeFile(path.join(directory,'entry.tsx'),`import React from'react';import{createRoot}from'react-dom/client';import{LogViewer}from'@/components/workspace/harmony/log-workbench/LogViewer.jsx';import{HarmonyLogWorkbench}from'@/components/workspace/harmony/HarmonyLogWorkbench';createRoot(document.getElementById('root')).render(location.pathname==='/live'?<HarmonyLogWorkbench active serial="theme-fixture" online sessionId="contrast" copy={zh=>zh}/>:<div className="piora-log-workbench"><LogViewer url="/api/harmony/log-library/logs?sessionId=contrast&id=plain" exportUrl="/api/harmony/log-library/export?sessionId=contrast&id=plain"/></div>);`);
  const compiler=webpack({mode:'development',target:'web',devtool:false,entry:path.join(directory,'entry.tsx'),output:{path:directory,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.jsx','.js'],modules:[path.join(repo,'node_modules')],alias:{'@':repo}},module:{rules:[{test:/\.[jt]sx?$/,exclude:/node_modules/,use:path.join(directory,'loader.cjs')},{test:/\.css$/,use:path.join(directory,'css.cjs')}]}});
  await new Promise((resolve,reject)=>compiler.run((error,stats)=>compiler.close(()=>error||stats.hasErrors()?reject(error||Error(stats.toString({all:false,errors:true}))):resolve())));
  const globals=await readFile(path.join(repo,'app/globals.css'),'utf8');
  // Only load styles used by this fixture. CSS Modules have distinct generated
  // names in the app; injecting the old panel's identity-mapped .logToolbar here
  // would incorrectly override the workbench's own classes.
  const applicationCss=globals.replace(/^@import[^;]+;/gm,'');
  const css=(await Promise.all(['log-workbench.css','HarmonyLogWorkbench.module.css','RealtimeLogs.module.css'].map(file=>readFile(path.join(repo,'components/workspace/harmony/log-workbench',file),'utf8')))).join('\n'),bundle=await readFile(path.join(directory,'bundle.js'));
  const entries=['unknown','debug','info','warn','error','fatal'].map((level,index)=>({id:index+1,sourceLine:index+1,timestamp:'11-11 11:30:00.123',pid:42,tid:43,tag:'ThemeFixture',level,message:'needle 普通文本正文 '+level,raw:'needle 普通文本原始行 '+level}));
  const files=[{id:'plain',sessionId:'contrast',name:'device-session.log',count:entries.length,size:2048,createdAt:'2026-11-11T03:30:00Z',sourceKind:'realtime'}];
  browser=await chromium.launch({channel:process.platform==='win32'?'msedge':'chromium',headless:true});
  for(const theme of ['light','dark','cloud-bear','midnight'])await t.test(theme,async()=>{
   const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
   page.on('pageerror',error=>errors.push(error.message));
   try{
    await page.addInitScript(entries=>{
     window.EventSource=class extends EventTarget{
      constructor(){super();setTimeout(()=>{this.dispatchEvent(new MessageEvent('connected'));this.dispatchEvent(new MessageEvent('logs',{data:JSON.stringify({entries})}))},50)}
      close(){}
     };
    },entries);
    await page.route('https://log-contrast.test/**',route=>{
     const url=new URL(route.request().url());
     if(url.pathname==='/bundle.js')return route.fulfill({contentType:'text/javascript',body:bundle});
     if(url.pathname==='/api/harmony/logs')return route.fulfill({json:{processes:[{pid:42,name:'dev.piora.fixture'}]}});
     if(url.pathname==='/api/harmony/apps')return route.fulfill({json:{applications:[{bundleName:'dev.piora.fixture',label:'主题测试应用'}]}});
     if(url.pathname==='/api/harmony/log-library/list')return route.fulfill({json:{protocolVersion:2,sessionId:'contrast',files,total:files.length}});
     if(url.pathname==='/api/harmony/log-library/logs')return route.fulfill({json:{total:entries.length,filteredTotal:entries.length,entries:url.searchParams.has('fullMessage')?[entries[0]]:entries}});
     if(url.pathname.startsWith('/api/'))return route.fulfill({json:{filter:[],find:[],favorites:[],bundleFavorites:[]}});
     return route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><style>${applicationCss}${css}html{font-size:14px}body{margin:0;color:var(--text);background:var(--bg)}#root{height:100vh;display:flex;flex-direction:column;font-family:var(--ui-font-family)}</style><div id="root" class="app-shell"></div><script src="/bundle.js"></script>`});
    });
    await page.goto('https://log-contrast.test/');
    await page.evaluate(theme=>{document.documentElement.classList.toggle('dark',theme==='dark');document.documentElement.dataset.theme=theme},theme);
    for(const level of ['unknown','debug','info','warn','error','fatal'])await readable(page.locator(`.log-${level} .log-message-preview`),`${theme} ${level} message`);
    await themedBackground(page.locator('.log-table-scroll'),`${theme} session log canvas`);
    await readable(page.locator('.log-table th').first(),`${theme} header`);
    await readable(page.locator('.log-unknown .log-detail-button'),`${theme} detail action`);
    await page.locator('.log-unknown .log-detail-button').hover();
    await page.waitForTimeout(250);
    await readable(page.locator('.log-unknown .log-detail-button'),`${theme} hovered detail action`);
    assert.equal(await page.locator('.log-unknown .log-detail-button').evaluate(element=>getComputedStyle(element).backgroundImage),'none');
    await page.mouse.move(0,0);
    await page.locator('.log-unknown .log-detail-button').focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.locator('.log-unknown .log-detail-button').evaluate(element=>element.matches(':focus-visible')),true);
    await page.waitForTimeout(250);
    await readable(page.locator('.log-unknown .log-detail-button'),`${theme} focused detail action`);
    await page.locator('.log-unknown .log-detail-button').click();
    await readable(page.locator('.offline-log-detail pre'),`${theme} raw detail`);
    assert.equal(await page.locator('.offline-log-detail pre').innerText(),entries[0].raw);
    await page.getByRole('button',{name:'查找 · Ctrl+F',exact:true}).click();
    await readable(page.locator('.log-find .check').first(),`${theme} find options`);
    await readable(page.locator('.log-find input:not([type=checkbox])'),`${theme} find input`);
    await page.locator('.log-find input:not([type=checkbox])').fill('needle');
    await readable(page.locator('.log-unknown mark'),`${theme} highlighted match`);

    await page.goto('https://log-contrast.test/live');
    await page.evaluate(theme=>{document.documentElement.classList.toggle('dark',theme==='dark');document.documentElement.dataset.theme=theme},theme);
    const live=page.getByRole('region',{name:'设备日志',exact:true});
    await live.locator('[data-level="fatal"]').waitFor();
    await themedBackground(live,`${theme} live log canvas`);
    await themedBackground(live.locator('.logColumns'),`${theme} live column header`,'--bg-panel');
    for(const level of ['unknown','debug','info','warn','error','fatal']){
     await readable(live.locator(`[data-level="${level}"] .logMessage`),`${theme} live ${level} message`);
     await readable(live.locator(`[data-level="${level}"] .logLevel`),`${theme} live ${level} level`);
    }
    await readable(live.locator('.logTime').first(),`${theme} live timestamp`);
    await readable(live.getByRole('combobox',{name:'最低日志级别'}),`${theme} live level selector`);
    await live.getByRole('button',{name:'按应用包名过滤'}).click();
    await readable(live.getByRole('option').first(),`${theme} application picker`);
    await themedBackground(live.locator('.logAppPopup'),`${theme} application popup`);
    await live.getByRole('button',{name:'按应用包名过滤'}).click();
    await live.getByRole('button',{name:'查看日志详情',exact:true}).first().click();
    await readable(live.locator('.logDetails pre'),`${theme} live raw detail`);
    await live.press('Control+f');
    await live.getByRole('textbox',{name:'查找保留的筛选结果'}).fill('needle');
    await readable(live.locator('.logMessage mark').first(),`${theme} live highlighted match`);
    await readable(live.locator('.logFind small'),`${theme} live find hint`);
    await live.getByRole('button',{name:'关闭详情',exact:true}).click();
    await live.getByRole('textbox',{name:'筛选日志',exact:true}).fill('needle');
    await readable(live.getByRole('group',{name:'搜索历史'}).getByRole('paragraph'),`${theme} filter history`);
    await themedBackground(live.locator('.logHistory'),`${theme} history popup`);
    await live.getByRole('button',{name:'关闭历史'}).click();
    await live.getByRole('button',{name:'关闭查找'}).click();
    await page.setViewportSize({width:674,height:790});
    if(process.env.PIORA_HARMONY_SCREENSHOT_DIR){
     await mkdir(process.env.PIORA_HARMONY_SCREENSHOT_DIR,{recursive:true});
     await page.screenshot({path:path.join(process.env.PIORA_HARMONY_SCREENSHOT_DIR,`live-${theme}.png`)});
    }
    await page.setViewportSize({width:360,height:800});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${theme} workbench stays within a narrow panel`);
    await page.setViewportSize({width:1100,height:790});
    await page.getByRole('tab',{name:'会话日志',exact:true}).click();
    await page.getByRole('button',{name:'打开 device-session.log',exact:true}).click();
    await readable(page.locator('.library-open .muted'),`${theme} file metadata`);
    await page.mouse.move(0,0);
    await readable(page.locator('.library-open .muted'),`${theme} selected file metadata`);
    await page.locator('.library-open').hover();
    await readable(page.locator('.library-open .muted'),`${theme} hovered selected file metadata`);
    await page.locator('.library-open').focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await readable(page.locator('.library-open .muted'),`${theme} focused selected file metadata`);
    await readable(page.getByRole('button',{name:'导入日志',exact:true}),`${theme} primary import action`);
    await themedBackground(page.locator('.log-table-scroll'),`${theme} opened session log canvas`);
    if(process.env.PIORA_HARMONY_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.PIORA_HARMONY_SCREENSHOT_DIR,`session-${theme}.png`)});
    await page.getByRole('button',{name:'跨文件查找',exact:true}).click();
    await readable(page.getByRole('textbox',{name:'跨文件查找目标'}),`${theme} cross-file query`);
    await readable(page.locator('.session-search-modes legend'),`${theme} search mode label`);
    await themedBackground(page.locator('.session-search-tree'),`${theme} search results canvas`);
    assert.deepEqual(errors,[]);
   }finally{await page.close()}
  });
 }finally{await browser?.close();assert.equal(path.dirname(directory),path.resolve(tmpdir()));await rm(directory,{recursive:true,force:true})}
});
