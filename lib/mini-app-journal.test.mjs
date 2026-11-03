import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {createJiti} from 'jiti';
import {counterPlan} from './mini-app-fixtures.mjs';
const jiti=createJiti(import.meta.url);
const {MiniAppJournal,miniAppEnvelope,miniAppJournalPath,readMiniAppPublication}=await jiti.import('./mini-app/journal.ts');
const {createOwnedSessionManager}=await jiti.import('./session-owned-manager.ts');
const {persistLazySessionManager}=await jiti.import('./session-persistence.ts');
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const initial=()=>({snapshot:{inputs:{start:2},state:{count:2},rng:0x50494f52,tick:0},frame:{summary:'Count: 2',bindings:{count:2},playback:{finished:false}}});
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'piora-mini-journal-')),owned=createOwnedSessionManager(root,join(root,'sessions'),root),manager=owned.manager;
  manager.appendMessage({role:'user',content:'Let me step through it',timestamp:Date.now()});persistLazySessionManager(manager);
  let alive=true;
  const host=new MiniAppJournal({manager,root,runId:'run-1',assertActive(){owned.assertOwned();assert.ok(alive,'Run must be active');}});
  t.after(()=>{owned.release();assert.equal(dirname(root),tmpdir());rmSync(root,{recursive:true,force:true});});
  const read=()=>readMiniAppPublication(manager.getSessionId(),manager.getSessionFile(),'mini-1',manager.getLeafId(),root);
  const journal=()=>JSON.parse(readFileSync(miniAppJournalPath(manager.getSessionId(),root),'utf8'));
  return {root,manager,host,owned,read,journal,stop:()=>{alive=false;}};
}
function call(manager,calls=[{id:'mini-1',name:'piora_render_mini_app',arguments:counterPlan()}]){
  return manager.appendMessage({role:'assistant',api:'openai-completions',provider:'fixture',model:'fixture',stopReason:'toolUse',usage,timestamp:Date.now(),content:calls.map(c=>({type:'toolCall',...c}))});
}
function result(manager,record,extra={}){
  return manager.appendMessage({role:'toolResult',toolCallId:record.toolCallId,toolName:'piora_render_mini_app',isError:false,content:[{type:'text',text:'candidate'}],details:miniAppEnvelope(record),timestamp:Date.now(),...extra});
}
async function prepare(f){await f.host.start();const {context}=await f.host.capture();const callId=call(f.manager);const record=await f.host.create(context.requestId,'mini-1',counterPlan(),initial());return {context,callId,record};}

test('historical v1.0 publications retain their program digest, runtime version and checkpoint',async t=>{
  const f=fixture(t),plan=counterPlan(),point=initial();delete plan.playback;delete point.frame.playback;
  plan.program=plan.program.replace(',playback:{finished:false}','');
  await f.host.start();const {context}=await f.host.capture();
  const callId=call(f.manager,[{id:'mini-1',name:'piora_render_mini_app',arguments:plan}]);
  const record=await f.host.create(context.requestId,'mini-1',plan,point),resultId=result(f.manager,record);
  await f.host.publish(record.operationId,{messageEntryId:callId,toolResultEntryIds:[resultId],outcome:'completed'});
  const saved=await f.read();assert.equal(saved.active,true);assert.equal(saved.record.runtimeVersion,'mini-app-1.0');
  assert.deepEqual(saved.record.plan,plan);assert.deepEqual(saved.record.initial,point);
  assert.equal(saved.record.planDigest,record.planDigest);
  const corrupted=f.journal();corrupted.records[0].runtimeVersion='mini-app-1.1';
  writeFileSync(miniAppJournalPath(f.manager.getSessionId(),f.root),JSON.stringify(corrupted));
  await assert.rejects(f.read(),e=>e.code==='RECEIPT','New runtime identity cannot be attached to an old immutable plan');
});

