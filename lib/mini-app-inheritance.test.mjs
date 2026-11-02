import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {createJiti} from 'jiti';
import {counterPlan} from './mini-app-fixtures.mjs';
import {prepareMiniAppRuntime} from '../scripts/prepare-mini-app-runtime.mjs';

const jiti=createJiti(import.meta.url,{alias:{'@':resolve(import.meta.dirname,'..')}});
const {MiniAppJournal,miniAppEnvelope,miniAppJournalPath,copyMiniAppJournal}=await jiti.import('./mini-app/journal.ts');
const {readMiniAppOutput,saveMiniAppOutput,readMiniAppReceipt}=await jiti.import('./mini-app/state-service.ts');
const {miniAppStatePath}=await jiti.import('./mini-app/state-store.ts');
const {createOwnedSessionManager}=await jiti.import('./session-owned-manager.ts');
const {persistLazySessionManager}=await jiti.import('./session-persistence.ts');
const {readOnlySessionManager}=await jiti.import('./session-readonly-manager.ts');
const {copyAnswerOutputState,answerOutputExportAppendix,readAnswerOutputSavedSnapshot}=await jiti.import('./answer-output-server.ts');
const {POST:duplicate}=await jiti.import('../app/api/sessions/[id]/duplicate/route.ts');
const {resolveSessionPath,invalidateSessionPathCache,invalidateSessionListCache}=await jiti.import('./session-reader.ts');
await prepareMiniAppRuntime();
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const initial=()=>({snapshot:{inputs:{start:2},state:{count:2},rng:0x50494f52,tick:0},frame:{summary:'Count: 2',bindings:{count:2},playback:{finished:false}}});

async function fixture(t,{published=true,labelBeforeCall=false,otherTool=false,purpose}={}){
  const root=mkdtempSync(join(tmpdir(),'piora-mini-inherit-')),previous=process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR=root;
  const owned=createOwnedSessionManager(root,join(root,'sessions','project'),root),manager=owned.manager;
  t.after(()=>{owned.release();if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;
    assert.equal(dirname(root),tmpdir());rmSync(root,{recursive:true,force:true});});
  const user=manager.appendMessage({role:'user',content:'Let me step through it',timestamp:Date.now()});persistLazySessionManager(manager);
  if(labelBeforeCall) manager.appendLabelChange(user,'before generation');
  const host=new MiniAppJournal({manager,root,runId:'run',assertActive:owned.assertOwned});await host.start();
  const {context}=await host.capture(),plan=counterPlan();
  if(purpose)plan.purpose=purpose;
  const calls=[{type:'toolCall',id:'mini',name:'piora_render_mini_app',arguments:plan}];
  if(otherTool)calls.push({type:'toolCall',id:'other',name:'read',arguments:{path:'fixture'}});
  const assistant=manager.appendMessage({role:'assistant',api:'openai-completions',provider:'fixture',model:'fixture',stopReason:'toolUse',usage,timestamp:Date.now(),content:calls});
  const record=await host.create(context.requestId,'mini',plan,initial());
  const result=manager.appendMessage({role:'toolResult',toolCallId:'mini',toolName:'piora_render_mini_app',isError:false,content:[{type:'text',text:'candidate'}],details:miniAppEnvelope(record),timestamp:Date.now()});
  const results=[result];
  if(otherTool)results.push(manager.appendMessage({role:'toolResult',toolCallId:'other',toolName:'read',isError:false,content:[{type:'text',text:'fixture data'}],timestamp:Date.now()}));
  if(published)await host.publish(record.operationId,{messageEntryId:assistant,toolResultEntryIds:results,outcome:'completed'});
  let counter=0;
  const read=(session=manager,leafId)=>readMiniAppOutput({sessionId:session.getSessionId(),root,readManager:()=>session,toolCallId:'mini',...(leafId?{leafId}:{})});
  const save=async(value,session=manager,requestId=`save-${++counter}`)=>{
    const current=await read(session);
    return saveMiniAppOutput({sessionId:session.getSessionId(),root,readManager:()=>session,enabled:()=>true,request:{requestId,toolCallId:'mini',
      publicationId:current.publication.id,planDigest:current.publication.planDigest,runtimeVersion:current.publication.runtimeVersion,leafId:session.getLeafId(),
      expectedRevision:current.stateRevision,checkpoint:{...current.result.snapshot,state:{count:value},tick:value-2}}});
  };
  const fork=(source=manager,leafId=source.getLeafId())=>{
    const target=SessionManager.open(source.getSessionFile(),join(root,`fork-${++counter}`));target.createBranchedSession(leafId);
    const options={source:source.getSessionId(),target:target.getSessionId(),sourceFile:source.getSessionFile(),targetFile:target.getSessionFile(),
      sourceLeafId:leafId,retainedEntryIds:target.getBranch().map(entry=>entry.id),root};
    return {manager:target,options,copy:extra=>copyMiniAppJournal({...options,...extra}),
      journal:()=>JSON.parse(readFileSync(miniAppJournalPath(target.getSessionId(),root),'utf8'))};
  };
  return {root,manager,owned,user,assistant,result,record,read,save,fork};
}

