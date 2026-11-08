import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';import {chromium} from 'playwright-core';
const require=createRequire(import.meta.url),{webpack}=require('next/dist/compiled/webpack/webpack.js'),repo=path.resolve(import.meta.dirname,'..');
test('storage paths are immediately editable and automatically saved without stale responses', {timeout:90000}, async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'piora-storage-'));let browser;
 try{
  await writeFile(path.join(dir,'loader.cjs'),`const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
  await writeFile(path.join(dir,'stub.tsx'),`import React from 'react';export const useI18n=()=>({t:key=>key});export const AliIcon=()=>null;`);
  await writeFile(path.join(dir,'entry.tsx'),`import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{HarmonyStorageSettings}from'@/components/HarmonyStorageSettings';function Fixture(){const[show,setShow]=useState(true);window.closeFixture=()=>setShow(false);return show?<HarmonyStorageSettings/>:null}createRoot(document.getElementById('root')).render(<Fixture/>);`);
  const c=webpack({mode:'development',target:'web',devtool:false,entry:path.join(dir,'entry.tsx'),output:{path:dir,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.js'],modules:[path.join(repo,'node_modules')],alias:{'@/hooks/useI18n':path.join(dir,'stub.tsx'),'@/components/AliIcon':path.join(dir,'stub.tsx'),'@':repo}},module:{rules:[{test:/\.tsx?$/,exclude:/node_modules/,use:path.join(dir,'loader.cjs')}]}});
  await new Promise((resolve,reject)=>c.run((e,s)=>c.close(()=>e||s.hasErrors()?reject(e||Error(s.toString({all:false,errors:true}))):resolve())));
  browser=await chromium.launch({channel:process.platform==='win32'?'msedge':'chromium',headless:true});const page=await browser.newPage(),writes=[];
  await page.addInitScript(()=>{window.piDesktop={selectDirectory:async()=> 'C:\\chosen'};});
  await page.route('https://storage.test/**',async route=>{let r=route.request(),u=new URL(r.url());if(u.pathname==='/bundle.js')return route.fulfill({contentType:'text/javascript',body:await readFile(path.join(dir,'bundle.js'))});if(u.pathname==='/api/harmony/config'){if(r.method()==='PUT'){let value=r.postDataJSON().storage;writes.push(value);await new Promise(resolve=>setTimeout(resolve,500));return route.fulfill({json:{storage:value??{screenshotDirectory:'C:\\default',recordingDirectory:'C:\\default'}}});}return route.fulfill({json:{storage:{screenshotDirectory:'C:\\first',recordingDirectory:'C:\\second'}}});}return route.fulfill({contentType:'text/html',body:'<div id="root"></div><script src="/bundle.js"></script>'});});
  await page.goto('https://storage.test/');const first=page.getByLabel('harmonyStorage.screenshotDirectory'),second=page.getByLabel('harmonyStorage.recordingDirectory');await first.waitFor();await page.waitForFunction(()=>document.querySelector('input')?.value==='C:\\first');
  assert.equal(await page.getByRole('switch').count(),0);assert.equal(await first.isEnabled(),true);assert.equal(await second.isEnabled(),true);
  await first.fill('C:\\new');await page.waitForTimeout(850);await second.fill('C:\\later');await page.waitForTimeout(1800);
  assert.equal(writes.at(-1).screenshotDirectory,'C:\\new');assert.equal(writes.at(-1).recordingDirectory,'C:\\later');assert.equal(await second.inputValue(),'C:\\later');
  await page.getByLabel('harmonyStorage.choose').first().click();await page.waitForTimeout(1100);assert.equal(writes.at(-1).screenshotDirectory,'C:\\chosen');
  await first.fill('C:\\closed');await page.evaluate(()=>window.closeFixture());await page.waitForTimeout(1000);assert.equal(writes.at(-1).screenshotDirectory,'C:\\closed','closing immediately still saves the last edit');
 }finally{await browser?.close();await rm(dir,{recursive:true,force:true})}
});
