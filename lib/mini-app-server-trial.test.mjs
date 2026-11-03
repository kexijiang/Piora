import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
import { counterPlan, discreteCounterPlan } from './mini-app-fixtures.mjs';
import { prepareMiniAppRuntime } from '../scripts/prepare-mini-app-runtime.mjs';
const {trialMiniApp}=await createJiti(import.meta.url).import('./mini-app/server-trial.ts');
const {miniAppSceneExample}=await createJiti(import.meta.url).import('./mini-app/scene-example.ts');
const {miniAppScenePickTrials}=await createJiti(import.meta.url).import('./mini-app/interaction-trial.ts');
await prepareMiniAppRuntime();

test('new scene trials exercise emitted part IDs before publishing and retain the untouched initial checkpoint',async()=>{
  const plan=miniAppSceneExample(),initial=await trialMiniApp(plan);
  assert.equal(initial.frame.scenes.airspace.selected,null);assert.equal(initial.snapshot.state.selected,'');assert.equal(initial.snapshot.tick,0);
  const broken={...plan,program:plan.program.replaceAll('"aircraft"','"body-part"')};
  await assert.rejects(trialMiniApp(broken),error=>error.code==='STATE'&&error.path==='state/selected'&&error.repairable&&/Trial scene selection airspace\/body-part/.test(error.message));
  const historical=await trialMiniApp(broken,{snapshot:initial.snapshot});
  assert.deepEqual(historical.snapshot,initial.snapshot);assert.equal(historical.frame.scenes.airspace.meshes[0].id,'body-part','historical reads do not retroactively run new event probes');
});

test('scene event sampling stays bounded and covers clear plus late IDs for each opted-in view',()=>{
  const viewports=[{id:'first',picking:true},{id:'second',picking:true},{id:'third',picking:true},{id:'static'}];
  const scenes=Object.fromEntries(viewports.map(view=>[view.id,{meshes:Array.from({length:200},(_,i)=>({id:`part${i}`}))}]));
  const probes=miniAppScenePickTrials({plan:{viewports}},{frame:{scenes}});
  assert.equal(probes.length,32);assert.equal(new Set(probes.map(probe=>`${probe.id}/${probe.object}`)).size,32);
  for(const id of ['first','second','third']){
    assert.ok(probes.some(probe=>probe.id===id&&probe.object===null));assert.ok(probes.some(probe=>probe.id===id&&probe.object==='part199'));
  }
  assert.ok(!probes.some(probe=>probe.id==='static'));
  assert.deepEqual(miniAppScenePickTrials({plan:{viewports:[]}},{frame:{}}),[]);
});

test('selection execution limits keep their nonrepairable diagnosis instead of blaming the state schema',async()=>{
  const plan=miniAppSceneExample();
  plan.program=plan.program.replace('function reduce(', 'function originalReduce(')
    +'\nfunction reduce(state,event,ctx){if(event.type==="scene-pick"){while(true){}}return originalReduce(state,event,ctx);}';
  await assert.rejects(trialMiniApp(plan),error=>error.code==='TIME_LIMIT'&&!error.repairable
    &&/Trial scene selection/.test(error.message)&&!/Selection state must/.test(error.message));
});

test('new discrete programs validate later reachable states, while historical checkpoint reads do not advance them', async () => {
  const plan = discreteCounterPlan();
  plan.stateSchema.properties.count.maximum = 4;
  // Initial 2 and first step 3 are valid; the third step reaches 5 and violates
  // the declared range. This is the same class of failure as a too-small swap counter.
  await assert.rejects(trialMiniApp(plan), error => error.code === 'STATE' && error.path === 'state/count' && error.repairable);
  const saved = { inputs: { start: 2 }, state: { count: 3 }, rng: 123, tick: 1 };
  assert.deepEqual((await trialMiniApp(plan, { snapshot: saved })).snapshot, saved);
});

test('trial executes the declared discrete reducer, skips event-only advance and validates completion',async()=>{
  const plan=discreteCounterPlan();
  const initial=await trialMiniApp(plan);
  assert.equal(initial.snapshot.tick,0);assert.equal(initial.snapshot.state.count,2);
  const broken={...plan,program:plan.program.replace("event.type==='click'?state.count+1", "event.type==='click'?10001")};
  await assert.rejects(trialMiniApp(broken),e=>e.code==='STATE','Trial must exercise the actual discrete step, not an unrelated advance function');
  const none={...plan,playback:{mode:'none'}};
  assert.equal((await trialMiniApp(none)).snapshot.state.count,2,'Event-only tools do not run a nonexistent time transition');
  const missing={...plan,program:plan.program.replace(',playback:{finished:state.count>=5}','')};
  await assert.rejects(trialMiniApp(missing),e=>e.code==='FRAME'&&e.path==='frame/playback');
});

test('server trial uses the real bundled worker, validates init and step, and returns only the initial checkpoint',async()=>{
  const result=await trialMiniApp(counterPlan());
  assert.equal(result.snapshot.state.count,2);assert.equal(result.snapshot.tick,0);assert.equal(result.frame.summary,'Count: 2');
  const saved={...result.snapshot,state:{count:70},tick:68};
  const restored=await trialMiniApp(counterPlan(),{snapshot:saved});
  assert.deepEqual(restored.snapshot,saved);assert.equal(restored.frame.bindings.count,70);
  const terminal={...saved,state:{count:10000}};
  assert.deepEqual((await trialMiniApp(counterPlan(),{snapshot:terminal})).snapshot,terminal,'Restoring a valid terminal checkpoint does not force another step');
  const broken=counterPlan();broken.program=broken.program.replace('state.count+1};}\nfunction project','10001};}\nfunction project');
  await assert.rejects(trialMiniApp(broken),error=>error.code==='STATE'&&error.path==='state/count');
});

test('server trial contains loops, forbids host access and honors cancellation without affecting a later trial',async()=>{
  const looping=counterPlan();looping.program=looping.program.replace('return {count:inputs.start};','while(true){}');
  let responsive=false;const hostTimer=setTimeout(()=>{responsive=true;},10);
  await assert.rejects(trialMiniApp(looping),error=>['TIME_LIMIT','WATCHDOG'].includes(error.code));
  assert.equal(responsive,true);clearTimeout(hostTimer);
  const probe=counterPlan();probe.program=probe.program.replace('return {count:inputs.start};',"if(typeof process!=='undefined'||typeof require!=='undefined'||typeof fetch!=='undefined')return {count:-1};return {count:2};");
  assert.equal((await trialMiniApp(probe)).snapshot.state.count,2);
  const abort=new AbortController();const pending=trialMiniApp(looping,{signal:abort.signal});setTimeout(()=>abort.abort(),20);
  await assert.rejects(pending,error=>error.code==='STOPPED');
  assert.equal((await trialMiniApp(counterPlan())).snapshot.state.count,2);
});
