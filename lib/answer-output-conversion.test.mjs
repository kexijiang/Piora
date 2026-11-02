import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
import {resolve} from 'node:path';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {conversionFixture} from './answer-output-conversion-fixtures.mjs';
const jiti=createJiti(import.meta.url,{alias:{'@':resolve(import.meta.dirname,'..')}});
const {writeBetaFeatures}=await jiti.import('./beta-features.ts');
const {beginPromptRun,finishPromptRun}=await jiti.import('./prompt-run-registry.ts');
const {UiGenerationPrototype}=await jiti.import('./intelligent-ui/generation-journal.ts');
const {saveMiniAppOutput}=await jiti.import('./mini-app/state-service.ts');
const {copyMiniAppJournal}=await jiti.import('./mini-app/journal.ts');
const {copyGenerationJournal}=await jiti.import('./intelligent-ui/generation-journal.ts');
const {readUiOutput}=await jiti.import('./intelligent-ui/read-output.ts');
const {readMiniAppOutput}=await jiti.import('./mini-app/state-service.ts');
const {readMiniAppConversionSource}=await jiti.import('./mini-app/journal.ts');
const {saveSurfaceState}=await jiti.import('./intelligent-ui/store.ts');
const {componentPlan}=await import('./answer-output-conversion-fixtures.mjs');
const status=output=>output.publication.status;
for(const targetKind of ['mini-app','intelligent-ui']){
  test(`${targetKind}: conversion is explicit, preserves the old snapshot and activates once`,async t=>{
    const f=await conversionFixture(t,{targetKind}),old=await f.read('old'),r=await f.review(),choice=await f.choice();
    assert.equal(r.status,'ready');assert.equal(status(await f.read()),'awaiting_confirmation');assert.equal(status(old),'committed');
    assert.deepEqual(choice.inputs,targetKind==='mini-app'?{start:2}:{start:3});
    assert.deepEqual(r.source.inputs,targetKind==='mini-app'?{start:3}:{start:7});
    choice.inputs={start:9};
    const response=await f.post(choice);assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
    assert.equal(status(await f.read()),'committed');assert.equal(status(await f.read('old')),'superseded');
    const current=await f.read();if(targetKind==='mini-app'){assert.equal(current.result.snapshot.state.count,9);assert.equal(current.result.snapshot.tick,0);}else assert.deepEqual(current.state,{start:9});
    if(targetKind==='mini-app')await assert.rejects(new UiGenerationPrototype({manager:SessionManager.open(f.file),root:f.root}).saveOutput({toolCallId:'old',leafId:current.leafId,expectedRevision:old.revision,state:{start:4},enabled:()=>true}),/changed|superseded|current|active|generation|revision/i);
    else await assert.rejects(saveMiniAppOutput({...f.options,enabled:()=>true,request:{requestId:'stale-write',toolCallId:'old',publicationId:old.publication.id,planDigest:old.publication.planDigest,runtimeVersion:old.publication.runtimeVersion,leafId:current.leafId,expectedRevision:old.stateRevision,checkpoint:old.result.snapshot}}),/changed/);
    const historical=await f.read('old',choice.leafId);assert.equal(status(historical),'committed');
    assert.deepEqual(targetKind==='mini-app'?historical.state:historical.result,targetKind==='mini-app'?old.state:old.result);
    assert.equal(status(await f.read('new',choice.leafId)),'awaiting_confirmation');
    assert.equal((await f.post(choice)).status,200);assert.equal((await f.post({...choice,inputs:{start:8}})).status,409);
    assert.equal(SessionManager.open(f.file).getEntries().filter(e=>e.customType==='piora-answer-conversion-complete').length,1);
  });
  test(`${targetKind}: cancellation, invalid choices and request guards leave source active`,async t=>{
    const f=await conversionFixture(t,{targetKind}),choice=await f.choice();
    assert.equal((await f.post(choice,{headers:{origin:'https://untrusted.test'}})).status,403);
    assert.equal((await f.post({...choice,force:true})).status,400);
    assert.equal((await f.post({...choice,inputs:{start:200}})).status,400);
    writeBetaFeatures({intelligentUi:false},f.root);assert.equal((await f.post(choice)).status,403);writeBetaFeatures({intelligentUi:true},f.root);
    const run=beginPromptRun(f.id);assert.equal((await f.post(choice)).status,409);await finishPromptRun(run,'idle');
    assert.equal((await f.post(await f.choice('cancel'))).status,200);assert.equal(status(await f.read()),'aborted');assert.equal(status(await f.read('old')),'committed');
  });
  for(const stage of ['intent','state','complete'])test(`${targetKind}: interrupted ${stage} is readable and exact retry does not duplicate conversion`,async t=>{
    const f=await conversionFixture(t,{targetKind}),choice=await f.choice();choice.inputs={start:8};
    await assert.rejects(f.confirm(choice,{fault:at=>{if(at===stage)throw new Error('injected '+stage);}}),/injected/);
    assert.equal(status(await f.read('old')),stage==='complete'?'superseded':'committed');
    assert.equal(status(await f.read()),stage==='complete'?'committed':'awaiting_confirmation');
    const before=SessionManager.open(f.file).getEntries().length;await f.review();assert.equal(SessionManager.open(f.file).getEntries().length,before);
    assert.equal((await f.post(choice)).status,200);assert.equal(status(await f.read()),'committed');
    assert.equal(SessionManager.open(f.file).getEntries().filter(e=>e.customType==='piora-answer-conversion-complete').length,1);
  });
  test(`${targetKind}: forks before and after completion inherit only the branch-visible choice`,async t=>{
    const f=await conversionFixture(t,{targetKind}),choice=await f.choice();choice.inputs={start:8};await f.confirm(choice);
    for(const [name,leaf] of [['before',choice.leafId],['after',SessionManager.open(f.file).getLeafId()]]){
      const source=SessionManager.open(f.file);source.branch(leaf);const targetFile=source.createBranchedSession(leaf),target=SessionManager.open(targetFile);
      const args={source:f.id,target:target.getSessionId(),sourceFile:f.file,targetFile,retainedEntryIds:target.getEntries().map(e=>e.id),sourceLeafId:leaf,root:f.root};
      await copyGenerationJournal(args);await copyMiniAppJournal(args);
      const next=targetKind==='mini-app'?await readMiniAppOutput({sessionId:target.getSessionId(),readManager:()=>target,root:f.root,toolCallId:'new'}):await readUiOutput(target,'new',{root:f.root});
      assert.equal(status(next),name==='after'?'committed':'aborted');
      if(name==='after')assert.equal(targetKind==='mini-app'?next.result.snapshot.inputs.start:next.state.start,8);
      const old=targetKind==='mini-app'?await readUiOutput(target,'old',{root:f.root}):await readMiniAppOutput({sessionId:target.getSessionId(),readManager:()=>target,root:f.root,toolCallId:'old'});
      assert.equal(status(old),name==='after'?'superseded':'committed');
    }
  });
  test(`${targetKind}: cancelling an interrupted state commit never activates the installed candidate`,async t=>{
    const f=await conversionFixture(t,{targetKind}),choice=await f.choice();
    await assert.rejects(f.confirm(choice,{fault:at=>{if(at==='state')throw new Error('stop');}}),/stop/);
    const cancel=await f.choice('cancel');assert.equal((await f.post(cancel)).status,200);
    assert.equal(status(await f.read('old')),'committed');assert.equal(status(await f.read()),'aborted');
  });
}
test('source edits invalidate conversion rather than silently remapping current values',async t=>{
  const f=await conversionFixture(t,{targetKind:'intelligent-ui'}),choice=await f.choice(),old=await f.read('old');
  await saveMiniAppOutput({...f.options,enabled:()=>true,request:{requestId:'changed',toolCallId:'old',publicationId:old.publication.id,planDigest:old.publication.planDigest,runtimeVersion:old.publication.runtimeVersion,leafId:old.leafId,expectedRevision:old.stateRevision,checkpoint:{...old.result.snapshot,inputs:{start:9}}}});
  assert.equal((await f.post(choice)).status,409);assert.equal((await f.review()).status,'stale');assert.equal(status(await f.read('old')),'committed');
});
test('serialized grants cannot install conversion state directly',async t=>{
  const f=await conversionFixture(t,{targetKind:'intelligent-ui'}),r=await f.review();
  await f.mutate(async manager=>{
    const host=new UiGenerationPrototype({manager,root:f.root,mutationOwner:{assertOwned(){}}});
    await assert.rejects(host.commitConversionTarget({target:r.target.identity,intentId:'fake',intent:{},requestDigest:r.digest,authorization:{kind:'host-ui-migration'}}),/authorized/);
  });
});

