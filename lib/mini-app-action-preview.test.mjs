import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
import { counterPlan, discreteCounterPlan } from './mini-app-fixtures.mjs';
import { prepareMiniAppRuntime } from '../scripts/prepare-mini-app-runtime.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const jiti=createJiti(import.meta.url);
const {previewMiniAppActions,trialMiniApp}=await jiti.import('./mini-app/server-trial.ts');
const {compileMiniAppPlan}=await jiti.import('./mini-app/plan.ts');
const {miniAppPreviewChoices,compactMiniAppActionEvidence,validateMiniAppActionEvidence}=await jiti.import('./mini-app/action-preview.ts');
const {bindMiniAppGenerationRuntime}=await jiti.import('./mini-app/generation-runtime.ts');
const {answerDataDigest}=await jiti.import('./answer-output-receipts.ts');
const {miniAppCheckpointChanges,validateMiniAppCheckpointChanges}=await jiti.import('./mini-app/checkpoint-changes.ts');
await prepareMiniAppRuntime();

const vesselPlan=()=>({
  ...counterPlan(),id:'vessels',title:'Two vessels',inputs:[],playback:{mode:'none'},
  stateSchema:{type:'object',properties:{small:{type:'integer',minimum:0,maximum:3},large:{type:'integer',minimum:0,maximum:5}},required:['small','large'],additionalProperties:false},
  document:{html:'<section>'+['fillSmall','fillLarge','emptySmall','emptyLarge','toSmall','toLarge'].map(id=>`<button data-event="${id}">${id}</button>`).join('')+'<p data-text="water"></p></section>',css:''},
  program:`function init(){return {small:0,large:0};}
function reduce(state,event){
  if(event.type!=='click')return state;
  if(event.id==='fillSmall')state.small=3;
  if(event.id==='fillLarge')state.large=5;
  if(event.id==='emptySmall')state.small=0;
  if(event.id==='emptyLarge')state.large=0;
  if(event.id==='toSmall'){let amount=Math.min(3-state.small,state.large);state.small+=amount;state.large-=amount;}
  if(event.id==='toLarge'){let amount=Math.min(5-state.large,state.small);state.large+=amount;state.small-=amount;}
  return state;
}
function advance(state){return state;}
function project(state){return {summary:'Small '+state.small+'; large '+state.large,bindings:{water:state.small+'/'+state.large}};}`,
});

test('actual isolated alternatives preserve a full target vessel, conserve transfers and never mutate the source',async()=>{
  const plan=vesselPlan(),snapshot={inputs:{},state:{small:3,large:4},tick:6,rng:123};
  const original=structuredClone(snapshot),evidence=await previewMiniAppActions(plan,snapshot);
  const byId=Object.fromEntries(evidence.actions.map(action=>[action.id,action]));
  assert.deepEqual(snapshot,original);
  assert.deepEqual(byId.toSmall.snapshot,original,'a full receiving vessel accepts no water');
  assert.equal(byId.toSmall.checkpointUnchanged,true);
  assert.deepEqual(byId.toSmall.changes,{complete:true,total:0,omitted:0,items:[]});
  assert.deepEqual(byId.emptySmall.snapshot.state,{small:0,large:4},'emptying the other vessel preserves the target 4');
  assert.deepEqual(byId.toLarge.snapshot.state,{small:2,large:5},'only the remaining 1 unit of capacity transfers');
  assert.deepEqual(byId.toLarge.changes.items,[{path:'/state/small',kind:'replace',before:3,after:2},{path:'/state/large',kind:'replace',before:4,after:5}]);
  assert.deepEqual(byId.fillLarge.snapshot.state,{small:3,large:5});
  assert.deepEqual(byId.emptyLarge.snapshot.state,{small:3,large:0});
  for(const action of evidence.actions){assert.equal(action.snapshot.tick,6);assert.equal(action.snapshot.rng,123);}
  assert.equal(evidence.eligibleActions,6);assert.equal(evidence.omittedActions,0);
  assert.deepEqual((await trialMiniApp(plan,{snapshot})).snapshot,original);
});

