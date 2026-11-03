import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {createJiti} from 'jiti';
import {actionFixture} from './mini-app-action-fixtures.mjs';
import {prepareMiniAppRuntime} from '../scripts/prepare-mini-app-runtime.mjs';
await prepareMiniAppRuntime(join(import.meta.dirname,'..'));
const jiti=createJiti(import.meta.url);
const {runAnswerAction,recoverUiAction}=await jiti.import('./intelligent-ui/action-runtime.ts');
const readOptions=f=>({...f.options,input:{...f.options.input,actionId:'read'}});

test('mini app report uses confirmed progress, create-only files and durable click replay',async t=>{
 const f=await actionFixture(t),operation=await runAnswerAction(f.options);
 assert.equal(operation.status,'completed');
 const report=JSON.parse(readFileSync(join(f.root,'report.json'),'utf8'));
 assert.deepEqual(report.parameters,{start:2});assert.deepEqual(report.checkpoint.state,{count:19});assert.equal(report.checkpoint.tick,13);assert.equal(report.checkpoint.rng,12345);assert.equal(report.snapshot,'Step counter\nCount: 19');
 f.run.authorize=async()=>{throw new Error('must not replay');};writeFileSync(join(f.root,'report.json'),'user edit');
 assert.deepEqual(await runAnswerAction(f.options),operation);assert.equal(readFileSync(join(f.root,'report.json'),'utf8'),'user edit');
 await assert.rejects(runAnswerAction({...f.options,input:{...f.options.input,requestId:'new'}}),/already exists/);
 await assert.rejects(runAnswerAction(readOptions(f)),/already used/);
});
test('parameter reads are proposals; explicit adoption runs reducers once and preserves progress and clocks',async t=>{
 const f=await actionFixture(t);writeFileSync(join(f.root,'parameters.json'),'{"start":8}');
 const read=await runAnswerAction(readOptions(f));assert.equal(read.status,'completed');assert.deepEqual(read.result.state,{start:8});
 assert.deepEqual((await f.read()).result.snapshot.state,{count:19});
 f.manager.appendSessionInfo('Automatic title');
 const applied=await f.host.applyActionParameters('click',()=>{}),after=(await f.read()).result.snapshot;
 assert.equal(applied.alreadyApplied,false);assert.deepEqual(after.inputs,{start:8});assert.deepEqual(after.state,{count:27});assert.equal(after.tick,13);assert.equal(after.rng,12345);
 // Crash after atomic state+receipt commit, before action journal bookkeeping.
 const journal=JSON.parse(readFileSync(f.journalPath,'utf8'));delete journal.actionOperations[0].appliedRevision;writeFileSync(f.journalPath,JSON.stringify(journal));
 await f.save({...after,state:{count:31}},'later-edit');
 assert.deepEqual(await f.host.applyActionParameters('click',()=>{}),{...applied,alreadyApplied:true});assert.equal((await f.read()).result.snapshot.state.count,31);
});
test('changed state, branch, Beta, abort and target invalidate pending execution',async t=>{
 for(const reason of ['state','branch','beta','abort','target'])await t.test(reason,async t=>{
  const f=await actionFixture(t);let enabled=true;f.options.enabled=()=>enabled;
  f.run.authorize=async({evidence})=>{await evidence(f.controller.signal);
   if(reason==='state')await f.save({...f.source.result.snapshot,state:{count:20}});
   if(reason==='branch')f.manager.branch(f.manager.getBranch()[0].id);
   if(reason==='beta')enabled=false;
   if(reason==='abort')f.controller.abort();
   if(reason==='target')writeFileSync(join(f.root,'report.json'),'user file');return f.run.assertActive;};
  if(reason==='branch')await assert.rejects(runAnswerAction(f.options),/branch/);else assert.notEqual((await runAnswerAction(f.options)).status,'completed');
  assert.equal(existsSync(join(f.root,'report.json')),reason==='target');if(reason==='target')assert.equal(readFileSync(join(f.root,'report.json'),'utf8'),'user file');
 });
});
test('invalid files do not alter progress and stale proposals cannot replace newer inputs',async t=>{
 const f=await actionFixture(t);
 for(const [i,text]of ['{','{"start":99}','{"start":4,"start":8}','{"other":2}'].entries()){
  writeFileSync(join(f.root,'parameters.json'),text);const options=readOptions(f);options.input.requestId=`invalid-${i}`;
  const operation=await runAnswerAction(options);assert.equal(operation.status,'failed');assert.equal(operation.problem,'parameters_invalid');
 }
 writeFileSync(join(f.root,'parameters.json'),'{"start":8}');await runAnswerAction(readOptions(f));
 await f.save({...f.source.result.snapshot,inputs:{start:7},state:{count:22}});
 await assert.rejects(f.host.applyActionParameters('click',()=>{}),/changed since/);assert.deepEqual((await f.read()).result.snapshot.state,{count:22});
});
test('interrupted writes are observed and reconciled, never re-executed',async t=>{
 const f=await actionFixture(t);await runAnswerAction(f.options);
 const journal=JSON.parse(readFileSync(f.journalPath,'utf8'));journal.actionOperations[0].status='executing';delete journal.actionOperations[0].result;writeFileSync(f.journalPath,JSON.stringify(journal));
 const recovered=await recoverUiAction(f.host,'click',f.root,()=>false,true);assert.equal(recovered.status,'uncertain');assert.equal(recovered.reconciliation,'matching');
 assert.equal((await runAnswerAction(f.options)).status,'uncertain');
});
test('Markdown reports quote generated markup as inert text',async t=>{
 const f=await actionFixture(t),options={...f.options,input:{...f.options.input,actionId:'markdown'}};
 const operation=await runAnswerAction(options);assert.equal(operation.status,'completed');
 assert.ok(readFileSync(join(f.root,'report.md'),'utf8').trimEnd().split('\n').every(line=>line.startsWith('    ')));
});
