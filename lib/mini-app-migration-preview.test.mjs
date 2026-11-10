import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createJiti } from 'jiti';
import { counterPlan } from './mini-app-fixtures.mjs';
import { migrationFixture } from './mini-app-migration-fixtures.mjs';
const jiti=createJiti(import.meta.url);
const {answerDataDigest}=await jiti.import('./answer-output-receipts.ts');
const {compileMiniAppPlan}=await jiti.import('./mini-app/plan.ts');
const {saveMiniAppOutput}=await jiti.import('./mini-app/state-service.ts');
const {writeBetaFeatures}=await jiti.import('./beta-features.ts');
const {beginPromptRun,finishPromptRun,getActivePromptRun}=await jiti.import('./prompt-run-registry.ts');
const {withUiFileLock,uiSessionLockPath}=await jiti.import('./intelligent-ui/session-lock.ts');
const plan=()=>{const p=counterPlan();return {...p,migration:{fromPlanDigest:answerDataDigest(compileMiniAppPlan(p).plan),description:'Keep progress relative to the starting value',clock:'preserve'},program:p.program+'\nfunction migrate(previous,inputs){return {count:previous.state.count+inputs.start-previous.inputs.start};}'};};
const preview=async(f,choice)=>{const response=await f.preview(choice);assert.equal(response.status,200,await response.clone().text());return (await response.json()).preview;};
const newer=async(f)=>{const old=await f.read('old');return saveMiniAppOutput({...f.options,enabled:()=>true,request:{requestId:'newer-source',toolCallId:'old',publicationId:old.publication.id,planDigest:old.publication.planDigest,runtimeVersion:old.publication.runtimeVersion,leafId:old.leafId,expectedRevision:old.stateRevision,checkpoint:{...old.result.snapshot,inputs:{start:9},state:{count:25}}}});};

test('preview reports actual source and reset/migration effects without writing session or journal',async t=>{
  const f=await migrationFixture(t,{next:plan()}),choice={...await f.choice(),inputs:{start:8},progress:'migrate'};
  const before={file:await readFile(f.file,'utf8'),journal:f.journal(),old:await f.read('old')};
  assert.match((await f.review()).sourceSummary,/19/);
  const migrated=await preview(f,choice);assert.match(migrated.sourceSummary,/19/);assert.match(migrated.resultSummary,/20/);
  assert.deepEqual(migrated.changes.items.find(x=>x.path==='/state/count'),{path:'/state/count',kind:'replace',before:19,after:20});
  const reset=await preview(f,{...choice,progress:'reset'});assert.match(reset.resultSummary,/8/);assert.notEqual(reset.digest,migrated.digest);
  assert.ok(reset.changes.items.some(x=>x.path==='/tick'&&x.before===13&&x.after===0));
  assert.deepEqual(f.journal(),before.journal);assert.equal(await readFile(f.file,'utf8'),before.file);assert.deepEqual(await f.read('old'),before.old);
  assert.equal(getActivePromptRun(f.id),undefined);
  assert.equal((await f.post({...choice,previewDigest:migrated.digest})).status,200);assert.equal((await f.read()).result.snapshot.state.count,20);
  assert.equal((await f.post({...choice,previewDigest:migrated.digest})).status,200,'Exact retry retains one receipt');
});

test('preview identity binds result, selected inputs, mode and latest source; mismatches never write an intent',async t=>{
  const f=await migrationFixture(t,{next:plan()}),choice={...await f.choice(),inputs:{start:8},progress:'migrate'},seen=await preview(f,choice);
  for(const extra of [{inputs:{start:9}},{progress:'reset'},{previewDigest:'0'.repeat(64)}]){
    assert.equal((await f.post({...choice,previewDigest:seen.digest,...extra})).status,409);assert.equal(f.journal().records[1].migration,undefined);
  }
  await newer(f);assert.equal((await f.preview(choice)).status,409);assert.equal((await f.post({...choice,previewDigest:seen.digest})).status,409);
  const latest={...await f.choice(),inputs:{start:10},progress:'migrate'},fresh=await preview(f,latest);
  assert.match(fresh.sourceSummary,/25/);assert.match(fresh.resultSummary,/26/);assert.notEqual(seen.digest,fresh.digest);
  assert.equal((await f.post({...latest,previewDigest:fresh.digest})).status,200);assert.equal((await f.read()).result.snapshot.state.count,26);
});