test('discrete alternatives use the live step transition, while seeded alternatives start from the same RNG',async()=>{
  const plan=discreteCounterPlan(),saved={inputs:{start:2},state:{count:3},tick:8,rng:123};
  const evidence=await previewMiniAppActions(plan,saved);
  assert.deepEqual(evidence.actions[0].snapshot,{...saved,state:{count:4},tick:9});
  const random=counterPlan();random.document.html+='<button data-event="second">Second</button>';
  random.program=random.program.replace('state.count+1:state.count','Math.floor(ctx.random()*1000):state.count');
  const alternatives=await previewMiniAppActions(random,saved);
  assert.equal(alternatives.actions.length,2);
  assert.deepEqual(alternatives.actions[0].snapshot,alternatives.actions[1].snapshot);
  assert.notEqual(alternatives.actions[0].snapshot.rng,saved.rng);
  assert.equal(saved.rng,123);
});

test('declared disabled buttons do not execute; unobserved controls and capped alternatives are explicit',async()=>{
  const plan=counterPlan();
  plan.document.html+='<button disabled data-event="blocked">Blocked</button><div data-event="drag">Drag</div>'
    +'<div data-event="roleButton" role="button" data-text="count"></div>'
    +Array.from({length:14},(_,i)=>`<button data-event="extra${i}">Choice ${i}</button>`).join('');
  plan.program=plan.program.replace("return {count:event.type===", "if(event.id==='blocked')throw new Error('disabled');return {count:event.type===");
  const saved={inputs:{start:2},state:{count:7},tick:3,rng:1};
  const evidence=await previewMiniAppActions(plan,saved);
  assert.equal(evidence.eligibleActions,17);assert.equal(evidence.actions.length,12);assert.equal(evidence.omittedActions,5);
  assert.deepEqual(evidence.actions[1],{id:'blocked',label:'Blocked',disabled:true,status:'disabled'});
  assert.equal(evidence.actions[2].label,'7');assert.ok(!evidence.actions.some(a=>a.id==='drag'));
  for(const action of evidence.actions.filter(a=>a.status==='ok'))assert.equal(action.snapshot.state.count,8,'alternatives never feed each other');
  const compact=compactMiniAppActionEvidence(evidence,600);
  assert.ok(JSON.stringify(compact).length<=600);assert.equal(compact.omittedActions,17-compact.actions.length);
  const baseline=await trialMiniApp(plan,{snapshot:saved}),compiled=compileMiniAppPlan(plan);
  assert.equal(miniAppPreviewChoices(compiled,baseline.frame).length,17);
  assert.deepEqual(validateMiniAppActionEvidence(compiled,baseline,evidence),evidence);
  for(const mutate of [e=>e.sourceCheckpointDigest='0'.repeat(64),e=>e.actions[0].id='unknown',e=>e.actions[0].snapshot.state.count=-1,e=>e.omittedActions=0,
    e=>e.actions[0].changes.items[0].before=6,e=>e.actions[0].changes.items[0].after=9]){
    const bad=structuredClone(evidence);mutate(bad);assert.throws(()=>validateMiniAppActionEvidence(compiled,baseline,bad));
  }
});

test('large state is omitted as a whole while bounded summaries are explicitly marked incomplete',async()=>{
  const plan=counterPlan();
  plan.stateSchema.properties.padding={type:'string',maxLength:2000};plan.stateSchema.required.push('padding');
  plan.program=plan.program.replace('return {count:inputs.start};',"return {count:inputs.start,padding:'x'};")
    .replace("return {count:event.type", "return {padding:state.padding,count:event.type")
    .replace("summary:'Count: '+state.count", "summary:state.padding");
  const snapshot={inputs:{start:2},state:{count:4,padding:'x'.repeat(1800)},tick:2,rng:123};
  const evidence=await previewMiniAppActions(plan,snapshot);
  assert.equal(evidence.actions[0].snapshot,null);assert.equal(evidence.actions[0].summaryComplete,false);
  assert.equal(evidence.actions[0].summary.length,384);assert.equal(snapshot.state.count,4);
  assert.deepEqual(evidence.actions[0].changes,{complete:true,total:1,omitted:0,items:[{path:'/state/count',kind:'replace',before:4,after:5}]},'large unchanged state does not hide a small exact change');
});