test('only complete exact disk receipts publish; candidate rereads and idempotent retries do not create a second publication',async t=>{
  const f=fixture(t),{context,callId,record}=await prepare(f);
  assert.equal((await f.read()).active,false);assert.equal((await f.read()).record.status,'candidate');
  await assert.rejects(f.host.publish(record.operationId,{messageEntryId:callId,toolResultEntryIds:[]}));
  const retry=await f.host.create(context.requestId,'mini-1',counterPlan(),initial());assert.equal(retry.operationId,record.operationId);
  const changed=counterPlan();changed.title='Changed';await assert.rejects(f.host.create(context.requestId,'mini-1',changed,initial()));
  const resultId=result(f.manager,record),receipt={messageEntryId:callId,toolResultEntryIds:[resultId],outcome:'completed'};
  assert.equal((await f.read()).active,false,'Persisted result alone must not publish on read');
  const committed=await f.host.publish(record.operationId,receipt);assert.equal(committed.status,'committed');
  assert.deepEqual(await f.host.publish(record.operationId,receipt),committed);assert.equal((await f.read()).active,true);assert.equal(f.journal().records.length,1);
});

test('sibling tool results must finish; forged outcome, partial or changed receipt never publishes',async t=>{
  const f=fixture(t);await f.host.start();const {context}=await f.host.capture();
  const callId=call(f.manager,[{id:'mini-1',name:'piora_render_mini_app',arguments:counterPlan()},{id:'read-1',name:'read',arguments:{path:'sample.txt'}}]);
  const record=await f.host.create(context.requestId,'mini-1',counterPlan(),initial()),id=result(f.manager,record);
  await assert.rejects(f.host.publish(record.operationId,{messageEntryId:callId,toolResultEntryIds:[id]}));
  const other=f.manager.appendMessage({role:'toolResult',toolCallId:'read-1',toolName:'read',content:[{type:'text',text:'done'}],isError:false,timestamp:Date.now()});
  await assert.rejects(f.host.publish(record.operationId,{messageEntryId:callId,toolResultEntryIds:[id,other],outcome:'aborted'}));
  await assert.rejects(f.host.publish(record.operationId,{messageEntryId:callId,toolResultEntryIds:[id,id]}));
  await f.host.publish(record.operationId,{messageEntryId:callId,toolResultEntryIds:[id,other],outcome:'completed'});assert.equal((await f.read()).active,true);
  const file=f.manager.getSessionFile(),records=readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);records.find(r=>r.id===id).message.details.answerOutput.snapshot='forged';writeFileSync(file,records.map(JSON.stringify).join('\n')+'\n');
  await assert.rejects(f.read(),error=>error.code==='RECEIPT');
});

test('cancellation and a new run retire unfinished candidates, including durable results left by an interrupted run',async t=>{
  const f=fixture(t),{record,callId}=await prepare(f),id=result(f.manager,record);
  const replacement=new MiniAppJournal({manager:f.manager,root:f.root,runId:'run-2',assertActive:f.owned.assertOwned});await replacement.start();
  assert.equal(f.journal().records[0].status,'aborted');assert.equal((await f.read()).active,false);
  await assert.rejects(f.host.publish(record.operationId,{messageEntryId:callId,toolResultEntryIds:[id]}));
  f.stop();await assert.rejects(f.host.capture());
});

test('title metadata is allowed, conversation changes reject old context, and revisions preserve the old publication pending review',async t=>{
  const f=fixture(t);await f.host.start();let {context}=await f.host.capture();
  f.manager.appendSessionInfo('New title');const firstCall=call(f.manager),record=await f.host.create(context.requestId,'mini-1',counterPlan(),initial()),id=result(f.manager,record);
  await f.host.publish(record.operationId,{messageEntryId:firstCall,toolResultEntryIds:[id]});
  f.manager.appendMessage({role:'user',content:'Change this demonstration',timestamp:Date.now()});
  ({context}=await f.host.capture());const next=counterPlan();next.title='Revised';const secondCall=call(f.manager,[{id:'mini-2',name:'piora_render_mini_app',arguments:next}]);
  const revision=await f.host.create(context.requestId,'mini-2',next,initial()),secondId=result(f.manager,revision);
  const pending=await f.host.publish(revision.operationId,{messageEntryId:secondCall,toolResultEntryIds:[secondId]});assert.equal(pending.status,'awaiting_confirmation');assert.equal((await f.read()).active,true);
  f.manager.appendMessage({role:'user',content:'Another request',timestamp:Date.now()});({context}=await f.host.capture());
  f.manager.appendMessage({role:'user',content:'Unexpected intervening request',timestamp:Date.now()});call(f.manager,[{id:'mini-3',name:'piora_render_mini_app',arguments:next}]);
  await assert.rejects(f.host.create(context.requestId,'mini-3',next,initial()));
});