test('real SDK fork inherits confirmed checkpoints and keeps later writes and receipts independent',async t=>{
  const f=await fixture(t);await f.save(17,f.manager,'source-request');const copy=f.fork();
  assert.deepEqual(await copy.copy(),{copied:1,excluded:0});
  const state=await f.read(copy.manager);assert.equal(state.result.frame.summary,'Count: 17');assert.equal(state.writable,true);
  assert.equal(await readMiniAppReceipt({sessionId:copy.manager.getSessionId(),root:f.root,readManager:()=>copy.manager,toolCallId:'mini',requestId:'source-request'}),undefined);
  await f.save(23,copy.manager,'source-request');assert.equal((await f.read(copy.manager)).result.frame.summary,'Count: 23');
  assert.equal((await f.read()).result.frame.summary,'Count: 17');
  await assert.rejects(copy.copy(),error=>error.code==='CONFLICT');
});

test('labels are mapped through the SDK while preserving the original assistant receipt across repeated forks',async t=>{
  const f=await fixture(t,{labelBeforeCall:true});
  f.manager.appendLabelChange(f.user,'saved checkpoint');await f.save(31);
  const first=f.fork();await first.copy();
  assert.equal((await f.read(first.manager)).result.frame.summary,'Count: 31');
  assert.equal(first.journal().records[0].call.hash,f.record.call.hash);
  assert.ok(first.journal().records[0].forkCall.removedLabels.length>0);
  const second=f.fork(first.manager);await second.copy();
  assert.equal((await f.read(second.manager)).result.frame.summary,'Count: 31');
  assert.equal(second.journal().records[0].call.hash,f.record.call.hash);
  const path=miniAppJournalPath(second.manager.getSessionId(),f.root),journal=second.journal();
  journal.records[0].forkCall.removedLabels[0].entry.label='changed proof';writeFileSync(path,JSON.stringify(journal)+'\n');
  await assert.rejects(f.read(second.manager),error=>error.code==='RECEIPT');
});

test('forking a selected older branch keeps its checkpoint and excludes sibling changes',async t=>{
  const f=await fixture(t);await f.save(10);const base=f.manager.getLeafId();
  const branchA=f.manager.appendMessage({role:'user',content:'A',timestamp:Date.now()});await f.save(11);
  f.manager.branch(base);f.manager.appendMessage({role:'user',content:'B',timestamp:Date.now()});await f.save(18);
  const copy=f.fork(f.manager,branchA);await copy.copy();
  assert.equal((await f.read(copy.manager)).result.frame.summary,'Count: 11');
  await f.save(13,copy.manager);assert.equal((await f.read(f.manager,branchA)).result.frame.summary,'Count: 11');
  assert.equal((await f.read()).result.frame.summary,'Count: 18');
});

test('removed label checkpoints and compaction anchors follow the exact SDK mapping',async t=>{
  const f=await fixture(t);
  const first=f.manager.appendLabelChange(f.result,'one');await f.save(6);
  f.manager.appendLabelChange(f.result,'two');await f.save(8);
  const next=f.manager.appendMessage({role:'user',content:'after labels',timestamp:Date.now()});
  const compact=f.manager.appendCompaction('Summary',first,1000),copy=f.fork();
  await copy.copy();assert.equal(copy.manager.getEntry(compact).firstKeptEntryId,next);
  assert.equal((await f.read(copy.manager)).result.frame.summary,'Count: 8');
  const state=JSON.parse(readFileSync(miniAppStatePath(copy.manager.getSessionId(),f.root),'utf8'));
  assert.equal(state.entries.length,1);assert.equal(state.entries[0].anchor.id,next);
});

test('corrupt saved checkpoints cannot be carried into an otherwise valid fork',async t=>{
  const f=await fixture(t);await f.save(20);const copy=f.fork(),path=miniAppStatePath(f.manager.getSessionId(),f.root);
  const store=JSON.parse(readFileSync(path,'utf8'));store.entries[0].result.snapshot.state.count=21;
  writeFileSync(path,JSON.stringify(store)+'\n');
  await assert.rejects(copy.copy(),error=>error.code==='CORRUPT');
  assert.equal(existsSync(miniAppJournalPath(copy.manager.getSessionId(),f.root)),false);
  assert.equal(existsSync(miniAppStatePath(copy.manager.getSessionId(),f.root)),false);
});