// Journal acquisition is a fixture here; preview worker, cache, context budget
// and lifecycle boundaries are real. Disk/SDK integration is tested separately.
test('context evidence follows saved revisions, keeps failures optional and never leaks across revoked runs',async()=>{
  const root=await mkdtemp(join(tmpdir(),'piora-preview-context-')),sessionId=randomUUID();
  const manager={getSessionId:()=>sessionId,getSessionFile:()=>join(root,'fixture.jsonl'),getLeafId:()=> 'leaf',getBranch:()=>[]};
  const runtime=bindMiniAppGenerationRuntime({manager,root,identity:{sessionId,runId:randomUUID()},isActive:()=>true,assertOwned(){}});
  const plan=counterPlan(),initial=await trialMiniApp(plan);
  const source={record:{plan,planDigest:answerDataDigest(plan),revision:1,operationId:'publication',toolCallId:'call'},
    saved:{result:initial,stateRevision:0,checkpointDigest:answerDataDigest(initial.snapshot)}};
  runtime.journal={start:async()=>{},capture:async()=>({context:{requestId:randomUUID(),leafId:'leaf'},apps:structuredClone([source])}),abortCandidates:async()=>{}};
  const capture=async()=>{const text=await runtime.captureContext();return JSON.parse(text.slice(text.indexOf('\n')+1)).apps[0];};
  try{
    const first=await capture();assert.deepEqual(first.localActionPreviews.actions[0].changes.items,[{path:'/state/count',kind:'replace',before:2,after:3}]);
    assert.equal(Object.hasOwn(first.localActionPreviews.source,'publicationId'),false,'internal operation credentials stay out of model context');
    source.saved.result.snapshot.state.count=20;source.saved.result.frame.summary='Count: 20';source.saved.stateRevision=1;
    source.saved.checkpointDigest=answerDataDigest(source.saved.result.snapshot);
    const next=await capture();assert.deepEqual(next.localActionPreviews.actions[0].changes.items,[{path:'/state/count',kind:'replace',before:20,after:21}]);
    assert.equal(next.localActionPreviews.source.stateRevision,1);assert.notEqual(next.localActionPreviews.source.checkpointDigest,first.localActionPreviews.source.checkpointDigest);
    assert.equal(source.saved.result.snapshot.state.count,20);
    plan.program=plan.program.replace('function reduce(state,event,ctx){','function reduce(state,event,ctx){while(true){}');
    source.record.planDigest=answerDataDigest(plan);
    const failed=await capture();assert.equal(failed.summary,'Count: 20');assert.equal(failed.progressSource.snapshot.state.count,20);
    assert.equal(failed.localActionPreviews.unavailable,'TIME_LIMIT');
    const pending=capture();await runtime.finish('abort');
    await assert.rejects(pending,error=>error.code==='STOPPED');
    await assert.rejects(runtime.captureContext(),error=>error.code==='STOPPED');
  }finally{await runtime.finish('abort');await rm(root,{recursive:true,force:true});}
});

test('context prioritizes recent apps, retains core state and reports every preview dropped by its shared budget',async()=>{
  const root=await mkdtemp(join(tmpdir(),'piora-preview-budget-')),sessionId=randomUUID();
  const manager={getSessionId:()=>sessionId,getSessionFile:()=>join(root,'fixture.jsonl'),getLeafId:()=> 'leaf',getBranch:()=>[]};
  const runtime=bindMiniAppGenerationRuntime({manager,root,identity:{sessionId,runId:randomUUID()},isActive:()=>true,assertOwned(){}});
  const base=counterPlan(),initial=await trialMiniApp(base),sources=Array.from({length:9},(_,i)=>{
    const plan={...base,id:`counter${i}`};
    return {record:{plan,planDigest:answerDataDigest(plan),revision:1,operationId:`pub${i}`,toolCallId:`call${i}`},
      saved:{result:{...structuredClone(initial),frame:{...initial.frame,summary:'Saved '.repeat(145)}},stateRevision:0,checkpointDigest:answerDataDigest(initial.snapshot)}};
  });
  runtime.journal={start:async()=>{},capture:async()=>({context:{requestId:randomUUID(),leafId:'leaf'},apps:structuredClone(sources)}),abortCandidates:async()=>{}};
  try{
    const text=await runtime.captureContext(),json=text.slice(text.indexOf('\n')+1),context=JSON.parse(json);
    assert.ok(json.length<=11000);assert.equal(context.apps[0].id,'counter8');assert.ok(context.omittedApps>=1);
    assert.equal(context.apps[0].progressSource.complete,true);assert.equal(context.apps[0].progressSource.snapshot.state.count,2);
    assert.equal(context.apps[0].summary,'Saved '.repeat(145));
    assert.ok(context.apps.filter(app=>app.localActionPreviews).length<=2);
    for(const app of context.apps)if(app.localActionPreviews){const evidence=app.localActionPreviews;assert.equal(evidence.omittedActions,evidence.eligibleActions-evidence.actions.length);}
  }finally{await runtime.finish('abort');await rm(root,{recursive:true,force:true});}
});

