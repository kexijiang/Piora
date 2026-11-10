import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {chromium} from 'playwright-core';

const require=createRequire(import.meta.url),{webpack}=require('next/dist/compiled/webpack/webpack.js');
const repo=path.resolve(import.meta.dirname,'..');

async function readable(locator,label){
 await locator.waitFor();
 const contrast=await locator.evaluate(element=>{
  const rgb=value=>value.match(/[\d.]+/g).map(Number);
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

test('plain offline logs, raw details and find controls remain readable across actual theme palettes',{timeout:120000},async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'piora-log-contrast-'));let browser;
 try{
  await writeFile(path.join(directory,'loader.cjs'),`const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
  await writeFile(path.join(directory,'entry.tsx'),`import React from'react';import{createRoot}from'react-dom/client';import{LogViewer}from'@/components/workspace/harmony/log-workbench/LogViewer.jsx';createRoot(document.getElementById('root')).render(<div className="piora-log-workbench"><LogViewer url="/api/harmony/log-library/logs?sessionId=contrast&id=plain" exportUrl="/api/harmony/log-library/export?sessionId=contrast&id=plain"/></div>);`);
  const compiler=webpack({mode:'development',target:'web',devtool:false,entry:path.join(directory,'entry.tsx'),output:{path:directory,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.jsx','.js'],modules:[path.join(repo,'node_modules')],alias:{'@':repo}},module:{rules:[{test:/\.[jt]sx?$/,exclude:/node_modules/,use:path.join(directory,'loader.cjs')}]}});
  await new Promise((resolve,reject)=>compiler.run((error,stats)=>compiler.close(()=>error||stats.hasErrors()?reject(error||Error(stats.toString({all:false,errors:true}))):resolve())));
  const globals=await readFile(path.join(repo,'app/globals.css'),'utf8');
  const selectors=[':root','html.dark','html[data-theme="cloud-bear"]'];
  const palette=selectors.map(selector=>{const start=globals.indexOf(selector+' {');assert.ok(start>=0);return globals.slice(start,globals.indexOf('}',start)+1)}).join('\n');
  const css=await readFile(path.join(repo,'components/workspace/harmony/log-workbench/log-workbench.css'),'utf8'),bundle=await readFile(path.join(directory,'bundle.js'));
  const entries=['unknown','info','error'].map((level,index)=>({id:index+1,sourceLine:index+1,level,message:'needle 普通文本正文 '+level,raw:'needle 普通文本原始行 '+level}));
  browser=await chromium.launch({channel:process.platform==='win32'?'msedge':'chromium',headless:true});
  for(const theme of ['light','dark','cloud-bear'])await t.test(theme,async()=>{
   const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
   page.on('pageerror',error=>errors.push(error.message));
   try{
    await page.route('https://log-contrast.test/**',route=>{
     const url=new URL(route.request().url());
     if(url.pathname==='/bundle.js')return route.fulfill({contentType:'text/javascript',body:bundle});
     if(url.pathname==='/api/harmony/log-library/logs')return route.fulfill({json:{total:3,filteredTotal:3,entries:url.searchParams.has('fullMessage')?[entries[0]]:entries}});
     if(url.pathname.startsWith('/api/'))return route.fulfill({json:{filter:[],find:[],favorites:[],bundleFavorites:[]}});
     return route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><style>${palette}html{font-size:14px}body{margin:0;color:var(--text);background:var(--bg)}#root{height:100vh}${css}</style><div id="root"></div><script src="/bundle.js"></script>`});
    });
    await page.goto('https://log-contrast.test/');
    await page.evaluate(theme=>{document.documentElement.classList.toggle('dark',theme==='dark');document.documentElement.dataset.theme=theme},theme);
    for(const level of ['unknown','info','error'])await readable(page.locator(`.log-${level} .log-message-preview`),`${theme} ${level} message`);
    await readable(page.locator('.log-table th').first(),`${theme} header`);
    await readable(page.locator('.log-unknown .log-detail-button'),`${theme} detail action`);
    await page.locator('.log-unknown .log-detail-button').hover();
    await readable(page.locator('.log-unknown .log-detail-button'),`${theme} hovered detail action`);
    await page.locator('.log-unknown .log-detail-button').click();
    await readable(page.locator('.offline-log-detail pre'),`${theme} raw detail`);
    assert.equal(await page.locator('.offline-log-detail pre').innerText(),entries[0].raw);
    await page.getByRole('button',{name:'查找 · Ctrl+F',exact:true}).click();
    await readable(page.locator('.log-find .check').first(),`${theme} find options`);
    await readable(page.locator('.log-find input:not([type=checkbox])'),`${theme} find input`);
    await page.locator('.log-find input:not([type=checkbox])').fill('needle');
    await readable(page.locator('.log-unknown mark'),`${theme} highlighted match`);
    assert.deepEqual(errors,[]);
   }finally{await page.close()}
  });
 }finally{await browser?.close();assert.equal(path.dirname(directory),path.resolve(tmpdir()));await rm(directory,{recursive:true,force:true})}
});
