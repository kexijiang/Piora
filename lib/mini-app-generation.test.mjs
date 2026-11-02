import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {createJiti} from 'jiti';
import {counterPlan} from './mini-app-fixtures.mjs';
import {prepareMiniAppRuntime} from '../scripts/prepare-mini-app-runtime.mjs';
const jiti=createJiti(import.meta.url);
const {bindMiniAppGenerationRuntime,getMiniAppGenerationRuntime}=await jiti.import('./mini-app/generation-runtime.ts');
const {readMiniAppPublication}=await jiti.import('./mini-app/journal.ts');
const {saveMiniAppOutput}=await jiti.import('./mini-app/state-service.ts');
const {createOwnedSessionManager}=await jiti.import('./session-owned-manager.ts');
const {persistLazySessionManager}=await jiti.import('./session-persistence.ts');
const {miniAppRepeatExample}=await jiti.import('./mini-app/repeat-example.ts');
const {miniAppSceneExample}=await jiti.import('./mini-app/scene-example.ts');
const {miniAppEnvironments}=await jiti.import('./mini-app/environment-store.ts');
const {miniAppRendererDigest}=await jiti.import('./mini-app/capability-host.ts');
const {MINI_APP_RENDERER_PROTOCOL}=await jiti.import('./mini-app/environment-protocol.ts');
const {miniAppEnvironmentContext}=await jiti.import('./mini-app/decision-policy.ts');
const {originalMiniAppPlanDiagnostic}=await jiti.import('./mini-app/plan-admission.ts');
await prepareMiniAppRuntime();
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
function fixture(t,environment=false){
  const root=mkdtempSync(join(tmpdir(),'piora-mini-generation-')),owned=createOwnedSessionManager(root,join(root,'sessions'),root),manager=owned.manager;
  manager.appendMessage({role:'user',content:'Show a process',timestamp:Date.now()});persistLazySessionManager(manager);
  let active=true;
  const identity={sessionId:manager.getSessionId(),runId:'run',...(environment?{source:'ui',submissionId:'submission'}:{})};
  const report={protocol:MINI_APP_RENDERER_PROTOCOL,webgl:true,instance:'window-'+manager.getSessionId(),epoch:1,sequence:1,rendererDigest:miniAppRendererDigest()};
  if(environment)miniAppEnvironments().prepare(identity.sessionId,identity.submissionId,report,report.rendererDigest);
  const runtime=bindMiniAppGenerationRuntime({manager,identity,root,isActive:()=>active,assertOwned:owned.assertOwned});
  t.after(async()=>{await runtime.finish('destroy');owned.release();assert.equal(dirname(root),tmpdir());rmSync(root,{recursive:true,force:true});});
  return {manager,root,runtime,identity,report,deactivate:()=>{active=false;},read:()=>readMiniAppPublication(manager.getSessionId(),manager.getSessionFile(),'mini',manager.getLeafId(),root)};
}
const call=(manager,plan)=>manager.appendMessage({role:'assistant',api:'openai-completions',provider:'fixture',model:'fixture',stopReason:'toolUse',usage,timestamp:Date.now(),content:[{type:'toolCall',id:'mini',name:'piora_render_mini_app',arguments:plan}]});

