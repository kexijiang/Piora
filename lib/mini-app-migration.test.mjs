import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createJiti } from 'jiti';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { counterPlan } from './mini-app-fixtures.mjs';
const jiti=createJiti(import.meta.url,{alias:{'@':resolve(import.meta.dirname,'..')}});
const {miniAppJournalPath,copyMiniAppJournal,commitMiniAppMigration}=await jiti.import('./mini-app/journal.ts');
const {readMiniAppOutput,saveMiniAppOutput}=await jiti.import('./mini-app/state-service.ts');
const {assessMiniAppMigration}=await jiti.import('./mini-app/migration-types.ts');
const {writeBetaFeatures}=await jiti.import('./beta-features.ts');
const {beginPromptRun,finishPromptRun,getActivePromptRun}=await jiti.import('./prompt-run-registry.ts');
const {withUiFileLock,uiSessionLockPath}=await jiti.import('./intelligent-ui/session-lock.ts');
const fixture = (await import('./mini-app-migration-fixtures.mjs')).migrationFixture;

test('migration checks meaning, type, constraints and options rather than input names alone',()=>{
  const old=counterPlan(),next=counterPlan();next.inputs[0].value=3;
  assert.equal(assessMiniAppMigration(old,{start:7},next).suggestedInputs.start,7);
  for(const change of [{meaning:'Count in thousands'},{type:'range'},{max:30},{label:'Thousands'}]){
    const changed=structuredClone(next);Object.assign(changed.inputs[0],change);
    const review=assessMiniAppMigration(old,{start:7},changed);assert.equal(review.fields[0].change,'changed');assert.equal(review.suggestedInputs.start,3);
  }
  const removed={...next,inputs:[],document:{html:'<p data-text="count"></p>',css:''}};
  assert.equal(assessMiniAppMigration(old,{start:7},removed).fields[0].change,'removed');
});

test('owned confirmation initializes retained inputs once, preserves the old checkpoint and survives replay',async t=>{
  const f=await fixture(t),input=await f.choice(),before=await f.read('old');
  assert.equal(before.result.snapshot.state.count,19);assert.equal(input.inputs.start,7);
  const response=await f.post(input);assert.equal(response.status,200,JSON.stringify(await response.clone().json()));assert.deepEqual(await response.json(),{status:'committed'});
  const active=await f.read();assert.equal(active.writable,true);assert.equal(active.result.snapshot.inputs.start,7);assert.equal(active.result.snapshot.state.count,7);assert.equal(active.result.snapshot.tick,0);
  assert.equal((await f.read('old')).writable,false);assert.deepEqual((await f.read('old')).result,before.result);
  assert.deepEqual(await(await f.post(input)).json(),{status:'committed'});
  const entries=SessionManager.open(f.file).getEntries().filter(e=>e.customType==='piora-mini-app-confirmation');assert.equal(entries.length,1);assert.notEqual(entries[0].data.runId,'generation');
  assert.equal((await f.review()).status,'committed');assert.equal(getActivePromptRun(f.id),undefined);
  const changed={...input,inputs:{start:8}};assert.equal((await f.post(changed)).status,409);
});

test('changed units use new defaults, edited choices are validated and cancellation leaves the previous app active',async t=>{
  const next=counterPlan();next.inputs[0].meaning='Initial count in thousands';next.inputs[0].value=3;
  const f=await fixture(t,{next}),r=await f.review();assert.equal(r.fields[0].change,'changed');assert.equal(r.suggestedInputs.start,3);
  const confirm=await f.choice();assert.equal((await f.post({...confirm,inputs:{start:2000}})).status,400);assert.equal(f.journal().records[1].migration,undefined);
  const response=await f.post(await f.choice('cancel'));assert.equal(response.status,200);assert.deepEqual(await response.json(),{status:'cancelled'});
  assert.equal((await f.read()).publication.status,'aborted');assert.equal((await f.read('old')).writable,true);
});

test('a newer source checkpoint invalidates the exact review, then a fresh review retains the newer value',async t=>{
  const f=await fixture(t),input=await f.choice(),old=await f.read('old');
  await saveMiniAppOutput({...f.options,enabled:()=>true,request:{requestId:'another-window',toolCallId:'old',publicationId:old.publication.id,planDigest:old.publication.planDigest,runtimeVersion:old.publication.runtimeVersion,leafId:old.leafId,expectedRevision:old.stateRevision,checkpoint:{...old.result.snapshot,inputs:{start:9},state:{count:25}}}});
  assert.equal((await f.post(input)).status,409);assert.equal((await f.read('old')).writable,true);
  const revised=await f.choice();assert.notEqual(revised.digest,input.digest);assert.equal(revised.inputs.start,9);
  assert.equal((await f.post(revised)).status,200);assert.equal((await f.read()).result.snapshot.state.count,9);
});

