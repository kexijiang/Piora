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
    import{getDraft}from ${JSON.stringify(path.join(repo,"lib/draft-store.ts"))};
    import{readComposerRecord}from ${JSON.stringify(path.join(repo,"lib/reply-storage.ts"))};
    window.readComposerRecord=readComposerRecord;window.getDraft=getDraft;
    window.defaultPrompt=REPLY_DEFAULT_PROMPT;window.sent=[];
    function Fixture(){const [session,setSession]=useState('one');const [busy,setBusy]=useState(false);const settings=new URLSearchParams(location.search).has('settings');return <main style={{maxWidth:860,margin:'40px auto',padding:20}}><h1 style={{fontSize:22,fontWeight:500}}>Piora · 快捷回复</h1>{settings?<ReplySuggestionsSettings/>:<><nav style={{display:'flex',gap:12,marginBottom:40}}><button onClick={()=>setSession(session==='one'?'two':'one')}>切换会话</button><button onClick={()=>setBusy(!busy)}>运行状态</button></nav><article style={{lineHeight:1.9,marginBottom:48}}>界面可以选择浅色或深色主题，我推荐深色。<br/>还可以添加搜索和导出功能，这两项可以一起做。你想选择哪些？</article><ChatInput ref={handle=>{window.composer=handle}} draftKey={'fixture:'+session} isStreaming={busy} replySource={busy?null:{sessionId:session,sourceEntryId:'a',leafId:'a',text:'可以选择浅色或深色，推荐深色，还可以搜索和导出'}} onAbort={()=>setBusy(false)} model={{provider:'fixture',modelId:'chat'}} modelList={[{provider:'fixture',id:'chat',name:'Chat model'}]} onSend={async(text,images,files,onDurable)=>{window.sent.push(text);onDurable?.('receipt');return false}}/></>}</main>}
    localStorage.setItem('pi-locale','zh-CN');document.documentElement.classList.toggle('dark',location.search.includes('dark'));createRoot(document.getElementById('root')).render(<I18nProvider><Fixture/></I18nProvider>);
  `);
  const compiler=webpack({mode:"development",target:"web",devtool:false,entry:path.join(directory,"entry.tsx"),output:{path:directory,filename:"bundle.js"},resolve:{extensions:[".tsx",".ts",".js"],modules:[path.join(repo,"node_modules"),"node_modules"],alias:{"@":repo}},module:{parser:{javascript:{dynamicImportMode:"eager"}},rules:[{test:/\.tsx?$/,exclude:/node_modules/,use:path.join(directory,"loader.cjs")},{test:/\.css$/,use:path.join(directory,"css.cjs")}]},plugins:[new webpack.DefinePlugin({"process.env.NEXT_PUBLIC_APP_VERSION":JSON.stringify("test")})]});
  await new Promise((resolve,reject)=>compiler.run((error,stats)=>compiler.close(()=>error||stats.hasErrors()?reject(error||new Error(stats.toString({all:false,errors:true}))):resolve())));
  return {bundle:await readFile(path.join(directory,"bundle.js")),css:(await readFile(path.join(repo,"app/globals.css"),"utf8")).replace(/@import[^;]+;/g,"")+"\nbody{margin:0;overflow-x:hidden;background:var(--bg);color:var(--text);font-family:Inter,'Microsoft YaHei UI',sans-serif}*{box-sizing:border-box}button{font:inherit}"};
}
test("prediction is optional, Tab only edits, typing hides it and cached rounds are reused", {timeout:120000}, async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),"piora-predict-"));let browser;
 try{
  const {bundle,css}=await bundleUI(directory);browser=await chromium.launch({channel:process.platform==="win32"?"msedge":"chromium",headless:true});const page=await browser.newPage();let calls=0;
  await page.route("http://localhost:31997/**",async route=>{const url=route.request().url();if(url.endsWith('/bundle.js'))return route.fulfill({body:bundle,contentType:'text/javascript'});if(url.endsWith('/style.css'))return route.fulfill({body:css,contentType:'text/css'});if(url.endsWith('/input-prediction')){calls++;return route.fulfill({json:{text:'请继续补充测试。'}})}if(url.includes('/api/'))return route.fulfill({json:{}});return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/bundle.js"></script>'});});
  await page.goto('http://localhost:31997');const input=page.locator('textarea').first();await input.waitFor();await page.waitForTimeout(1000);assert.equal(calls,0);
  await page.evaluate(()=>{localStorage.setItem('piora-input-prediction-v1',JSON.stringify({enabled:true,model:{provider:'fixture',modelId:'small'},timeoutMs:5000}));window.dispatchEvent(new Event('piora:input-prediction'))});
  await page.getByPlaceholder('请继续补充测试。',{exact:true}).waitFor();assert.equal(await input.inputValue(),'');await input.press('Tab');assert.equal(await input.inputValue(),'请继续补充测试。');assert.deepEqual(await page.evaluate(()=>window.sent),[]);
  await input.fill('我的输入');await page.waitForFunction(async()=> (await window.readComposerRecord('drafts','fixture:one'))?.value === '我的输入');assert.notEqual(await input.getAttribute('placeholder'),'请继续补充测试。');await input.fill('');await page.getByPlaceholder('请继续补充测试。',{exact:true}).waitFor();
  await page.waitForFunction(async()=> !(await window.readComposerRecord('drafts','fixture:one'))?.value);
  await page.reload();await page.getByPlaceholder('请继续补充测试。',{exact:true}).waitFor();assert.equal(calls,1);
 }finally{await browser?.close();await rm(directory,{recursive:true,force:true});}
});