test('origin-bound graphics availability reaches raw admission, runtime guidance, publication and saved follow-up context',async t=>{
  const f=fixture(t,true),plan=miniAppSceneExample();await f.runtime.captureContext();
  assert.equal(originalMiniAppPlanDiagnostic(plan,f.identity),undefined);
  assert.match(miniAppEnvironmentContext(f.runtime.capabilities()),/Executable spatial-interaction/);
  const assistant=call(f.manager,plan),result=await f.runtime.executePlan('mini',plan);assert.equal(result.isError,undefined);
  const leaf=f.manager.appendMessage({role:'toolResult',toolCallId:'mini',toolName:'piora_render_mini_app',isError:false,...result,timestamp:Date.now()});
  assert.deepEqual(await f.runtime.onTurnEnd({messageEntryId:assistant,toolResultEntryIds:[leaf],outcome:'completed'}),[{toolCallId:'mini',status:'committed'}]);
  const {record}=await f.read(),checkpoint=structuredClone(record.initial.snapshot);
  checkpoint.inputs.pitch=90;checkpoint.state.selected='aircraft';checkpoint.view={version:1,cameras:{airspace:{reset:0,camera:{position:[6,5,4],target:[0,0,0],fov:50}}}};
  await saveMiniAppOutput({sessionId:f.manager.getSessionId(),root:f.root,readManager:()=>f.manager,enabled:()=>true,request:{requestId:'spatial-followup',toolCallId:'mini',publicationId:record.operationId,planDigest:record.planDigest,runtimeVersion:record.runtimeVersion,leafId:leaf,expectedRevision:0,checkpoint}});
  const raw=await f.runtime.captureContext(),context=JSON.parse(raw.slice(raw.indexOf('\n')+1)),app=context.apps[0];
  assert.equal(app.stateRevision,1);assert.equal(app.inputs.find(x=>x.id==='pitch').value,90);
  assert.deepEqual(app.scenes[0].selected,{id:'aircraft',label:'飞机'});assert.deepEqual(app.scenes[0].camera.position,[6,5,4]);assert.equal(app.scenes[0].cameraSource,'saved-user-view');
});

test('losing the originating window after trial prevents publication and another window cannot replace it',async t=>{
  const f=fixture(t,true),plan=miniAppSceneExample();await f.runtime.captureContext();const assistant=call(f.manager,plan),result=await f.runtime.executePlan('mini',plan);assert.equal(result.isError,undefined);
  const leaf=f.manager.appendMessage({role:'toolResult',toolCallId:'mini',toolName:'piora_render_mini_app',isError:false,...result,timestamp:Date.now()});
  miniAppEnvironments().revoke(f.report.instance,2,2);
  miniAppEnvironments().prepare(f.identity.sessionId,f.identity.submissionId,{...f.report,instance:'replacement-window-12345678'},f.report.rendererDigest);
  assert.equal(originalMiniAppPlanDiagnostic(plan,f.identity).code,'CAPABILITY_UNAVAILABLE');
  assert.ok(!miniAppEnvironmentContext(f.runtime.capabilities()).includes('Executable spatial-interaction'));
  const outcomes=await f.runtime.onTurnEnd({messageEntryId:assistant,toolResultEntryIds:[leaf],outcome:'completed'});
  assert.equal(outcomes[0].status,'rejected');assert.equal(outcomes[0].code,'CAPABILITY_UNAVAILABLE');assert.equal((await f.read()).active,false);
});

test('runs without an originating window retain ordinary answers and reject unsupported scene generation',async t=>{
  const f=fixture(t),plan=miniAppSceneExample();await f.runtime.captureContext();call(f.manager,plan);
  const result=await f.runtime.executePlan('mini',plan);assert.equal(result.isError,true);assert.equal(result.details.answerOutputDiagnostic.code,'CAPABILITY_UNAVAILABLE');assert.equal(await f.read(),undefined);
});
test('run coordinator trials a plan and publishes only on the awaited disk-backed turn boundary',async t=>{
  const f=fixture(t);assert.equal(await f.runtime.captureContext(),'');const plan=counterPlan(),assistant=call(f.manager,plan);
  const result=await f.runtime.executePlan('mini',plan);assert.equal(result.isError,undefined);assert.equal(result.details.answerOutput.kind,'mini-app');assert.equal((await f.read()).active,false);
  const id=f.manager.appendMessage({role:'toolResult',toolCallId:'mini',toolName:'piora_render_mini_app',isError:false,...result,timestamp:Date.now()});
  const receipt={messageEntryId:assistant,toolResultEntryIds:[id],outcome:'completed'};
  assert.deepEqual(await f.runtime.onTurnEnd(receipt),[{toolCallId:'mini',status:'committed'}]);assert.equal((await f.read()).active,true);
  const context=await f.runtime.captureContext();assert.match(context,/Count: 2/);assert.match(context,/committed/);assert.doesNotMatch(context,/requestId|operationId/);
  const {record}=await f.read();
  await saveMiniAppOutput({sessionId:f.manager.getSessionId(),root:f.root,readManager:()=>f.manager,enabled:()=>true,request:{requestId:'save-before-followup',toolCallId:'mini',publicationId:record.operationId,planDigest:record.planDigest,runtimeVersion:record.runtimeVersion,leafId:f.manager.getLeafId(),expectedRevision:0,checkpoint:{...record.initial.snapshot,inputs:{start:7},state:{count:37},tick:35}}});
  const followup=await f.runtime.captureContext();assert.match(followup,/Count: 37/);assert.match(followup,/"stateRevision":1/);assert.match(followup,/"value":7/);assert.doesNotMatch(followup,/Count: 2|requestId|operationId/);
  await f.runtime.finish('idle');assert.equal(getMiniAppGenerationRuntime(f.manager),undefined);assert.equal((await f.read()).active,true);
});
test('new generation requires explicit playback instead of guessing from button labels',async t=>{
  const f=fixture(t);await f.runtime.captureContext();const plan=counterPlan();delete plan.playback;call(f.manager,plan);
  const result=await f.runtime.executePlan('mini',plan);
  assert.equal(result.isError,true);assert.equal(result.details.answerOutputDiagnostic.code,'SCHEMA');
  assert.equal(result.details.answerOutputDiagnostic.path,'playback');assert.equal(result.details.answerOutputDiagnostic.repairable,true);
  assert.equal(await f.read(),undefined);
});