test('preview failure and cancellation preserve normal restore and leave worker capacity available',async()=>{
  const plan=counterPlan(),snapshot={inputs:{start:2},state:{count:2},tick:0,rng:123};
  plan.program=plan.program.replace("function reduce(state,event,ctx){", "function reduce(state,event,ctx){if(event.type==='click'){while(true){}} ");
  await assert.rejects(previewMiniAppActions(plan,snapshot),error=>['TIME_LIMIT','WATCHDOG'].includes(error.code));
  assert.deepEqual((await trialMiniApp(plan,{snapshot})).snapshot,snapshot,'optional previews must not change historical restore semantics');
  const abort=new AbortController(),pending=previewMiniAppActions(plan,snapshot,{signal:abort.signal});abort.abort();
  await assert.rejects(pending,error=>error.code==='STOPPED');
  assert.equal((await previewMiniAppActions(counterPlan(),snapshot)).actions[0].snapshot.state.count,3);
});

test('checkpoint observations distinguish missing, null, false, zero, empty arrays and positional list changes',()=>{
  const before={inputs:{},state:{keep:0,remove:null,flag:false,list:['a','b'],'a/b':{'~key':1},empty:[]},tick:0,rng:123};
  const after={inputs:{},state:{keep:0,added:null,flag:true,list:['b'],'a/b':{'~key':2},empty:{}},tick:1,rng:123};
  const changes=miniAppCheckpointChanges(before,after);
  assert.deepEqual(changes,{complete:true,total:8,omitted:0,items:[
    {path:'/state/remove',kind:'remove',before:null},{path:'/state/flag',kind:'replace',before:false,after:true},
    {path:'/state/list/0',kind:'replace',before:'a',after:'b'},{path:'/state/list/1',kind:'remove',before:'b'},
    {path:'/state/a~1b/~0key',kind:'replace',before:1,after:2},{path:'/state/empty',kind:'replace',before:[],after:{}},
    {path:'/state/added',kind:'add',after:null},{path:'/tick',kind:'replace',before:0,after:1},
  ]});
  assert.deepEqual(validateMiniAppCheckpointChanges(before,changes),changes);
  for(const mutate of [d=>d.complete=false,d=>d.total=9,d=>d.items[0].before=0,d=>d.items[1].path='/state/not~valid',
    d=>d.items[1].path='/state/remove',d=>d.items[1].path='/state',d=>d.items[1].extra='ignored']){
    const bad=structuredClone(changes);mutate(bad);assert.throws(()=>validateMiniAppCheckpointChanges(before,bad));
  }
  const reordered={rng:123,tick:0,state:{empty:[],'a/b':{'~key':1},list:['a','b'],flag:false,remove:null,keep:0},inputs:{}};
  assert.equal(miniAppCheckpointChanges(before,reordered).total,0,'JSON object order is not a state change');
});

test('change budgets count omitted large values and excess fields without implying unchanged state',()=>{
  const before={inputs:{},state:{long:'x'.repeat(2000),...Object.fromEntries(Array.from({length:25},(_,i)=>['item'+i,i]))},tick:0,rng:1};
  const after=structuredClone(before);after.state.long='y'.repeat(2000);for(let i=0;i<25;i++)after.state['item'+i]++;
  const changes=miniAppCheckpointChanges(before,after);
  assert.equal(changes.complete,false);assert.equal(changes.total,26);assert.equal(changes.items.length,12);assert.equal(changes.omitted,14);
  assert.ok(!changes.items.some(item=>item.path==='/state/long'));
  assert.deepEqual(validateMiniAppCheckpointChanges(before,changes),changes);
  assert.equal(before.state.item0,0);assert.equal(before.state.long,'x'.repeat(2000));
});
