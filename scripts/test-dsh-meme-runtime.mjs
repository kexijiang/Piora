import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import JSZip from 'jszip';
import { createJiti } from 'jiti';
import { DshMemeManager } from '../.verification/meme-desktop/dsh-meme-manager.js';
const root=path.resolve('.verification/dsh-meme-runtime');
let panelFinished=false;
const manager=new DshMemeManager({root,host:path.resolve('.verification/meme-desktop/dsh-meme-host.js'),model:async input=>input.action==='check'?true:'{"tag":"happy","caption":"fixture recognition","keywords":"fixture"}',openPanel:async(url,token)=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try {
  const context=await browser.newContext({extraHTTPHeaders:{Authorization:`Bearer ${token}`}}); const page=await context.newPage();
  await page.goto(url); await page.locator('#piora-gear').waitFor();
  await page.waitForFunction(()=>document.querySelectorAll('#piora-pack option').length>0);
  await page.locator('#piora-gear').selectOption('active');
  await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('已完成'));
  await page.reload(); await page.waitForFunction(()=>document.querySelector('#piora-gear')?.value==='active');
  await page.locator('#piora-mode').selectOption('text');
  await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('已完成'));
  await page.reload(); await page.waitForFunction(()=>document.querySelector('#piora-mode')?.value==='text');
  await page.locator('#piora-mode').selectOption('auto');
  await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('已完成'));
  await page.locator('#piora-pack').selectOption('dafeiyu-001');
  await page.waitForFunction(()=>document.querySelectorAll('#grid img').length>=24&&Array.from(document.querySelectorAll('#grid img')).slice(0,4).every(img=>img.complete&&img.naturalWidth>0));
  await page.screenshot({path:'.verification/dsh-meme-panel.png',fullPage:false});
  const untrusted=await fetch(url);assert.equal(untrusted.status,403);
  const blocked=await fetch(new URL('/dsh-memes-api',url),{method:'POST',headers:{Authorization:`Bearer ${token}`,Origin:'https://evil.invalid','Content-Type':'application/json'},body:JSON.stringify({op:'setSendGear',gear:'off'})});assert.equal(blocked.status,403);
  const download=page.waitForEvent('download');await page.locator('#piora-export').click();const exported=await download;await exported.saveAs('.verification/dsh-meme-export.zip');
  const archive=await JSZip.loadAsync(fs.readFileSync('.verification/dsh-meme-export.zip'));assert.ok(archive.file('index.db'));
  const zip=new JSZip();zip.file('happy/probe.png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'));
  fs.writeFileSync('.verification/dsh-meme-import.zip',await zip.generateAsync({type:'nodebuffer'}));
  await page.locator('#piora-zip-file').setInputFiles('.verification/dsh-meme-import.zip');
  await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('已完成'));
  console.log('PASS UI frequency/mode persistence, images, ZIP export/import, unauthorized access and CSRF');panelFinished=true;
 }finally{await browser.close();}
},closePanel:()=>{}});
async function settled(){for(let i=0;i<900;i++){await new Promise(r=>setTimeout(r,1000));const s=manager.status();if(i%10===0)console.log(s.phase,s.progress?.stage,s.progress?.received);if(!['installing','starting','stopping'].includes(s.phase)){if(s.error)throw Error(s.error);return s;}}throw Error('timeout');}
try {
 if(!manager.status().installed){manager.action('install');await settled();}
 assert.equal(manager.status().version,'0.1.76');manager.action('start');await settled();assert.equal(manager.status().phase,'running');
 const call=async(path,body)=>{const r=await manager.http(path,body?'POST':'GET',body?JSON.stringify(body):undefined);console.log('RESPONSE',path,r.status);return JSON.parse(Buffer.from(r.data,'base64').toString());};
 const schemas=await call('/__piora',{action:'schemas'});assert.equal(schemas.length,4);
 const catalog=await call('/dsh-memes-api?packId=all');assert.ok(catalog.memes.length>=24);
 const list=await call('/__piora',{action:'tool',name:'meme_list',args:{limit:2}});assert.equal(list.ok,true);
 const send=await call('/__piora',{action:'tool',name:'send_meme',args:{query:'得意',limit:2}});assert.equal(send.ok,true);
 const prompt=await call('/__piora',{action:'prompt'});assert.match(prompt,/斗图/);
 const image=await manager.http(catalog.memes[0].url);assert.equal(image.status,200);assert.match(image.mime,/image/);
 const jiti=createJiti(import.meta.url); const originalBridge={send:process.send,connected:process.connected,ipc:process.env.PIORA_DESKTOP_NETWORK_IPC,agent:process.env.PI_CODING_AGENT_DIR};
 process.env.PIORA_DESKTOP_NETWORK_IPC='1';process.env.PI_CODING_AGENT_DIR=path.join(root,'test-agent');process.connected=true;
 process.send=(message,callback)=>{const {path:route,method,body}=message.value||{};void (message.action==='status'?Promise.resolve(manager.status()):manager.http(route,method,body)).then(value=>process.emit('message',{type:'pi-desktop:meme-response',requestId:message.requestId,ok:true,value}),error=>process.emit('message',{type:'pi-desktop:meme-response',requestId:message.requestId,ok:false,error:error.message}));callback?.();return true;};
 try {
  const register=(await jiti.import('../extensions/piora-meme.ts')).default;const registrations=new Map();register({registerTool:tool=>registrations.set(tool.name,tool),on(){}});
  const value=await registrations.get('send_meme').execute('probe',{query:'得意',limit:2},new AbortController().signal,undefined,{sessionManager:{getBranch:()=>[]}});
  assert.match(value.content[0].text,/!\[.*\]\(\/api\/memes\/[a-f0-9]{64}\)/);
  const id=value.content[0].text.match(/\/api\/memes\/([a-f0-9]{64})/)[1];
  assert.ok(fs.statSync(path.join(root,'test-agent','piora','memes',id)).size>0);
  console.log('PASS Piora tool bridge and immutable Markdown image capture');
 }finally{
  process.send=originalBridge.send;process.connected=originalBridge.connected;
  for(const[key,value]of [['PIORA_DESKTOP_NETWORK_IPC',originalBridge.ipc],['PI_CODING_AGENT_DIR',originalBridge.agent]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 }

 const updated=await call('/__piora',{action:'tool',name:'meme_update',args:{path:list.rows[0].path,keywords:'runtime-test'}});assert.equal(updated.ok,true);
 const learned=await call('/__piora',{action:'tool',name:'learn_meme',args:{},images:[{id:'fixture',data:image.data,mediaType:image.mime,name:'fixture.jpg'}],selection:{provider:'fixture',model:'fixture'}});assert.equal(learned.ok,true);
 manager.action('settings');for(let i=0;i<120&&!panelFinished;i++){await new Promise(r=>setTimeout(r,500));if(manager.status().error)throw Error(manager.status().error);}assert.ok(panelFinished);
 console.log('PASS original plugin install/start/list/send/prompt/image/panel');
}finally{await manager.dispose();assert.equal(manager.status().phase,'stopped');}