test('cancelling an in-flight trial synchronously revokes lookup and prevents a late candidate',async t=>{
  const f=fixture(t);await f.runtime.captureContext();const plan=counterPlan();plan.program=plan.program.replace('return {count:inputs.start};','while(true){}');call(f.manager,plan);
  const pending=f.runtime.executePlan('mini',plan);
  const deadline=Date.now()+3000;
  while(!globalThis.__pioraMiniAppTrialCapacity?.active&&Date.now()<deadline)await new Promise(done=>setTimeout(done,5));
  assert.equal(globalThis.__pioraMiniAppTrialCapacity?.active,1,'The trial must actually be in flight before cancellation');
  const cleanup=f.runtime.finish('abort');assert.equal(getMiniAppGenerationRuntime(f.manager),undefined);
  const result=await pending;assert.equal(result.isError,true);assert.equal(result.details.answerOutputDiagnostic.repairable,false);await cleanup;assert.equal(await f.read(),undefined);
  const late=await f.runtime.executePlan('mini',counterPlan());assert.equal(late.isError,true);
});

test('follow-up generation context contains the saved edited rows and current order, not just an aggregate count',async t=>{
  const f=fixture(t);await f.runtime.captureContext();const plan=miniAppRepeatExample(),assistant=call(f.manager,plan);
  const result=await f.runtime.executePlan('mini',plan);assert.equal(result.isError,undefined);
  const leaf=f.manager.appendMessage({role:'toolResult',toolCallId:'mini',toolName:'piora_render_mini_app',isError:false,...result,timestamp:Date.now()});
  await f.runtime.onTurnEnd({messageEntryId:assistant,toolResultEntryIds:[leaf],outcome:'completed'});
  const {record}=await f.read(),checkpoint=structuredClone(record.initial.snapshot);
  checkpoint.state.items=[{...checkpoint.state.items[2],title:'新版充电清单',done:true},checkpoint.state.items[0]];
  await saveMiniAppOutput({sessionId:f.manager.getSessionId(),root:f.root,readManager:()=>f.manager,enabled:()=>true,
    request:{requestId:'rows-followup',toolCallId:'mini',publicationId:record.operationId,planDigest:record.planDigest,
      runtimeVersion:record.runtimeVersion,leafId:leaf,expectedRevision:0,checkpoint}});
  const raw=await f.runtime.captureContext(),context=JSON.parse(raw.slice(raw.indexOf('\n')+1));
  const app=context.apps.find(app=>app.id==='packingList');assert.equal(app.stateRevision,1);
  assert.equal(app.lists[0].omittedRows,0);assert.deepEqual(app.lists[0].rows.map(row=>row.key),['task3','task1']);
  assert.equal(app.lists[0].rows[0].bindings.title,'新版充电清单');assert.equal(app.lists[0].rows[0].bindings.done,true);
  assert.doesNotMatch(raw,/带充电器|收拾衣服/);assert.match(raw,/untrusted task data/);
});
