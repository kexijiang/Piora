import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url);
const {miniAppSceneExample}=await jiti.import('./mini-app/scene-example.ts');
const {compileMiniAppPlan,validateMiniAppResult,validateMiniAppCheckpoint}=await jiti.import('./mini-app/plan.ts');
const {validateMiniAppFrame}=await jiti.import('./mini-app/frame.ts');
const {miniAppEventRequest}=await jiti.import('./mini-app/events.ts');
const {MiniAppSceneIdentity,miniAppSceneContext}=await jiti.import('./mini-app/scene-state.ts');
const {MiniAppVm}=await jiti.import('./mini-app/vm.ts');
const {requiredMiniAppCapabilities}=await jiti.import('./mini-app/capabilities.ts');
const wasm=readFileSync(createRequire(import.meta.url).resolve('quickjs-wasi/quickjs.wasm'));
const camera={position:[6,5,4],target:[0,0,0],fov:50};
async function fixture(t){const compiled=compileMiniAppPlan(miniAppSceneExample()),vm=await MiniAppVm.create(wasm,compiled.plan.program);t.after(()=>vm.dispose());const first=validateMiniAppResult(compiled,vm.run({command:'init',snapshot:{inputs:compiled.initialInputs,state:null,tick:0,rng:11}}));return {compiled,vm,first};}

test('spatial interaction opt-ins are finite, require scene capabilities and preserve legacy runtime identity',()=>{
  const plan=miniAppSceneExample(),compiled=compileMiniAppPlan(plan);
  assert.equal(compiled.runtimeVersion,'mini-app-1.4');assert.deepEqual(requiredMiniAppCapabilities(compiled),['document','events','scene3d','scenePicking','cameraControls']);
  delete plan.viewports[0].picking;delete plan.viewports[0].cameraControls;
  assert.equal(compileMiniAppPlan(plan).runtimeVersion,'mini-app-1.1');
  for(const change of [{kind:'canvas2d',picking:true},{picking:false},{cameraControls:'orbit'}]){const bad=miniAppSceneExample();Object.assign(bad.viewports[0],change);assert.throws(()=>compileMiniAppPlan(bad));}
});

test('scene labels, selection and camera reset contracts reject incoherent frames',async t=>{
  const {compiled,first}=await fixture(t);
  for(const modify of [s=>delete s.meshes[0].label,s=>s.selected='missing',s=>delete s.selected,s=>s.cameraRevision=-1,s=>s.camera.position=[0,0,0]]){
    const frame=structuredClone(first.frame);modify(frame.scenes.airspace);assert.throws(()=>validateMiniAppFrame(frame,compiled.document,compiled.plan.viewports));
  }
});

test('camera checkpoints remain separate from task inputs, survive VM projection and reset only on explicit revision',async t=>{
  const {compiled,vm,first}=await fixture(t),snapshot=structuredClone(first.snapshot);
  snapshot.view={version:1,cameras:{airspace:{reset:0,camera}}};
  const projected=validateMiniAppResult(compiled,vm.run({command:'project',snapshot}));
  assert.deepEqual(projected.snapshot.view,snapshot.view);assert.deepEqual(projected.snapshot.state,first.snapshot.state);
  const rotated=validateMiniAppResult(compiled,vm.run(miniAppEventRequest(compiled,projected.snapshot,{type:'input',id:'pitch',value:90},projected.frame)));
  assert.deepEqual(rotated.snapshot.view,snapshot.view);assert.deepEqual(rotated.frame.scenes.airspace.meshes[0].rotation,[Math.PI/2,0,0]);
  // Independent single-axis geometry: a nose on -Z moves to +Y at +90deg X.
  const [rx]=rotated.frame.scenes.airspace.meshes[0].rotation;assert.ok(Math.abs(2*Math.sin(rx)-2)<1e-9);assert.ok(Math.abs(-2*Math.cos(rx))<1e-9);
  const reset=validateMiniAppResult(compiled,vm.run(miniAppEventRequest(compiled,rotated.snapshot,{type:'click',id:'cameraReset'},rotated.frame)));
  assert.deepEqual(reset.snapshot.view,{version:1,cameras:{}});assert.equal(reset.frame.scenes.airspace.cameraRevision,1);
  const invalid=structuredClone(snapshot);invalid.view.cameras.airspace.camera.position[0]=Infinity;assert.throws(()=>validateMiniAppCheckpoint(compiled,invalid));
  const undeclared=structuredClone(snapshot);undeclared.view.cameras.other=undeclared.view.cameras.airspace;assert.throws(()=>validateMiniAppCheckpoint(compiled,undeclared));
});

test('picking rejects deleted/reused object identities, expired frames and unknown viewports',async t=>{
  const {compiled,vm,first}=await fixture(t),identity=new MiniAppSceneIdentity();
  const revision=identity.publish(first.frame.scenes),event={type:'scene-pick',id:'airspace',object:'aircraft',frame:revision};
  identity.validate(event);const request=miniAppEventRequest(compiled,first.snapshot,event,first.frame);
  assert.deepEqual(request.event,{type:'scene-pick',id:'airspace',object:'aircraft'});
  const result=validateMiniAppResult(compiled,vm.run(request));assert.equal(result.snapshot.state.selected,'aircraft');
  const deleted=structuredClone(first.frame.scenes);deleted.airspace.meshes=deleted.airspace.meshes.filter(x=>x.id!=='aircraft');identity.publish(deleted);identity.publish(first.frame.scenes);
  assert.throws(()=>identity.validate(event),e=>e.code==='STALE_EVENT');
  assert.throws(()=>miniAppEventRequest(compiled,first.snapshot,{...event,id:'other'},first.frame));
  const fresh={...event,frame:identity.publish(first.frame.scenes)};for(let i=0;i<33;i++)identity.publish(first.frame.scenes);assert.throws(()=>identity.validate(fresh),e=>e.code==='STALE_EVENT');
});

test('saved scene context exposes selected object and saved observation camera without claiming it is task geometry',async t=>{
  const {first}=await fixture(t);first.frame.scenes.airspace.selected='aircraft';
  const context=miniAppSceneContext(first.frame,{version:1,cameras:{airspace:{reset:0,camera}}});
  assert.deepEqual(context[0].selected,{id:'aircraft',label:'飞机'});assert.deepEqual(context[0].camera,camera);assert.equal(context[0].cameraSource,'saved-user-view');
  assert.equal(miniAppSceneContext({summary:'none',bindings:{}},undefined),undefined);
});
