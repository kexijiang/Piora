import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
const require=createRequire(import.meta.url),{webpack}=require('next/dist/compiled/webpack/webpack.js');
const repo=path.resolve(import.meta.dirname,'..');

test('log exports use native desktop downloads and preserve web streaming, limits and cancellation',{timeout:120000},async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'piora-log-download-'));let browser,server;
 const rows=[{id:1,sourceLine:1,timestamp:'12:00:00',level:'INFO',message:'needle 第一行',raw:'needle 第一行'},{id:2,sourceLine:2,timestamp:'12:00:01',level:'INFO',message:'needle 第二页',raw:'needle 第二页'}];
 const exported=rows.map(row=>JSON.stringify(row)).join('\n')+'\n';
 try{
  await writeFile(path.join(directory,'loader.cjs'),`const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
  await writeFile(path.join(directory,'entry.tsx'),`import React from'react';import{createRoot}from'react-dom/client';import{LogViewer}from'@/components/workspace/harmony/log-workbench/LogViewer.jsx';import{saveLogSnapshot,exportFilteredLogs}from'@/lib/harmony-log-download';window.saveSnapshot=()=>saveLogSnapshot(new File(['真实快照\\r\\nsecond line\\r\\n'],'snapshot.log',{type:'text/plain'}));window.rejectExternal=()=>exportFilteredLogs('https://untrusted.test/api/harmony/log-library/export');createRoot(document.getElementById('root')).render(<LogViewer sessionId="A" url="/api/harmony/log-library/logs?sessionId=A&id=file-A" exportUrl="/api/harmony/log-library/export?sessionId=A&id=file-A"/>);`);
  const compiler=webpack({mode:'development',target:'web',devtool:false,entry:path.join(directory,'entry.tsx'),output:{path:directory,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.jsx','.js'],modules:[path.join(repo,'node_modules')],alias:{'@':repo}},module:{rules:[{test:/\.[jt]sx?$/,exclude:/node_modules/,use:path.join(directory,'loader.cjs')}]}});
  await new Promise((resolve,reject)=>compiler.run((error,stats)=>compiler.close(()=>error||stats.hasErrors()?reject(error||Error(stats.toString({all:false,errors:true}))):resolve())));
  browser=await chromium.launch({channel:process.platform==='win32'?'msedge':'chromium',headless:true});
  for(const mode of ['desktop','web-stream','web-blob','web-limit','web-cancel']){
   const page=await browser.newPage({acceptDownloads:true}),errors=[],requests=[];
   page.on('pageerror',error=>errors.push(error.message));
   await page.addInitScript(mode=>{
    window.pickerCalls=0;window.written=[];window.writerClosed=false;window.writerAborted=false;
    if(mode==='desktop')window.piDesktop={platform:'win32'};
    if(mode==='web-blob'||mode==='web-limit')Object.defineProperty(window,'showSaveFilePicker',{configurable:true,value:undefined});
    else Object.defineProperty(window,'showSaveFilePicker',{configurable:true,value:async()=>{
     window.pickerCalls++;
     if(mode==='desktop')throw new DOMException('The request is not allowed by the user agent','NotAllowedError');
     if(mode==='web-cancel')throw new DOMException('Cancelled','AbortError');
     return{createWritable:async()=>({write:async value=>window.written.push(...new Uint8Array(value)),close:async()=>{window.writerClosed=true},abort:async()=>{window.writerAborted=true}})};
    }});
   },mode);
   server=createServer(async(request,response)=>{
    const url=new URL(request.url,'http://127.0.0.1');
    const send=(body,type='application/json',headers={})=>{response.writeHead(200,{'content-type':type,...headers});response.end(body)};
    if(url.pathname.endsWith('.js'))return send(await readFile(path.join(directory,path.basename(url.pathname))),'text/javascript');
    if(url.pathname==='/api/harmony/log-library/logs')return send(JSON.stringify({total:rows.length,filteredTotal:rows.length,entries:rows.slice(0,1),nextOffset:1}));
    if(url.pathname==='/api/harmony/log-library/export'){
     requests.push(url);return send(mode==='web-limit'?'x'.repeat(8*1024*1024+1):exported,'application/x-ndjson',{'content-disposition':'attachment; filename=filtered-logs.jsonl'});
    }
    if(url.pathname.startsWith('/api/'))return send(JSON.stringify({filter:[],find:[],favorites:[],bundleFavorites:[]}));
    return send('<meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>','text/html');
   });
   await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
   await page.goto(`http://127.0.0.1:${server.address().port}/`);
   await page.getByRole('button',{name:'导出筛选结果',exact:true}).waitFor();
   if(mode==='desktop'||mode==='web-blob'){
    const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'导出筛选结果',exact:true}).click();const download=await downloading;
    assert.equal(download.suggestedFilename(),'filtered-logs.jsonl');assert.equal(await readFile(await download.path(),'utf8'),exported,'exports include the row beyond the visible page');
    await page.getByRole('status').filter({hasText:'已发起下载'}).waitFor();
    assert.equal(await page.evaluate(()=>window.pickerCalls),0);
   }else if(mode==='web-stream'){
    await page.getByRole('button',{name:'导出筛选结果',exact:true}).click();await page.getByRole('status').filter({hasText:'筛选结果已保存'}).waitFor();
    const write=await page.evaluate(()=>({text:new TextDecoder().decode(new Uint8Array(window.written)),closed:window.writerClosed,aborted:window.writerAborted,picks:window.pickerCalls}));
    assert.deepEqual(write,{text:exported,closed:true,aborted:false,picks:1});
   }else if(mode==='web-limit'){
    await page.getByRole('button',{name:'导出筛选结果',exact:true}).click();await page.getByRole('alert').filter({hasText:'超过 8 MiB'}).waitFor();
    assert.equal(await page.getByText('筛选结果已保存',{exact:true}).count(),0);
   }else{
    await page.getByRole('button',{name:'导出筛选结果',exact:true}).click();assert.equal(requests.length,0);assert.equal(await page.getByRole('alert').count(),0);assert.equal(await page.getByRole('button',{name:'导出筛选结果',exact:true}).isEnabled(),true);
   }
   if(mode!=='web-cancel'){
    assert.equal(requests.length,1);assert.equal(requests[0].searchParams.get('sessionId'),'A');assert.equal(requests[0].searchParams.get('id'),'file-A');assert.equal(requests[0].searchParams.has('offset'),false);
   }
   if(mode==='desktop'){
    const snapshot=page.waitForEvent('download');await page.evaluate(()=>window.saveSnapshot());const download=await snapshot;
    assert.equal(download.suggestedFilename(),'snapshot.log');assert.equal(await readFile(await download.path(),'utf8'),'真实快照\r\nsecond line\r\n');assert.equal(await page.evaluate(()=>window.pickerCalls),0);
    assert.match(await page.evaluate(()=>window.rejectExternal().catch(error=>error.message)),/只能下载当前应用/);
   }
   assert.deepEqual(errors,[]);await page.close();await new Promise(resolve=>server.close(resolve));server=undefined;
  }
 }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}assert.equal(path.dirname(directory),path.resolve(tmpdir()));await rm(directory,{recursive:true,force:true})}
});
