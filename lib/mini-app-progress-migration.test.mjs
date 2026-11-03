import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createJiti } from 'jiti';
import { counterPlan, heldInputPlan } from './mini-app-fixtures.mjs';
import { migrationFixture } from './mini-app-migration-fixtures.mjs';
const jiti=createJiti(import.meta.url),require=createRequire(import.meta.url);
const {compileMiniAppPlan}=await jiti.import('./mini-app/plan.ts');
const {answerDataDigest}=await jiti.import('./answer-output-receipts.ts');
const {trialMiniApp}=await jiti.import('./mini-app/server-trial.ts');
const {MiniAppVm}=await jiti.import('./mini-app/vm.ts');
const {requiredMiniAppCapabilities,assertMiniAppCapabilities}=await jiti.import('./mini-app/capabilities.ts');
const {miniAppSceneExample}=await jiti.import('./mini-app/scene-example.ts');
const digest=plan=>answerDataDigest(compileMiniAppPlan(plan).plan);
const progressPlan=(clock='preserve')=>({...counterPlan(),migration:{fromPlanDigest:digest(counterPlan()),description:'Keep the number of steps beyond the starting value',clock},
  program:counterPlan().program+'\nfunction migrate(previous,inputs){return {count:previous.state.count+inputs.start-previous.inputs.start};}'});

test('progress contract requires an exact source, migration function and separate capability; historical identity stays stable',()=>{
  assert.equal(compileMiniAppPlan(counterPlan()).runtimeVersion,'mini-app-1.1');
  const compiled=compileMiniAppPlan(progressPlan());assert.equal(compiled.runtimeVersion,'mini-app-1.7');assert.ok(requiredMiniAppCapabilities(compiled).includes('stateMigration'));
  const snapshot={capabilities:requiredMiniAppCapabilities(compiled).map(id=>({id,available:id!=='stateMigration',reason:'not enabled'}))};
  assert.throws(()=>assertMiniAppCapabilities(compiled,snapshot),/stateMigration/);
  for(const migration of [{...progressPlan().migration,fromPlanDigest:'old'}, {...progressPlan().migration,clock:'guess'}, {...progressPlan().migration,force:true}])assert.throws(()=>compileMiniAppPlan({...progressPlan(),migration}));
  assert.throws(()=>compileMiniAppPlan({...progressPlan(),program:counterPlan().program}),/migrate/);
});

test('server trial transfers progress with current inputs, declares clock behavior and never changes the source',async()=>{
  const source=counterPlan(),initial=await trialMiniApp(source),snapshot={...initial.snapshot,inputs:{start:7},state:{count:19},tick:13,rng:12345},original=structuredClone(snapshot);
  for(const clock of ['preserve','reset']){
    const result=await trialMiniApp(progressPlan(clock),{inputs:{start:8},migration:{sourcePlan:source,snapshot}});
    assert.equal(result.snapshot.state.count,20);assert.equal(result.frame.bindings.count,20);assert.equal(result.snapshot.tick,clock==='preserve'?13:0);assert.equal(result.snapshot.rng,clock==='preserve'?12345:0x50494f52);assert.equal(result.snapshot.view,undefined);
  }
  assert.deepEqual(snapshot,original);
  const bad=progressPlan();bad.migration.fromPlanDigest='0'.repeat(64);
  await assert.rejects(trialMiniApp(bad,{migration:{sourcePlan:source,snapshot}}),/source program/);
  await assert.rejects(trialMiniApp(progressPlan(),{migration:{sourcePlan:source,snapshot:{...snapshot,state:{count:'not a number'}}}}));
});

test('migration releases held keys and pointer grabs through the new blur reducer',async()=>{
  const source=heldInputPlan(),initial=await trialMiniApp(source),plan={...source,migration:{fromPlanDigest:digest(source),description:'Retain position',clock:'preserve'},program:source.program+'\nfunction migrate(previous){return previous.state;}'};
  const snapshot={...initial.snapshot,state:{x:72,held:true,drag:true},tick:42};
  const result=await trialMiniApp(plan,{migration:{sourcePlan:source,snapshot}});
  assert.deepEqual(result.snapshot.state,{x:72,held:false,drag:false});assert.equal(result.snapshot.tick,42);assert.deepEqual(snapshot.state,{x:72,held:true,drag:true});
});

