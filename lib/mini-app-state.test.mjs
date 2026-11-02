import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {createJiti} from 'jiti';
import {counterPlan} from './mini-app-fixtures.mjs';
import {prepareMiniAppRuntime} from '../scripts/prepare-mini-app-runtime.mjs';
const jiti=createJiti(import.meta.url);
const {MiniAppJournal,miniAppEnvelope,miniAppJournalPath}=await jiti.import('./mini-app/journal.ts');
const {readMiniAppOutput,saveMiniAppOutput,readMiniAppReceipt}=await jiti.import('./mini-app/state-service.ts');
const {miniAppStatePath}=await jiti.import('./mini-app/state-store.ts');
const {createOwnedSessionManager}=await jiti.import('./session-owned-manager.ts');
const {persistLazySessionManager}=await jiti.import('./session-persistence.ts');
const {readBetaFeatures,writeBetaFeatures}=await jiti.import('./beta-features.ts');
const {miniAppRepeatExample}=await jiti.import('./mini-app/repeat-example.ts');
const {miniAppSceneExample}=await jiti.import('./mini-app/scene-example.ts');
const {trialMiniApp}=await jiti.import('./mini-app/server-trial.ts');
await prepareMiniAppRuntime();
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const initial=()=>({snapshot:{inputs:{start:2},state:{count:2},rng:0x50494f52,tick:0},frame:{summary:'Count: 2',bindings:{count:2},playback:{finished:false}}});
function call(manager,id='mini',plan=counterPlan()){
  return manager.appendMessage({role:'assistant',api:'openai-completions',provider:'fixture',model:'fixture',stopReason:'toolUse',usage,timestamp:Date.now(),content:[{type:'toolCall',id,name:'piora_render_mini_app',arguments:plan}]});
}
function toolResult(manager,record){return manager.appendMessage({role:'toolResult',toolCallId:record.toolCallId,toolName:'piora_render_mini_app',isError:false,content:[{type:'text',text:'candidate'}],details:miniAppEnvelope(record),timestamp:Date.now()});}
async function fixture(t,plan=counterPlan(),starting=initial()){
  const root=mkdtempSync(join(tmpdir(),'piora-mini-state-')),owned=createOwnedSessionManager(root,join(root,'sessions'),root),manager=owned.manager;
  manager.appendMessage({role:'user',content:'Show how it changes',timestamp:Date.now()});persistLazySessionManager(manager);
  const host=new MiniAppJournal({manager,root,runId:'run',assertActive:owned.assertOwned});
  t.after(()=>{owned.release();assert.equal(dirname(root),tmpdir());rmSync(root,{recursive:true,force:true});});
  await host.start();const {context}=await host.capture(),assistant=call(manager,'mini',plan);
  const record=await host.create(context.requestId,'mini',plan,starting),leaf=toolResult(manager,record);
  await host.publish(record.operationId,{messageEntryId:assistant,toolResultEntryIds:[leaf]});
  const options={sessionId:manager.getSessionId(),root,readManager:()=>manager};
  const read=(leafId)=>readMiniAppOutput({...options,toolCallId:'mini',...(leafId?{leafId}:{})});
  const save=(request,extra={})=>saveMiniAppOutput({...options,request,enabled:()=>true,...extra});
  const request=async(count,id='save-1')=>{const current=await read();return {requestId:id,toolCallId:'mini',publicationId:record.operationId,planDigest:record.planDigest,runtimeVersion:record.runtimeVersion,
    leafId:current.leafId,expectedRevision:current.stateRevision,checkpoint:{...current.result.snapshot,inputs:{start:7},state:{count},tick:count}};};
  return {root,manager,host,record,options,read,save,request,leaf,path:miniAppStatePath(manager.getSessionId(),root)};
}
async function waitForTrial(){
  const until=Date.now()+3000;
  while(!globalThis.__pioraMiniAppTrialCapacity?.active&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(globalThis.__pioraMiniAppTrialCapacity?.active,1,'Operation reached the actual worker trial');
}

test('a durable save reprojects in QuickJS, leaves the publication immutable, and replays exact receipts without rewriting',async t=>{
  const f=await fixture(t),request=await f.request(45),file=f.manager.getSessionFile(),journalPath=miniAppJournalPath(f.options.sessionId,f.root);
  const before=[readFileSync(file,'utf8'),readFileSync(journalPath,'utf8')];
  const receipt=await f.save(request),saved=await f.read();
  assert.equal(saved.stateRevision,1);assert.equal(saved.result.frame.summary,'Count: 45');assert.equal(saved.result.snapshot.inputs.start,7);
  assert.equal(saved.result.snapshot.tick,45);assert.equal(receipt.checkpointDigest,saved.checkpointDigest);
  assert.deepEqual([readFileSync(file,'utf8'),readFileSync(journalPath,'utf8')],before);
  const disk=readFileSync(f.path,'utf8');assert.deepEqual(await f.save(request),receipt);assert.equal(readFileSync(f.path,'utf8'),disk);
  assert.deepEqual(await readMiniAppReceipt({...f.options,toolCallId:'mini',requestId:request.requestId}),receipt);
  await assert.rejects(f.save({...request,checkpoint:{...request.checkpoint,state:{count:46}}}),error=>error.code==='CONFLICT');
  await assert.rejects(f.save({...request,requestId:'forged-frame',frame:{summary:'Anything'}}),error=>error.code==='SCHEMA');
  assert.equal(readFileSync(f.path,'utf8'),disk);
});

test('two writers with the same expected revision cannot overwrite one another',async t=>{
  const f=await fixture(t),a=await f.request(5,'a'),b=await f.request(9,'b');
  const results=await Promise.allSettled([f.save(a),f.save(b)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.code,'CONFLICT');
  const state=await f.read(),winner=results[0].status==='fulfilled'?5:9;
  assert.equal(state.result.snapshot.state.count,winner);assert.equal(state.stateRevision,1);
  assert.equal(JSON.parse(readFileSync(f.path,'utf8')).receipts.length,1);
});

test('editing an ancestor freezes existing descendants while new branches inherit the new checkpoint',async t=>{
  const f=await fixture(t);await f.save(await f.request(5));
  const child=f.manager.appendMessage({role:'user',content:'Existing branch',timestamp:Date.now()});
  const grandchild=f.manager.appendMessage({role:'user',content:'Existing descendant',timestamp:Date.now()});
  f.manager.branch(f.leaf);await f.save(await f.request(9,'ancestor'));
  assert.equal((await f.read(grandchild)).result.snapshot.state.count,5);
  assert.equal((await f.read(child)).writable,false);
  const future=f.manager.appendMessage({role:'user',content:'New branch',timestamp:Date.now()});
  assert.equal((await f.read()).result.snapshot.state.count,9);
  f.manager.branch(grandchild);await f.save(await f.request(12,'descendant'));
  assert.equal((await f.read()).result.snapshot.state.count,12);
  assert.equal((await f.read(future)).result.snapshot.state.count,9);
  assert.equal((await f.read(f.leaf)).result.snapshot.state.count,9);
  const old=await f.request(20,'stale-branch');f.manager.branch(future);
  await assert.rejects(f.save(old),error=>error.code==='CONFLICT');
});

test('model context uses committed interactions and rejects a candidate when its source changes later on the branch',async t=>{
  const f=await fixture(t);await f.save(await f.request(8));
  const captured=await f.host.capture();assert.equal(captured.apps[0].saved.result.frame.summary,'Count: 8');
  assert.equal(captured.context.sources.counter.revision,1);assert.equal(captured.apps[0].record.initial.frame.summary,'Count: 2');
  const next=counterPlan();next.title='Revised counter';call(f.manager,'mini-next',next);
  await f.save(await f.request(11,'changed-after-context'));
  await assert.rejects(f.host.create(captured.context.requestId,'mini-next',next,initial()),error=>error.code==='RECEIPT');
});

test('state changes between candidate creation and turn receipt prevent publishing a stale revision',async t=>{
  const f=await fixture(t),{context}=await f.host.capture(),next=counterPlan();next.title='Revision';
  const assistant=call(f.manager,'mini-next',next),record=await f.host.create(context.requestId,'mini-next',next,initial()),result=toolResult(f.manager,record);
  await f.save(await f.request(19));
  await assert.rejects(f.host.publish(record.operationId,{messageEntryId:assistant,toolResultEntryIds:[result]}),error=>error.code==='RECEIPT');
  assert.equal((await f.read()).result.frame.summary,'Count: 19');assert.equal((await f.read()).publication.id,f.record.operationId);
});

test('navigation or disabling the feature during projection cannot commit a late checkpoint',async t=>{
  const f=await fixture(t),request=await f.request(7);
  const pending=f.save(request);await waitForTrial();
  f.manager.appendMessage({role:'user',content:'Moved during projection',timestamp:Date.now()});
  await assert.rejects(pending,error=>error.code==='CONFLICT');assert.equal(existsSync(f.path),false);
  let enabled=true;const second=f.save(await f.request(8,'disabled'),{enabled:()=>enabled});await waitForTrial();enabled=false;
  await assert.rejects(second,error=>error.code==='DISABLED');assert.equal(existsSync(f.path),false);
  const abort=new AbortController(),third=f.save(await f.request(9,'cancelled'),{signal:abort.signal});await waitForTrial();abort.abort();
  await assert.rejects(third,error=>error.code==='STOPPED');assert.equal(existsSync(f.path),false);
});

test('terminal checkpoints restore without taking another step; corrupt state fails closed',async t=>{
  const f=await fixture(t);await f.save(await f.request(10000));
  assert.equal((await f.read()).result.frame.summary,'Count: 10000');
  const store=JSON.parse(readFileSync(f.path,'utf8'));store.entries[0].result.frame.summary='Forged result';writeFileSync(f.path,JSON.stringify(store));
  await assert.rejects(f.read(),error=>error.code==='CORRUPT');
});

test('rapid Beta off/on aborts an in-flight projection; only an explicit new save can commit',async t=>{
  const f=await fixture(t);writeBetaFeatures({intelligentUi:true},f.root);
  const request=await f.request(17,'feature-toggle'),enabled=()=>readBetaFeatures(f.root).intelligentUi;
  const rejected=assert.rejects(f.save(request,{enabled}),error=>['STOPPED','DISABLED'].includes(error.code));
  await waitForTrial();
  writeBetaFeatures({intelligentUi:false},f.root);writeBetaFeatures({intelligentUi:true},f.root);
  await rejected;
  assert.equal(existsSync(f.path),false,'the revoked save cannot persist after re-enabling');
  assert.equal(await readMiniAppReceipt({...f.options,toolCallId:'mini',requestId:request.requestId}),undefined);
  assert.equal((await f.read()).result.snapshot.state.count,2);
  const receipt=await f.save(request,{enabled});
  assert.equal(receipt.stateRevision,1);
  assert.equal((await f.read()).result.snapshot.state.count,17);
});

test('an unbranched automatic title change may advance the anchor without changing request idempotency',async t=>{
  const f=await fixture(t),request=await f.request(8);
  const title=f.manager.appendSessionInfo('Automatic title');
  const receipt=await f.save(request);assert.equal(receipt.leafId,title);assert.deepEqual(await f.save(request),receipt);
  assert.equal((await f.read()).result.frame.summary,'Count: 8');
});

test('editable row checkpoints persist through the production state service and replay without changing row identity',async t=>{
  const plan=miniAppRepeatExample(),f=await fixture(t,plan,await trialMiniApp(plan));
  const current=await f.read(),checkpoint=structuredClone(current.result.snapshot);
  checkpoint.state.items=[{...checkpoint.state.items[2],title:'电脑和充电器',done:true},checkpoint.state.items[0]];
  const request={requestId:'rows-save',toolCallId:'mini',publicationId:f.record.operationId,planDigest:f.record.planDigest,
    runtimeVersion:f.record.runtimeVersion,leafId:current.leafId,expectedRevision:current.stateRevision,checkpoint};
  const receipt=await f.save(request),disk=readFileSync(f.path,'utf8');
  assert.equal(receipt.stateRevision,1);assert.deepEqual(await f.save(request),receipt);assert.equal(readFileSync(f.path,'utf8'),disk);
  const restored=await f.read();assert.equal(restored.publication.runtimeVersion,'mini-app-1.3');
  assert.deepEqual(restored.result.snapshot,checkpoint);
  assert.deepEqual(restored.result.frame.repeats.tasks.map(row=>row.key),['task3','task1']);
  assert.equal(restored.result.frame.repeats.tasks[0].bindings.title,'电脑和充电器');
  assert.equal(restored.result.frame.repeats.tasks[0].bindings.done,true);
  assert.match(restored.result.frame.summary,/1 \/ 2/);
});

test('scene camera and selection survive production disk receipts without overwriting task inputs or generated camera defaults',async t=>{
  const plan=miniAppSceneExample(),f=await fixture(t,plan,await trialMiniApp(plan)),current=await f.read();
  const checkpoint=structuredClone(current.result.snapshot);
  checkpoint.inputs.pitch=90;checkpoint.state.selected='aircraft';
  checkpoint.view={version:1,cameras:{airspace:{reset:0,camera:{position:[7,6,5],target:[0,0,0],fov:50}}}};
  const request={requestId:'scene-save',toolCallId:'mini',publicationId:f.record.operationId,planDigest:f.record.planDigest,
    runtimeVersion:f.record.runtimeVersion,leafId:current.leafId,expectedRevision:current.stateRevision,checkpoint};
  const receipt=await f.save(request),disk=readFileSync(f.path,'utf8');
  assert.equal(receipt.stateRevision,1);assert.deepEqual(await f.save(request),receipt);assert.equal(readFileSync(f.path,'utf8'),disk);
  const restored=await f.read();assert.equal(restored.publication.runtimeVersion,'mini-app-1.4');
  assert.deepEqual(restored.result.snapshot,checkpoint);assert.equal(restored.result.frame.scenes.airspace.selected,'aircraft');
  assert.deepEqual(restored.result.frame.scenes.airspace.camera.position,[5,4,6]);
  assert.deepEqual(restored.result.frame.scenes.airspace.meshes[0].rotation,[Math.PI/2,0,0]);
  const other=structuredClone(request);other.requestId='bad-view';other.expectedRevision=1;other.checkpoint.view.cameras.other=other.checkpoint.view.cameras.airspace;
  await assert.rejects(f.save(other));assert.equal(readFileSync(f.path,'utf8'),disk);
});
