import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";
const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");
const result = { groups: [
  { id: "g0", title: "界面主题", selectionMode: "single", options: [
    { id: "g0-o0", label: "浅色主题", insertText: "请使用浅色主题。", evidence: "浅色", recommended: false },
    { id: "g0-o1", label: "深色主题", insertText: "请使用深色主题。", evidence: "推荐深色", recommended: true },
  ] },
  { id: "g1", title: "需要的功能", selectionMode: "multiple", options: [
    { id: "g1-o0", label: "添加搜索", insertText: "请添加搜索功能。", evidence: "搜索", recommended: false },
    { id: "g1-o1", label: "支持导出", insertText: "请添加导出功能。", evidence: "导出", recommended: false },
  ] },
] };
async function bundleUI(directory) {
  await writeFile(path.join(directory,"loader.cjs"),`const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
  await writeFile(path.join(directory,"css.cjs"),`module.exports=function(s){const prefix=this.resourcePath.replace(/.*[\\\\/]/,'').replace(/\\W/g,'')+'_';const names=Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],prefix+m[1]]));const css=s.replace(/\\.([a-zA-Z][\\w-]*)/g,(m,n)=>'.'+names[n]);return 'const style=document.createElement("style");style.textContent='+JSON.stringify(css)+';document.head.appendChild(style);export default '+JSON.stringify(names)}`);
  await writeFile(path.join(directory,"entry.tsx"),`
    import React,{useState} from "react";import{createRoot}from"react-dom/client";
    import{I18nProvider}from ${JSON.stringify(path.join(repo,"hooks/useI18n.tsx"))};
    import{ChatInput}from ${JSON.stringify(path.join(repo,"components/ChatInput.tsx"))};
    import{ReplySuggestionsSettings}from ${JSON.stringify(path.join(repo,"components/ReplySuggestionsSettings.tsx"))};
    import{REPLY_DEFAULT_PROMPT}from ${JSON.stringify(path.join(repo,"lib/reply-suggestions.ts"))};
    window.defaultPrompt=REPLY_DEFAULT_PROMPT;window.sent=[];
    function Fixture(){const [session,setSession]=useState('one');const [busy,setBusy]=useState(false);const settings=new URLSearchParams(location.search).has('settings');return <main style={{maxWidth:860,margin:'40px auto',padding:20}}><h1 style={{fontSize:22,fontWeight:500}}>Piora · 快捷回复</h1>{settings?<ReplySuggestionsSettings/>:<><nav style={{display:'flex',gap:12,marginBottom:40}}><button onClick={()=>setSession(session==='one'?'two':'one')}>切换会话</button><button onClick={()=>setBusy(!busy)}>运行状态</button></nav><article style={{lineHeight:1.9,marginBottom:48}}>界面可以选择浅色或深色主题，我推荐深色。<br/>还可以添加搜索和导出功能，这两项可以一起做。你想选择哪些？</article><ChatInput draftKey={'fixture:'+session} isStreaming={busy} replySource={busy?null:{sessionId:session,sourceEntryId:'a',leafId:'a',text:'可以选择浅色或深色，推荐深色，还可以搜索和导出'}} onAbort={()=>setBusy(false)} model={{provider:'fixture',modelId:'chat'}} modelList={[{provider:'fixture',id:'chat',name:'Chat model'}]} onSend={async(text,images,files,onDurable)=>{window.sent.push(text);onDurable?.('receipt');return false}}/></>}</main>}
    localStorage.setItem('pi-locale','zh-CN');document.documentElement.classList.toggle('dark',location.search.includes('dark'));createRoot(document.getElementById('root')).render(<I18nProvider><Fixture/></I18nProvider>);
  `);
  const compiler=webpack({mode:"development",target:"web",devtool:false,entry:path.join(directory,"entry.tsx"),output:{path:directory,filename:"bundle.js"},resolve:{extensions:[".tsx",".ts",".js"],modules:[path.join(repo,"node_modules"),"node_modules"],alias:{"@":repo}},module:{parser:{javascript:{dynamicImportMode:"eager"}},rules:[{test:/\.tsx?$/,exclude:/node_modules/,use:path.join(directory,"loader.cjs")},{test:/\.css$/,use:path.join(directory,"css.cjs")}]},plugins:[new webpack.DefinePlugin({"process.env.NEXT_PUBLIC_APP_VERSION":JSON.stringify("test")})]});
  await new Promise((resolve,reject)=>compiler.run((error,stats)=>compiler.close(()=>error||stats.hasErrors()?reject(error||new Error(stats.toString({all:false,errors:true}))):resolve())));
  return {bundle:await readFile(path.join(directory,"bundle.js")),css:(await readFile(path.join(repo,"app/globals.css"),"utf8")).replace(/@import[^;]+;/g,"")+"\nbody{margin:0;overflow-x:hidden;background:var(--bg);color:var(--text);font-family:Inter,'Microsoft YaHei UI',sans-serif}*{box-sizing:border-box}button{font:inherit}"};
}
test("production chips/settings: guarded edits, keyboard, durable failed sends, refresh and source isolation",{timeout:180_000},async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),"piora-replies-"));let browser, delayed;
  try{
    const {bundle,css}=await bundleUI(directory);
    browser=await chromium.launch({channel:"msedge",headless:true});
    const context=await browser.newContext({viewport:{width:1100,height:880},locale:"zh-CN"});
    const requests=[];
    await context.route("http://localhost:31997/**",async route=>{
      const url=new URL(route.request().url());
      if(url.pathname==="/bundle.js")return route.fulfill({body:bundle,contentType:"application/javascript"});
      if(url.pathname==="/style.css")return route.fulfill({body:css,contentType:"text/css"});
      if(url.pathname==="/api/models")return route.fulfill({json:{modelList:[{provider:"fixture",id:"extract",name:"独立提取模型"}]}});
      if(url.pathname.endsWith("/reply-suggestions")||url.pathname.endsWith("/preview")){requests.push({path:url.pathname,body:route.request().postDataJSON()});if(url.pathname.includes("/two/"))await new Promise(resolve=>{delayed=resolve});return route.fulfill({json:result}).catch(()=>{});}
      if(url.pathname.startsWith("/api/"))return route.fulfill({json:{}});
      return route.fulfill({contentType:"text/html",body:'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/bundle.js"></script>'});
    });
    const page=await context.newPage();const errors=[];page.on("pageerror",e=>errors.push(e.message));
    await page.goto("http://localhost:31997/?settings");
    const enable=page.getByRole("checkbox",{name:"自动提取快捷回复"});assert.equal(await enable.isChecked(),false);
    await page.getByRole("combobox",{name:"提取模型",exact:true}).selectOption(JSON.stringify({provider:"fixture",modelId:"extract"}));
    await page.getByRole("textbox",{name:"提取提示词",exact:true}).fill("只提取明确选项，保留用户原意。");
    await enable.check();await page.getByRole("button",{name:"保存设置"}).click();await page.getByText("已保存",{exact:true}).waitFor();
    await page.getByText("测试提取",{exact:true}).click();await page.getByRole("button",{name:"开始测试"}).click();
    await page.getByRole("button",{name:"深色主题"}).click();assert.equal(await page.getByRole("textbox",{name:"测试输入框"}).inputValue(),"请使用深色主题。");
    assert.equal(requests[0].body.model.modelId,"extract");assert.equal(requests[0].body.systemPrompt,"只提取明确选项，保留用户原意。");
    await page.goto("http://localhost:31997/?dark");
    const dark=page.getByRole("button",{name:"深色主题"});await dark.waitFor();assert.equal(await dark.getAttribute("aria-pressed"),"false");
    const input=page.locator("textarea").first();
    await dark.focus();await dark.press("ArrowLeft");const light=page.getByRole("button",{name:"浅色主题"});await light.press("Space");assert.equal(await light.getAttribute("aria-pressed"),"true");await light.press("Space");assert.equal(await light.getAttribute("aria-pressed"),"false");assert.equal((await page.evaluate(()=>window.sent)).length,0);
    await input.fill("保留我的手写内容");await dark.click();await page.getByRole("button",{name:"添加搜索"}).click();
    assert.equal(await input.inputValue(),"保留我的手写内容\n请使用深色主题。\n请添加搜索功能。");assert.equal((await page.evaluate(()=>window.sent)).length,0);
    await input.press("Control+z");assert.equal(await input.inputValue(),"保留我的手写内容\n请使用深色主题。");await input.press("Control+Shift+z");
    await page.getByRole("button",{name:"浅色主题"}).click();assert.equal(await input.inputValue(),"保留我的手写内容\n请使用浅色主题。\n请添加搜索功能。");
    await input.fill((await input.inputValue()).replace("浅色","暖色"));await dark.click();await page.getByText("这段文字已被手动修改",{exact:true}).waitFor();await page.getByRole("button",{name:"保留修改"}).click();assert.match(await input.inputValue(),/暖色/);
    await dark.click();await page.getByRole("button",{name:"替换这段文字"}).click();assert.match(await input.inputValue(),/深色/);
    // Failed send clears on local receipt, then restores text and chip ownership together.
    await input.press("Enter");await page.waitForFunction(()=>window.sent.length===1);assert.match(await input.inputValue(),/深色/);assert.equal(await dark.getAttribute("aria-pressed"),"true");
    // Wait for the actual IndexedDB transaction rather than a fixed sleep.
    await page.waitForFunction(()=>new Promise(resolve=>{const r=indexedDB.open('piora-composer');r.onsuccess=()=>{const q=r.result.transaction('drafts').objectStore('drafts').get('fixture:one');q.onsuccess=()=>{resolve(q.result?.replySpans?.length===2);r.result.close()}}}));
    await page.reload();await dark.waitFor();await page.waitForFunction(()=>document.querySelector('textarea')?.value.includes('深色'));assert.equal(await dark.getAttribute("aria-pressed"),"true");
    await page.evaluate(()=>new Promise(resolve=>{const r=indexedDB.open('piora-composer');r.onsuccess=()=>{const tx=r.result.transaction('drafts','readwrite');tx.objectStore('drafts').put({value:'未打开会话的持久草稿',images:[],files:[]},'fixture:two');tx.oncomplete=()=>{r.result.close();resolve()}}}));
    await page.getByRole("button",{name:"切换会话"}).click();await page.waitForFunction(()=>document.querySelector('textarea')?.value==='未打开会话的持久草稿');assert.equal(await page.locator("button[aria-pressed]").filter({hasText:/主题|搜索|导出/}).count(),0);
    await page.getByRole("button",{name:"切换会话"}).click();await dark.waitFor();delayed?.();assert.match(await input.inputValue(),/保留我的手写内容/);
    await page.getByRole("button",{name:"运行状态"}).click();assert.equal(await page.locator("button[aria-pressed]").filter({hasText:/主题|搜索|导出/}).count(),0);await page.getByRole("button",{name:"运行状态"}).click();await dark.waitFor();
    const savedDraft=await input.inputValue();
    const bubbles=page.getByRole("region",{name:"快捷回复",exact:true});
    await page.waitForFunction(()=>document.querySelectorAll('section[aria-label="快捷回复"] button').length===4);
    assert.equal(await bubbles.getByRole("button").count(),4);
    assert.equal(await bubbles.innerText(),"浅色主题\n深色主题\n添加搜索\n支持导出");
    const bounds=await bubbles.getByRole("button").evaluateAll(nodes=>nodes.map(node=>({top:node.getBoundingClientRect().top,radius:getComputedStyle(node).borderRadius})));
    assert.ok(bounds.every(b=>b.top===bounds[0].top && b.radius==='999px'));
    const settingsPage=await context.newPage();await settingsPage.goto("http://localhost:31997/?settings");await settingsPage.getByRole("checkbox",{name:"自动提取快捷回复"}).uncheck();await settingsPage.getByRole("button",{name:"保存设置"}).click();await page.waitForFunction(()=>!document.querySelector('section[aria-label="快捷回复"] button'));assert.equal(await input.inputValue(),savedDraft);await settingsPage.getByRole("checkbox",{name:"自动提取快捷回复"}).check();await settingsPage.getByRole("button",{name:"保存设置"}).click();await dark.waitFor();await settingsPage.close();
    const output=path.join(repo,".piora-data","verification","reply-suggestions");await mkdir(output,{recursive:true});await page.screenshot({path:path.join(output,"composer-dark.png"),fullPage:true});await page.locator(".composer-column").screenshot({path:path.join(output,"bubbles-dark.png")});
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(output,"composer-mobile.png"),fullPage:true});assert.ok(await page.getByRole("region",{name:"快捷回复",exact:true}).evaluate(e=>e.getBoundingClientRect().right<=innerWidth));
    await page.setViewportSize({width:1100,height:880});await page.goto("http://localhost:31997/?settings");await page.getByRole("textbox",{name:"提取提示词",exact:true}).waitFor();await page.screenshot({path:path.join(output,"settings-light.png"),fullPage:true});
    assert.deepEqual(errors,[]);
  }finally{delayed?.();await browser?.close();assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir())+path.sep)&&path.basename(directory).startsWith("piora-replies-"));await rm(directory,{recursive:true,force:true,maxRetries:5});}
});