test('the prior camera remains host data and is not transferred to the new scene',async()=>{
  const source=miniAppSceneExample(),initial=await trialMiniApp(source),id=source.viewports[0].id,scene=initial.frame.scenes[id];
  const snapshot={...initial.snapshot,view:{version:1,cameras:{[id]:{reset:scene.cameraRevision??0,camera:scene.camera}}}};
  const plan={...source,migration:{fromPlanDigest:digest(source),description:'Keep task state, reset camera',clock:'preserve'},program:source.program+'\nfunction migrate(previous){if(previous.view!==undefined)throw new Error("host view leaked");return previous.state;}'};
  const result=await trialMiniApp(plan,{migration:{sourcePlan:source,snapshot}});assert.equal(result.snapshot.view,undefined);assert.deepEqual(result.snapshot.state,initial.snapshot.state);
});

test('source mutation, invalid transferred state and infinite loops are rejected inside the migration worker',async()=>{
  const source=counterPlan(),{snapshot}=await trialMiniApp(source);
  const programs=[
    ['function migrate(previous){previous.state.count=9;return previous.state;}',undefined],
    ['function migrate(){return {count:"bad"};}',undefined],
    ['function migrate(){while(true){} return {count:1};}','TIME_LIMIT'],
  ];
  for(const [migration,code] of programs){
    const plan={...progressPlan(),program:source.program+'\n'+migration};
    await assert.rejects(trialMiniApp(plan,{migration:{sourcePlan:source,snapshot}}),e=>!code||e.code===code);
  }
});

test('ordinary VMs cannot request migration; an enabled VM consumes its startup allowance once',async()=>{
  const wasm=new Uint8Array(await readFile(require.resolve('quickjs-wasi/quickjs.wasm'))),plan=progressPlan();
  const previous={inputs:{start:7},state:{count:19},tick:13,rng:12345},request={command:'migrate',snapshot:{inputs:{start:8},state:null,tick:13,rng:12345},previous};
  const ordinary=await MiniAppVm.create(wasm,plan.program),enabled=await MiniAppVm.create(wasm,plan.program,undefined,true);
  try{assert.throws(()=>ordinary.run(request),/server-owned/);assert.equal(enabled.run(request).snapshot.state.count,20);assert.throws(()=>enabled.run(request),/server-owned/);}finally{ordinary.dispose();enabled.dispose();}
});

test('explicit host choice preserves progress and an omitted choice still resets',async t=>{
  for(const progress of ['migrate','reset'])await t.test(progress,async st=>{
    const f=await migrationFixture(st,{next:progressPlan()}),review=await f.review();assert.equal(review.progress.clock,'preserve');
    const input={...await f.choice(),inputs:{start:8},...(progress==='migrate'?{progress}:{} )};
    const response=await f.post(input);assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
    const saved=await f.read();assert.equal(saved.result.snapshot.state.count,progress==='migrate'?20:8);assert.equal(saved.result.snapshot.tick,progress==='migrate'?13:0);
    assert.equal((await f.read('old')).result.snapshot.state.count,19);
    assert.deepEqual(await(await f.post(input)).json(),{status:'committed'});
  });
});

test('a failed progress transformation cannot publish, and fresh initialization remains an explicit alternative',async t=>{
  const next=progressPlan();next.program=counterPlan().program+'\nfunction migrate(){throw new Error("cannot migrate");}';
  const f=await migrationFixture(t,{next}),input=await f.choice();
  assert.equal((await f.post({...input,progress:'migrate'})).status,400);assert.equal(f.journal().records[1].migration,undefined);assert.equal((await f.read('old')).writable,true);
  assert.equal((await f.post(input)).status,200);assert.equal((await f.read()).result.snapshot.state.count,7);
});
