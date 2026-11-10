/** Opt-in real-model follow-up replay. Only synthetic development records;
 * original sessions remain untouched, no browser/desktop coverage. Expected
 * numbers are review oracles and are never sent to the model. */
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,readFile,writeFile,cp,readdir } from 'node:fs/promises';
import { join,resolve,dirname } from 'node:path';
import {createHash} from 'node:crypto';
import {createJiti} from 'jiti';
import {ModelRuntime,getAgentDir,SettingsManager,createAgentSessionServices,createAgentSessionFromServices} from '@earendil-works/pi-coding-agent';
const root=resolve(import.meta.dirname,'..');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const args=process.argv.slice(2),bindingIndex=args.indexOf('--bindings');
assert.ok(bindingIndex>=0&&args[bindingIndex+1],'Explicit --bindings <json> is required');
const bindingsPath=resolve(args[bindingIndex+1]);
const bindings=JSON.parse(await readFile(bindingsPath,'utf8'));
assert.equal(bindings.version,1);assert.equal(bindings.thinking,'enabled');
assert.ok(Array.isArray(bindings.cases)&&bindings.cases.length>0);
const seen=new Set();
for(const spec of bindings.cases){
 assert.equal(typeof spec.id,'string');assert.ok(spec.id&&!seen.has(spec.id));seen.add(spec.id);
 assert.equal(typeof spec.followup,'string');assert.ok(spec.followup.trim()&&spec.followup.length<=4000);
 assert.ok(Number.isFinite(spec.expectedNumber));
 const bytes=await readFile(resolve(spec.source));assert.equal(hash(bytes),spec.sha256,'Exact original result required');
 const original=JSON.parse(bytes);assert.equal(original.status,'completed');
 assert.deepEqual(original.observedForms,['non-ui'],'This runner resumes text/clarification tasks');
}
const userAgent=getAgentDir();
const runtime=await ModelRuntime.create({authPath:join(userAgent,'auth.json'),modelsPath:join(userAgent,'models.json'),allowModelNetwork:false});
const model=runtime.getModel('deepseek','deepseek-flash');
assert.ok(model&&/V4\.1/.test(model.name)&&runtime.hasConfiguredAuth('deepseek'),'V4.1 Flash only, no fallback');
const directory=await mkdtemp(join(root,'.verification','phase3-text-replay-'));
const agentDir=join(directory,'agent');await mkdir(agentDir);
const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;
const jiti=createJiti(import.meta.url,{alias:{'@':root}});
const {AgentSessionWrapper}=await jiti.import('../lib/rpc-manager.ts');
const {openOwnedSessionManager}=await jiti.import('../lib/session-owned-manager.ts');
const {writeBetaFeatures}=await jiti.import('../lib/beta-features.ts');
const {resolveExtensionLoadPlan,applyExtensionLoadPlan}=await jiti.import('../lib/extension-config.ts');
writeBetaFeatures({intelligentUi:true},agentDir);
const report={version:1,bindings:bindingsPath,scope:'Copied original non-UI SDK sessions; production wrapper/extensions and pinned real model; no desktop interaction',model:{provider:model.provider,id:model.id,name:model.name,thinking:'enabled',fallback:false},startedAt:new Date().toISOString(),status:'running',rows:[]};
const save=()=>writeFile(join(directory,'result.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({directory,status:'running'}));await save();
const abort=new AbortController();for(const s of ['SIGINT','SIGTERM'])process.once(s,()=>abort.abort(new Error(s)));
let current;
const originalStream=runtime.streamSimple.bind(runtime);
runtime.streamSimple=(selected,context,options)=>{
 assert.equal(selected.provider,model.provider);assert.equal(selected.id,model.id);
 assert.ok(current.requests.length<4,'Bounded model calls');
 const request={id:current.requests.length+1,startedAt:new Date().toISOString()};current.requests.push(request);
 return originalStream(selected,context,{...options,maxTokens:4096,reasoning:'medium',maxRetries:0,timeoutMs:120000,
  signal:options?.signal?AbortSignal.any([options.signal,abort.signal]):abort.signal,
  fetch:async(...args)=>{
   assert.equal(typeof args[1]?.body,'string');const body=JSON.parse(args[1].body);
   assert.equal(body.model,'deepseek-flash');assert.equal(body.thinking?.type,'enabled');
   request.model=body.model;request.thinking=body.thinking;request.digest=hash(JSON.stringify(body));
   const response=await fetch(...args);request.httpStatus=response.status;request.providerModelIds=[];await save();
   if(!response.body)return response;
   const decoder=new TextDecoder();let pending='';
   const inspect=new TransformStream({transform(chunk,controller){
    pending+=decoder.decode(chunk,{stream:true});const lines=pending.split('\n');pending=lines.pop();
    assert.ok(pending.length<=1024*1024,'Bounded provider line');
    for(const line of lines){if(!line.startsWith('data: '))continue;let value;try{value=JSON.parse(line.slice(6));}catch{continue;}
     if(typeof value.model==='string'){assert.ok(!/pro/i.test(value.model),'Pro response is forbidden');if(!request.providerModelIds.includes(value.model))request.providerModelIds.push(value.model);}
    }controller.enqueue(chunk);
   }});
   return new Response(response.body.pipeThrough(inspect),{status:response.status,statusText:response.statusText,headers:response.headers});
  }});
};
try {
 for(const spec of bindings.cases){
  const {id,followup:prompt,expectedNumber}=spec;
  const source=resolve(spec.source);const bytes=await readFile(source);assert.equal(hash(bytes),spec.sha256);const original=JSON.parse(bytes);
  current={id,source:source.slice(root.length+1).replaceAll('\\','/'),sourceSha256:hash(bytes),prompt,expectedNumber,originalAnswer:original.finalText,requests:[],events:[],status:'running'};
  report.rows.push(current);await save();
  let wrapper,owned;
  try {
   await cp(join(dirname(source),'agent','sessions'),join(agentDir,'sessions'),{recursive:true,force:false,errorOnExist:true});
   const paths=await readdir(join(agentDir,'sessions'),{recursive:true});
   const matching=paths.filter(p=>p.endsWith(`_${original.sessionId}.jsonl`));assert.equal(matching.length,1);
   const sessionFile=join(agentDir,'sessions',matching[0]);
   const header=JSON.parse((await readFile(sessionFile,'utf8')).split('\n')[0]);const cwd=header.cwd;
   const settingsManager=SettingsManager.create(cwd,agentDir,{projectTrusted:true});
   const loadPlan=await resolveExtensionLoadPlan({cwd,agentDir,settingsManager,profile:'normal',preferences:{version:1,disabled:[]}});
   loadPlan.enabledPaths=loadPlan.candidates.filter(c=>['piora:intelligent-ui','piora:mini-app'].includes(c.id)&&c.enabled).map(c=>c.path);assert.equal(loadPlan.enabledPaths.length,2);
   const services=await createAgentSessionServices({cwd,agentDir,modelRuntime:runtime,settingsManager,resourceLoaderOptions:{additionalExtensionPaths:loadPlan.enabledPaths,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,extensionsOverride:r=>applyExtensionLoadPlan(r,loadPlan)}});
   owned=openOwnedSessionManager(sessionFile,dirname(sessionFile),agentDir);
   const {session}=await createAgentSessionFromServices({services,sessionManager:owned.manager,model,thinkingLevel:'medium',tools:['piora_render_ui_plan','piora_render_mini_app','piora_inspect_mini_app']});
   session.setAutoRetryEnabled(false);session.setAutoCompactionEnabled(false);
   const before=session.messages.length;
   wrapper=new AgentSessionWrapper(session,'normal',{ownedSessionManager:owned});wrapper.initializeSessionCapabilities();wrapper.start();wrapper.beginExtensionBinding();await wrapper.waitUntilReady();
   wrapper.onEvent(event=>{if(['tool_execution_start','tool_execution_end','prompt_error','prompt_done'].includes(event.type))current.events.push(event);});
   const deadline=Date.now()+150000;await wrapper.send({type:'prompt',message:prompt});
   while(wrapper.isRunning()||wrapper.getActivePromptRunId()){
    if(abort.signal.aborted||Date.now()>deadline){await wrapper.send({type:'abort'});throw new Error('Text follow-up cancelled or timed out');}
    await new Promise(done=>setTimeout(done,100));
   }
   const messages=session.messages.slice(before);
   const assistant=messages.findLast(m=>m.role==='assistant');
   current.answer=typeof assistant?.content==='string'?assistant.content:(assistant?.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
   current.stopReason=assistant?.stopReason;
   current.tools=messages.filter(m=>m.role==='toolResult').map(m=>({name:m.toolName,isError:m.isError}));
   assert.equal(current.tools.length,0,'Explicit plain calculation needs no UI or inspection');
   assert.equal(current.stopReason,'stop');assert.ok(!current.events.some(x=>x.type==='prompt_error'));
   assert.ok(current.requests.length>0);current.status='completed';current.semanticReview='pending developer reading and independent human acceptance';
  }catch(error){current.status='failed';current.error=error.message;}
  finally{if(wrapper)await wrapper.shutdownForFileMutation();else owned?.release();}
  assert.equal(hash(await readFile(source)),current.sourceSha256);await save();console.log(JSON.stringify({id,status:current.status,answer:current.answer,error:current.error}));
 }
 report.status=report.rows.every(r=>r.status==='completed')?'completed':'failed';
}finally{
 if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;
 report.endedAt=new Date().toISOString();await save();
}
console.log(JSON.stringify({directory,status:report.status}));if(report.status!=='completed')process.exitCode=1;