test('legacy component sources remain readable and cannot overwrite a converted mini app',async t=>{
  const f=await conversionFixture(t,{legacySource:true}),choice=await f.choice();
  assert.equal((await f.review()).status,'ready');assert.equal((await f.post(choice)).status,200);
  assert.equal(status(await f.read('old')),'superseded');
  const manager=SessionManager.open(f.file);
  await assert.rejects(saveSurfaceState({sessionId:f.id,toolCallId:'old',leafId:manager.getLeafId(),expectedRevision:0,state:{start:4},root:f.root,branch:()=>manager.getBranch(),enabled:()=>true}),/mini app|current|changed|branch/i);
});

test('an explicit return conversion reactivates only the new component revision and exports one active form',async t=>{
  const f=await conversionFixture(t),first=await f.choice();await f.confirm(first);
  await f.mutate(async manager=>{
    manager.appendMessage({role:'user',content:'Return to the component interface',timestamp:20});
    const source=readMiniAppConversionSource(f.id,f.file,'new',manager.getLeafId(),f.root),plan=componentPlan();
    plan.conversion={fromKind:'mini-app',fromToolCallId:'new',fromDigest:source.identity.digest,description:'Return to components; keep chosen values'};
    await f.publish('intelligent-ui','return',plan);
  });
  const {readAnswerConversion,confirmAnswerConversion}=await jiti.import('./answer-output-conversion-service.ts');
  const r=await readAnswerConversion({sessionId:f.id,sessionFile:f.file,root:f.root,kind:'intelligent-ui',toolCallId:'return'});
  await confirmAnswerConversion({sessionId:f.id,sessionFile:f.file,root:f.root,enabled:()=>true,input:{kind:'intelligent-ui',toolCallId:'return',requestId:'return-choice',leafId:r.leafId,digest:r.digest,decision:'confirm',inputs:{start:12}}});
  const manager=SessionManager.open(f.file),result=await readUiOutput(manager,'return',{root:f.root});assert.equal(status(result),'committed');assert.deepEqual(result.state,{start:12});
  assert.equal(status(await f.read('old')),'superseded');assert.equal(status(await f.read('new')),'superseded');
  const snapshot=await new UiGenerationPrototype({manager,root:f.root}).readDecisionRecords();assert.equal(snapshot.records.length,1);assert.deepEqual(snapshot.records[0].state,{start:12});
});
