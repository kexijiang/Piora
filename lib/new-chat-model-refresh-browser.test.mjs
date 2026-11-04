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

test("new chat drops removed selections, preserves valid choices and never invents an empty-catalog default", {timeout:120000}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-new-model-"));
  let browser;
  try {
    await writeFile(path.join(directory,"loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory,"entry.tsx"), `import React from 'react';import{createRoot}from'react-dom/client';import{I18nProvider}from'@/hooks/useI18n';import{useAgentSession}from'@/hooks/useAgentSession';function App(){const[key,setKey]=React.useState(0);const state=useAgentSession({session:null,newSessionCwd:'C:/fixture',newSessionInitialModel:{provider:'alpha',modelId:'old'},modelsRefreshKey:key,onAgentEnd:()=>{}});window.state=state;return <><button onClick={()=>setKey(k=>k+1)}>刷新模型</button><output>{state.displayModel?.modelId??'empty'}</output></>}createRoot(document.getElementById('root')).render(<I18nProvider><App/></I18nProvider>);`);
    const compiler = webpack({mode:"development",target:"web",devtool:false,entry:path.join(directory,"entry.tsx"),output:{path:directory,filename:"bundle.js"},resolve:{extensions:[".tsx",".ts",".js"],modules:[path.join(repo,"node_modules")],alias:{"@":repo}},module:{rules:[{test:/\.tsx?$/,exclude:/node_modules/,use:path.join(directory,"loader.cjs")}]}});
    await new Promise((resolve,reject)=>compiler.run((error,stats)=>compiler.close(()=>error||stats.hasErrors()?reject(error||new Error(stats.toString({all:false,errors:true}))):resolve())));
    browser = await chromium.launch({channel:process.platform==="win32"?"msedge":"chromium",headless:true});
    const page = await browser.newPage();
    let ids = ["first","old"], modelError;
    let catalogRequests = 0;
    await page.route("https://new-model.test/**", async route => {
      const url = new URL(route.request().url());
      if(url.pathname==="/bundle.js") return route.fulfill({contentType:"text/javascript",body:await readFile(path.join(directory,"bundle.js"))});
      if(url.pathname==="/api/models") { catalogRequests++; return route.fulfill({json:{models:Object.fromEntries(ids.map(id=>[`alpha:${id}`,id])),modelList:ids.map(id=>({id,name:id,provider:"alpha"})),defaultModel:ids.length?{provider:"alpha",modelId:ids[0]}:null,modelError}}); }
      if(url.pathname.startsWith("/api/")) return route.fulfill({json:{commands:[],state:{isStreaming:false}}});
      return route.fulfill({contentType:"text/html",body:'<div id="root"></div><script src="/bundle.js"></script>'});
    });
    await page.goto("https://new-model.test/");
    await page.waitForFunction(()=>window.state?.modelList.length===2);
    assert.equal(await page.locator("output").textContent(),"old");
    ids=["new"];
    await page.getByRole("button",{name:"刷新模型"}).click();
    await page.waitForFunction(()=>window.state?.displayModel?.modelId==='new');
    assert.equal(await page.evaluate(()=>window.state.newSessionModel),null);
    ids=[];
    await page.getByRole("button",{name:"刷新模型"}).click();
    await page.waitForFunction(()=>window.state?.displayModel===null);
    assert.equal(await page.locator("output").textContent(),"empty");
    ids=["restored"];
    await page.getByRole("button",{name:"刷新模型"}).click();
    await page.waitForFunction(()=>window.state?.displayModel?.modelId==='restored');
    assert.ok(catalogRequests>=4);
  } finally {
    await browser?.close();
    await rm(directory,{recursive:true,force:true});
  }
});