test('preview enforces same origin, JSON, beta, identities, busy runs and cancellation',async t=>{
  const f=await migrationFixture(t,{next:plan()}),choice=await f.choice();
  assert.equal((await f.preview(choice,{headers:{origin:'https://untrusted.test'}})).status,403);
  assert.equal((await f.preview(choice,{headers:{'content-type':'text/plain'}})).status,415);
  for(const invalid of [{...choice,force:true},{...choice,decision:'cancel',inputs:{}},{...choice,previewDigest:'0'.repeat(64)}])assert.equal((await f.preview(invalid)).status,400);
  assert.equal((await f.preview({...choice,publicationId:'wrong'})).status,409);
  assert.equal((await f.preview({...choice,leafId:'wrong'})).status,409);
  writeBetaFeatures({intelligentUi:false},f.root);assert.equal((await f.preview(choice)).status,403);writeBetaFeatures({intelligentUi:true},f.root);
  const run=beginPromptRun(f.id);assert.equal((await f.preview(choice)).status,409);await finishPromptRun(run,'idle');
  assert.equal((await f.preview(choice,{signal:AbortSignal.abort()})).status,409);
  assert.equal(f.journal().records[1].migration,undefined);assert.equal((await f.read('old')).writable,true);
});

test('an aborted preview waiting for the common lock cannot publish a result or own a prompt',async t=>{
  const f=await migrationFixture(t,{next:plan()}),choice=await f.choice(),controller=new AbortController();let entered,release;
  const ready=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
  const lock=withUiFileLock(uiSessionLockPath(f.id,f.root),async()=>{entered();await hold;});await ready;
  const request=f.preview(choice,{signal:controller.signal});controller.abort();release();await lock;
  assert.equal((await request).status,409);assert.equal(getActivePromptRun(f.id),undefined);assert.equal(f.journal().records[1].migration,undefined);
});

test('failed progress preview keeps the previous version and reset remains an explicit alternative',async t=>{
  const p=plan();p.program=counterPlan().program+'\nfunction migrate(){throw new Error("no compatible transfer");}';
  const f=await migrationFixture(t,{next:p}),choice=await f.choice();
  assert.equal((await f.preview({...choice,progress:'migrate'})).status,400);assert.equal(f.journal().records[1].migration,undefined);
  assert.equal((await f.read('old')).result.snapshot.state.count,19);const seen=await preview(f,choice);
  assert.equal((await f.post({...choice,previewDigest:seen.digest})).status,200);assert.equal((await f.read()).result.snapshot.state.count,7);
});

test('cancelled revisions cannot be previewed and previewing does not require confirmation before cancellation',async t=>{
  const f=await migrationFixture(t,{next:plan()}),choice=await f.choice();await preview(f,choice);
  assert.equal((await f.post({...choice,decision:'cancel',inputs:{}})).status,200);assert.equal((await f.preview(choice)).status,409);
  assert.equal((await f.read('old')).writable,true);
});

test('preview distinguishes removed fields, explicit null and omitted structural changes',async t=>{
  const p=plan(),state={score:0,empty:null,...Object.fromEntries(Array.from({length:18},(_,i)=>['value'+i,i]))};
  p.playback={mode:'none'};
  p.stateSchema={type:'object',properties:Object.fromEntries(Object.keys(state).map(key=>[key,key==='empty'?{type:'null'}:{type:'integer',minimum:0,maximum:10000}])),required:Object.keys(state),additionalProperties:false};
  p.program=`function init(){return ${JSON.stringify(state)};} function migrate(previous){const s=init();s.score=previous.state.count;return s;} function reduce(s){return s;} function advance(s){return s;} function project(s){return {summary:'Score: '+s.score,bindings:{count:s.score}};}`;
  const f=await migrationFixture(t,{next:p}),seen=await preview(f,{...await f.choice(),progress:'migrate'});
  assert.deepEqual(seen.changes.items.find(i=>i.path==='/state/count'),{path:'/state/count',kind:'remove',before:19});
  assert.deepEqual(seen.changes.items.find(i=>i.path==='/state/empty'),{path:'/state/empty',kind:'add',after:null});
  assert.equal(seen.changes.total,21);assert.equal(seen.changes.complete,false);assert.equal(seen.changes.omitted,21-seen.changes.items.length);
  assert.equal((await f.read('old')).result.snapshot.state.count,19);assert.equal(f.journal().records[1].migration,undefined);
});
