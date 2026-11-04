import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("room requests route identical IDs to their own members, preserve failed input, and dismiss on expiry or reconciliation", {timeout:120000}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-new-model-"));
  let browser;
  try {
    await writeFile(path.join(directory,"loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory,"css.cjs"), `module.exports=()=>"export default {}"`);
    await writeFile(path.join(directory,"entry.tsx"), `import React from 'react';import{createRoot}from'react-dom/client';import{I18nProvider}from'@/hooks/useI18n';import{RoomRequests}from'@/components/RoomRequests';
window.sent=[];window.fail=false;window.fetch=async(url,options)=>{window.sent.push({url,body:JSON.parse(options.body)});return new Response(JSON.stringify(window.fail?{error:'保存失败'}:{success:true}),{status:window.fail?500:200})};
function App(){const[requests,setRequests]=React.useState([]);window.setRequests=setRequests;return <RoomRequests requests={requests}/>};createRoot(document.getElementById('root')).render(<I18nProvider><App/></I18nProvider>);`);
    const compiler = webpack({mode:"development",target:"web",devtool:false,entry:path.join(directory,"entry.tsx"),output:{path:directory,filename:"bundle.js"},resolve:{extensions:[".tsx",".ts",".js"],modules:[path.join(repo,"node_modules")],alias:{"@":repo}},module:{rules:[{test:/\.tsx?$/,exclude:/node_modules/,use:path.join(directory,"loader.cjs")},{test:/\.css$/,use:path.join(directory,"css.cjs")}]}});
    await new Promise((resolve,reject)=>compiler.run((error,stats)=>compiler.close(()=>error||stats.hasErrors()?reject(error||new Error(stats.toString({all:false,errors:true}))):resolve())));
    browser = await chromium.launch({channel:process.platform==="win32"?"msedge":"chromium",headless:true});
    const page = await browser.newPage();
    await page.addInitScript(()=>localStorage.setItem('pi-locale','zh-CN'));
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route("https://new-model.test/**", async route => {
      if(new URL(route.request().url()).pathname==="/bundle.js") return route.fulfill({contentType:"text/javascript",body:await readFile(path.join(directory,"bundle.js"))});
      return route.fulfill({contentType:"text/html",body:'<meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>'});
    });
    await page.goto("https://new-model.test/");
    await page.waitForFunction(()=>typeof window.setRequests==='function');
    const request=(sessionId,method='confirm',extra={})=>({sessionId,memberId:sessionId,memberName:sessionId,request:{type:'extension_ui_request',id:'same',method,title:'请求',message:'执行命令',...extra}});
    await page.evaluate(items=>window.setRequests(items),[request('甲'),request('乙')]);
    await page.waitForFunction(()=>document.querySelector('[role=dialog]'));
    await page.getByRole('button',{name:'确认',exact:true}).click();
    await page.waitForFunction(()=>window.sent.length===1);
    assert.equal(await page.evaluate(()=>window.sent[0].url),'/api/agent/甲'.replace('甲',encodeURIComponent('甲')));
    await page.getByRole('button',{name:'取消',exact:true}).click();
    await page.waitForFunction(()=>window.sent.length===2);
    assert.equal(await page.evaluate(()=>window.sent[1].body.cancelled),true);
    await page.evaluate(items=>{window.fail=true;window.setRequests(items)},[request('丙','input')]);
    await page.getByRole('textbox').fill('保留草稿');
    await page.evaluate(items=>window.setRequests(items),[request('丙','input')]);
    assert.equal(await page.getByRole('textbox').inputValue(),'保留草稿');
    await page.getByRole('button',{name:'提交',exact:true}).click();
    await page.getByRole('alert').waitFor();
    assert.equal(await page.getByRole('textbox').inputValue(),'保留草稿');
    await page.evaluate(()=>window.fail=false);
    await page.getByRole('button',{name:'提交',exact:true}).click();
    await page.getByRole('textbox').waitFor({state:'detached'});
    await page.evaluate(items=>window.setRequests(items),[request('丁','confirm',{expiresAt:Date.now()+800})]);
    await page.getByRole('dialog').waitFor();
    await page.getByRole('dialog').waitFor({state:'detached'});
    await page.evaluate(items=>window.setRequests(items),[request('戊')]);
    await page.getByRole('dialog').waitFor();
    await page.evaluate(()=>window.setRequests([]));
    await page.getByRole('dialog').waitFor({state:'detached'});
    assert.deepEqual(errors,[]);
  } finally {
    await browser?.close();
    await rm(directory,{recursive:true,force:true});
  }
});