test('a confirmed publication may be forked after its own result while later tool results and state are excluded',async t=>{
  const f=await fixture(t,{otherTool:true});await f.save(42);
  const copy=f.fork(f.manager,f.result);await copy.copy();
  const output=await f.read(copy.manager);assert.equal(output.writable,true);assert.equal(output.result.frame.summary,'Count: 2');
  assert.equal(copy.journal().records[0].turn.length,1);
  await f.save(8,copy.manager);assert.equal((await f.read()).result.frame.summary,'Count: 42');
});

test('unpublished candidates remain inert in inherited history and cannot acquire write permission',async t=>{
  const f=await fixture(t,{published:false}),copy=f.fork();
  assert.deepEqual(await copy.copy(),{copied:0,excluded:1});
  const output=await f.read(copy.manager);assert.equal(output.publication.status,'aborted');assert.equal(output.writable,false);
  assert.equal(copy.journal().records[0].reason,'INHERITED_UNCONFIRMED');
  await assert.rejects(f.save(7,copy.manager),error=>error.code==='CONFLICT');
});

test('altered fork history, missing source journals, and concurrent history edits never publish a sidecar',async t=>{
  for(const failure of ['history','journal','concurrent']){
    await t.test(failure,async t=>{
      const f=await fixture(t),copy=f.fork();
      const change=()=>{
        const path=copy.manager.getSessionFile(),rows=readFileSync(path,'utf8').trim().split('\n').map(JSON.parse);
        rows.find(row=>row.id===f.user).message.content='forged history';writeFileSync(path,rows.map(JSON.stringify).join('\n')+'\n');
      };
      if(failure==='history')change();
      if(failure==='journal')unlinkSync(miniAppJournalPath(f.manager.getSessionId(),f.root));
      await assert.rejects(copy.copy(failure==='concurrent'?{beforePublish:change}:{}),error=>error.code==='RECEIPT');
      assert.equal(existsSync(miniAppJournalPath(copy.manager.getSessionId(),f.root)),false);
      assert.equal(existsSync(miniAppStatePath(copy.manager.getSessionId(),f.root)),false);
    });
  }
});

test('generic copy and export adapters include the selected saved state as escaped static text',async t=>{
  const f=await fixture(t,{purpose:'A <script>alert(1)</script> & "B"'});await f.save(29);const leaf=f.manager.getLeafId(),copy=f.fork();
  await copyAnswerOutputState(copy.options.source,copy.options.target,copy.options.retainedEntryIds,copy.options);
  assert.equal((await f.read(copy.manager)).result.frame.summary,'Count: 29');
  const snapshot=readOnlySessionManager(f.manager.getSessionFile(),{expectedSessionId:f.manager.getSessionId(),leafId:leaf});
  const html=await answerOutputExportAppendix(f.manager.getSessionId(),f.manager.getSessionFile(),snapshot);
  assert.match(html,/Count: 29/);assert.doesNotMatch(html,/function init|<script|<iframe|Step counter ready/);
  assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;B&quot;/);
  const text=await readAnswerOutputSavedSnapshot('mini-app',copy.manager.getSessionId(),copy.manager.getSessionFile(),'mini');
  assert.match(text,/Count: 29/);assert.match(text,/Starting value: 2/);
  await assert.rejects(readAnswerOutputSavedSnapshot('mini-app',copy.manager.getSessionId(),copy.manager.getSessionFile(),'missing'),error=>error.code==='NOT_FOUND');
});

test('production duplicate endpoint publishes a usable saved mini app and independent target state',async t=>{
  const f=await fixture(t,{labelBeforeCall:true});await f.save(33);f.owned.release();
  invalidateSessionListCache();invalidateSessionPathCache(f.manager.getSessionId());
  const response=await duplicate(new Request('http://localhost/api/sessions/fixture/duplicate',{method:'POST'}),{params:Promise.resolve({id:f.manager.getSessionId()})});
  const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));
  const file=await resolveSessionPath(body.sessionId);assert.ok(file);assert.equal(dirname(file),dirname(f.manager.getSessionFile()));
  const target=SessionManager.open(file);
  assert.equal((await f.read(target)).result.frame.summary,'Count: 33');
  await f.save(35,target);assert.equal((await f.read()).result.frame.summary,'Count: 33');
  assert.equal((await f.read(target)).result.frame.summary,'Count: 35');
  invalidateSessionPathCache(body.sessionId);invalidateSessionPathCache(f.manager.getSessionId());invalidateSessionListCache();
});

test('a fork cut before the mini app contains no publication or state sidecars',async t=>{
  const f=await fixture(t);await f.save(19);const copy=f.fork(f.manager,f.user);
  assert.deepEqual(await copy.copy(),{copied:0,excluded:0});
  assert.equal(existsSync(miniAppJournalPath(copy.manager.getSessionId(),f.root)),false);
  assert.equal(existsSync(miniAppStatePath(copy.manager.getSessionId(),f.root)),false);
});
