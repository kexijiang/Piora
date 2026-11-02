import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {heldInputPlan} from '../../../lib/mini-app-fixtures.mjs';
import {abortable,isolatedEnvironment,startProcess,stopProcess} from '../lifecycle.mjs';
import {desktopDevelopmentEnvironment} from '../../desktop-dev-environment.mjs';

const execute=promisify(execFile),provider='desktop-window-fixture',model='held-input-fixture',callId='window-held-input';
const text=m=>typeof m.content==='string'?[m.content]:(m.content??[]).filter(p=>p.type==='text').map(p=>p.text);
export const intelligentUiWindow={
 nativeWindowState:true,
 id:'intelligent-ui-window',mode:'local-model-fixture',scope:'Windows native commands against the exact owned Electron process; real chat, runtime, held keys and saved checkpoint',
 coverage:['native minimize and restore','native close-to-tray and second-instance activation','native and document visibility','held-input release','paused progress','saved checkpoint and reload','follow-up contains released saved state'],
 limits:['real model generation','tray menu clicking','full process restart or crash','other platforms','release packages','full recovery matrix'],
 async prepare(context){
  assert.equal(process.platform,'win32','Native window scenario requires Windows');
  this.context=context;context.report.credentials='synthetic-local-fixture-only; no user credentials';
  const requests=[];context.report.fixture={provider,model,requests};
  const server=createServer(async(req,res)=>{
   try{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());
    const texts=(body.messages??[]).flatMap(text),saved=texts.findLast(value=>value.startsWith('Saved mini app parameters and host publication results'));
    const app=saved?JSON.parse(saved.slice(saved.indexOf('\n')+1)).apps.find(app=>app.id==='held-input'):undefined;
    const create=body.tools?.some(t=>t.function?.name==='piora_render_mini_app')&&!body.messages?.some(m=>m.role==='tool'&&m.tool_call_id===callId);
    requests.push({create,savedState:app??null});assert.ok(requests.length<16);
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
    const emit=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({id:'window-fixture',object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model,choices:[{index:0,delta,finish_reason}]})}\n\n`);
    emit({role:'assistant',...(create?{tool_calls:[{index:0,id:callId,type:'function',function:{name:'piora_render_mini_app',arguments:JSON.stringify(heldInputPlan())}}]}:{content:app?`Observed lifecycle state: ${app.summary}`:'Window lifecycle fixture'})});
    emit({},create?'tool_calls':'stop');res.end('data: [DONE]\n\n');
   }catch(error){if(!res.headersSent)res.writeHead(500);res.end(JSON.stringify({error:{message:error.message}}));}
  });
  await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
  context.registerCleanup(()=>new Promise((done,reject)=>{server.closeAllConnections();server.close(error=>error?reject(error):done());}));
  await writeFile(join(context.paths.agent,'models.json'),JSON.stringify({providers:{[provider]:{api:'openai-completions',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'local-test-only',models:[{id:model,name:'Window Fixture',reasoning:false,input:['text'],contextWindow:128000,maxTokens:8192,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
  const path=join(context.paths.agent,'settings.json'),settings=JSON.parse(await readFile(path,'utf8'));
  await writeFile(path,JSON.stringify({...settings,defaultProvider:provider,defaultModel:model,enabledModels:[`${provider}/${model}`]}));
 },
 async run({page,step,waitUntil,reload,screenshot,directory,signal}){
  const {APP_DISPLAY_NAME}=createRequire(import.meta.url)(resolve('desktop/dist/generated/brand.js'));
  const {report,paths}=this.context;let handle;const windows=[],checkpoints=[],activations=[],interruptions=[];
  // Playwright normally forces focused/visible documents. This scenario must
  // observe the actual native window, not that automation-only override.
  const nativePage=await page.context().newCDPSession(page);
  const target=await nativePage.send('Target.getTargetInfo');
  report.nativeTarget={browserContextId:target.targetInfo.browserContextId??null,
   contextCount:page.context().browser().contexts().length,
   firstReportedContext:page.context()===page.context().browser().contexts()[0]};
  report.focusEmulation='noDefaults CDP connection; no additional emulation override';
  this.context.registerCleanup(()=>nativePage.detach().catch(()=>{}));
  const record=()=>writeFile(join(directory,'window-lifecycle.json'),JSON.stringify({scope:this.scope,limits:this.limits,windows,checkpoints,activations,interruptions},null,2)+'\n');
  const native=async(action='inspect')=>{
   const result=await execute('pwsh.exe',['-NoProfile','-NonInteractive','-File',resolve('scripts/desktop-e2e/native-window.ps1'),'-LauncherPid',String(report.launchPid),'-DebugPort',String(paths.debugPort),'-ExpectedTitle',`${APP_DISPLAY_NAME} Dev`,'-Action',action,...(handle?['-WindowHandle',String(handle)]:[])],{windowsHide:true,timeout:15000,signal});
   const state=JSON.parse(result.stdout);handle=state.handle;
   const documentState=await page.evaluate(()=>({hidden:document.hidden,visibility:document.visibilityState,focused:document.hasFocus()}));
   windows.push({at:new Date().toISOString(),...state,document:documentState});await record();return state;
  };
  const activate=async()=>{
   const owner=await native(),root=resolve('.'),base=isolatedEnvironment(process.env,paths);
   // Reopening the same isolated app uses Electron's production single-instance
   // handler. A Win32 ShowWindow call cannot undo BrowserWindow.hide()'s state.
   // This secondary process exits at the existing lock; it never authenticates
   // to the server and receives no live server token or user credentials.
   const env={...base,...desktopDevelopmentEnvironment(root,base),
    PI_DESKTOP_DEV_SERVER_URL:report.origin+'/',PI_DESKTOP_TOKEN:'isolated-window-activation-fixture-token'};
   const secondary=startProcess(createRequire(import.meta.url)('electron'),[join(root,'desktop')],{cwd:root,env,stdio:'ignore'});
   this.context.registerCleanup(()=>stopProcess(secondary));
   const exit=await abortable(()=>secondary.exited,AbortSignal.any([signal,AbortSignal.timeout(15000)]));
   assert.equal(exit.code,0,'Secondary instance must forward activation and exit');
   const current=await native();assert.equal(current.processId,owner.processId,'Activation must preserve the owned main process');
   assert.equal(current.handle,owner.handle,'Activation must restore the same window');
   activations.push({at:new Date().toISOString(),secondaryPid:secondary.child.pid,exit,mainProcessId:current.processId,handle:current.handle});await record();
  };
  const surface=page.locator('[data-mini-app-surface]').first(),frame=surface.frameLocator('iframe[title="Interactive answer"]');
  const state=async()=>JSON.parse(await frame.locator('[data-text="state"]').innerText());
  const ready=async()=>{await frame.getByRole('button',{name:'Other control'}).waitFor();assert.ok(!await surface.getAttribute('data-mini-app-runtime-error'));};
  const save=async()=>{
   await surface.getByRole('button',{name:/^(Save|保存)$/}).click();
   await surface.getByText(/^(Saved · ready for your next message|已保存 · 后续追问可读取当前状态)$/).waitFor();
   await waitUntil(()=>surface.getByRole('button',{name:/^(Save|保存)$/}).isEnabled(),'checkpoint saved');
   const sessionId=new URL(page.url()).searchParams.get('session');assert.ok(sessionId);
   const output=await page.evaluate(async path=>{const r=await fetch(path,{cache:'no-store'});if(!r.ok)throw new Error(`Checkpoint read ${r.status}`);return r.json();},`/api/sessions/${sessionId}/mini-app?toolCallId=${callId}`);
   assert.deepEqual(output.result.snapshot.state,await state());checkpoints.push(output);await record();return output.result.snapshot;
  };
  const hold=async()=>{
   const before=await state();
   await surface.getByRole('button',{name:/^(Play|播放)$/}).click();
   await frame.locator('[data-event="keys"]').click();await page.keyboard.down('ArrowRight');
   await waitUntil(async()=>{const current=await state();return current.held&&current.x>before.x;},'native keydown advances state');
  };
  const interrupted=async(kind)=>{
   // Record native state and release/pause before any restore or synthetic keyup.
   // A mismatch with document visibility must remain a failure, even when the
   // program correctly releases its inputs on blur.
   await waitUntil(async()=>{const current=await state();return !current.held&&!current.drag;},`${kind} releases held inputs before restore`);
   await surface.getByRole('button',{name:/^(Play|播放)$/}).waitFor();
   const before=await state();await delay(600,undefined,{signal});assert.deepEqual(await state(),before,`${kind} must pause before restore`);
   const window=await native();assert.ok(kind==='minimize'?window.minimized:!window.visible,'Native interruption must still be in effect');
   const documentState=await page.evaluate(()=>({hidden:document.hidden,focused:document.hasFocus()}));
   assert.equal(documentState.focused,false,'Interrupted window must lose focus');
   interruptions.push({kind,state:before,native:window,document:documentState,syntheticKeyupSent:false});await record();
   await waitUntil(()=>page.evaluate(()=>document.hidden),`${kind} document hidden`);
  };
  const restored=async()=>{
   await activate();
   await waitUntil(async()=>{const window=await native();return window.visible&&!window.minimized;},'native window restored');
   await waitUntil(()=>page.evaluate(()=>document.hasFocus()),'restored application focus');
   await waitUntil(async()=>!await page.evaluate(()=>document.hidden),'restored document visible');
   await ready();
   await waitUntil(async()=>{const current=await state();return !current.held&&!current.drag;},'all inputs released');
   const before=await state();await delay(600,undefined,{signal});assert.deepEqual(await state(),before,'Restored program must remain paused');
   // Clear Playwright's synthetic keyboard bookkeeping only after proving the
   // native interruption already released the app's held state.
   await page.keyboard.up('ArrowRight');
   await surface.getByRole('button',{name:/^(Play|播放)$/}).waitFor();return before;
  };
  await step('enable-and-create',async()=>{
   await page.getByRole('button',{name:/^(Settings|设置)$/}).click();const dialog=page.getByRole('dialog',{name:/^(Settings|设置)$/});
   await dialog.getByRole('button',{name:/Beta Features/}).click();const toggle=dialog.getByRole('switch',{name:'Intelligent UI'});
   await waitUntil(()=>toggle.isEnabled(),'Beta settings loaded');if(!await toggle.isChecked())await toggle.click();
   await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
   await page.locator('textarea').first().fill('Create the held-input lifecycle fixture.');await page.getByRole('button',{name:/^(Send|发送)$/}).click();await ready();
   assert.deepEqual(await state(),{x:20,held:false,drag:false});await native();
  });
  await step('native-minimize-releases-and-pauses',async()=>{
   await hold();await native('minimize');await waitUntil(async()=>(await native()).minimized,'native minimized');
   await interrupted('minimize');
   await restored();await save();await screenshot('minimized-restored.png');
  });
  await step('native-close-hides-and-releases',async()=>{
   await hold();await native('close');await waitUntil(async()=>!(await native()).visible,'close hides window to tray');
   await interrupted('close');
   await restored();await save();await screenshot('closed-restored.png');
  });
  await step('saved-reload-and-followup',async()=>{
   const before=await save();await reload();await ready();assert.deepEqual(await state(),before.state);await surface.getByRole('button',{name:/^(Play|播放)$/}).waitFor();
   const after=await save();assert.deepEqual(after,before);
   await page.locator('textarea').first().fill('Explain my saved current state without rebuilding the interface.');await page.getByRole('button',{name:/^(Send|发送)$/}).click();
   await page.getByText(`Observed lifecycle state: ${JSON.stringify(before.state)}`,{exact:true}).waitFor();
   assert.ok(report.fixture.requests.some(r=>r.savedState?.summary===JSON.stringify(before.state)));await screenshot('window-reloaded-followup.png');
  });
 },
};