test('same-origin, Beta, busy-run and strict choice guards cannot activate a revision',async t=>{
  const f=await fixture(t),input=await f.choice();
  assert.equal((await f.post(input,{headers:{origin:'https://untrusted.test'}})).status,403);
  assert.equal((await f.post({...input,force:true})).status,400);
  assert.equal((await f.post({...input,inputs:{}})).status,400);
  assert.equal((await f.post({...input,decision:'cancel',inputs:{start:7}})).status,400);
  writeBetaFeatures({intelligentUi:false},f.root);assert.equal((await f.post(input)).status,403);writeBetaFeatures({intelligentUi:true},f.root);
  const run=beginPromptRun(f.id);assert.equal((await f.post(input)).status,409);await finishPromptRun(run,'idle');
  assert.equal((await f.read()).publication.status,'awaiting_confirmation');assert.equal((await f.read('old')).writable,true);
  assert.throws(()=>commitMiniAppMigration({manager:SessionManager.open(f.file),root:f.root,choice:input,authorization:{kind:'host-ui-migration'},assertOwned(){}}),/authorized/);
});

test('older branches do not acquire a later confirmation; forks retain only branch-visible decisions',async t=>{
  const f=await fixture(t),input=await f.choice();assert.equal((await f.post(input)).status,200);
  const historical=await f.read('new',input.leafId);assert.equal(historical.publication.status,'awaiting_confirmation');assert.equal(historical.writable,false);
  assert.equal((await f.read('old',input.leafId)).publication.status,'committed');
  for(const [name,leaf] of [['before',input.leafId],['after',SessionManager.open(f.file).getLeafId()]]){
    const source=SessionManager.open(f.file);source.branch(leaf);const targetFile=source.createBranchedSession(leaf),target=SessionManager.open(targetFile);
    await copyMiniAppJournal({source:f.id,target:target.getSessionId(),sourceFile:f.file,targetFile,retainedEntryIds:target.getEntries().map(e=>e.id),sourceLeafId:leaf,root:f.root});
    const output=await readMiniAppOutput({sessionId:target.getSessionId(),readManager:()=>target,root:f.root,toolCallId:'new'});
    assert.equal(output.publication.status,name==='after'?'committed':'aborted');
    if(name==='after')assert.equal(output.result.snapshot.state.count,7);
  }
});

test('an interrupted confirmation entry is not auto-promoted on read and exact retry recovers one receipt',async t=>{
  const f=await fixture(t),input=await f.choice();assert.equal((await f.post(input)).status,200);
  const journal=f.journal(),record=journal.records[1];delete record.migration.anchor;record.status='awaiting_confirmation';
  writeFileSync(miniAppJournalPath(f.id,f.root),JSON.stringify(journal));
  assert.equal((await f.read()).publication.status,'awaiting_confirmation');assert.equal((await f.read('old')).writable,true);
  assert.equal((await f.review()).pending.requestId,input.requestId);
  assert.equal((await f.post(input)).status,200);assert.equal((await f.read()).result.snapshot.state.count,7);
  assert.equal(SessionManager.open(f.file).getEntries().filter(e=>e.customType==='piora-mini-app-confirmation').length,1);
});

test('aborting while waiting for the common lock revokes confirmation and releases session ownership',async t=>{
  const f=await fixture(t),input=await f.choice(),controller=new AbortController();let release,entered;
  const ready=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
  const lock=withUiFileLock(uiSessionLockPath(f.id,f.root),async()=>{entered();await hold;});await ready;
  const posting=f.post(input,{signal:controller.signal});await new Promise(r=>setTimeout(r,80));controller.abort();release();await lock;
  assert.equal((await posting).status,409);assert.equal((await f.read()).publication.status,'awaiting_confirmation');assert.equal((await f.read('old')).writable,true);
  assert.equal(getActivePromptRun(f.id),undefined);assert.equal(globalThis.__pioraSessionFileOwners?.has(f.id)??false,false);
});

test('a failing initialization leaves no decision intent and the old task progress stays active',async t=>{
  const next=counterPlan();next.program=next.program.replace('return {count:inputs.start};','if(inputs.start===9)throw new Error("unsupported count");return {count:inputs.start};');
  const f=await fixture(t,{next}),input=await f.choice();
  assert.equal((await f.post({...input,inputs:{start:9}})).status,400);
  assert.equal(f.journal().records[1].migration,undefined);assert.equal((await f.read('old')).result.snapshot.state.count,19);assert.equal((await f.read('old')).writable,true);
  assert.equal((await f.post(input)).status,200);assert.equal((await f.read()).result.snapshot.state.count,7);
});

test('confirmation receipts bind the projected result and reject later journal tampering',async t=>{
  const f=await fixture(t);assert.equal((await f.post(await f.choice())).status,200);
  const journal=f.journal();journal.records[1].migration.result.snapshot.state.count=999;
  writeFileSync(miniAppJournalPath(f.id,f.root),JSON.stringify(journal));
  await assert.rejects(f.read(),/migration receipt changed/);
});
