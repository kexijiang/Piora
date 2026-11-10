import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
import { prepareMiniAppRuntime } from '../scripts/prepare-mini-app-runtime.mjs';
const jiti=createJiti(import.meta.url);
const {miniAppSceneGroupsExample}=await jiti.import('./mini-app/scene-groups-example.ts');
const {miniAppSceneExample}=await jiti.import('./mini-app/scene-example.ts');
const {compileMiniAppPlan}=await jiti.import('./mini-app/plan.ts');
const {validateMiniAppFrame}=await jiti.import('./mini-app/frame.ts');
const {requiredMiniAppCapabilities,assertMiniAppCapabilities}=await jiti.import('./mini-app/capabilities.ts');
const {trialMiniApp}=await jiti.import('./mini-app/server-trial.ts');
const {miniAppDecisionPrompt,miniAppEnvironmentContext}=await jiti.import('./mini-app/decision-policy.ts');
const {MINI_APP_CAPABILITIES}=await jiti.import('./mini-app/capability-manifest.ts');
await prepareMiniAppRuntime();
const plan=miniAppSceneGroupsExample(),compiled=compileMiniAppPlan(plan),initial=await trialMiniApp(plan);
const validate=frame=>validateMiniAppFrame(frame,compiled.document,compiled.plan.viewports);
const group=(id,parent)=>({id,...(parent?{parent}:{}),position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]});

test('group opt-in selects a new runtime and admission capability without changing previous scene identities',()=>{
  assert.equal(compiled.runtimeVersion,'mini-app-1.5');assert.equal(compileMiniAppPlan(miniAppSceneExample()).runtimeVersion,'mini-app-1.4');
  assert.ok(requiredMiniAppCapabilities(compiled).includes('sceneGroups'));
  const snapshot={capabilities:requiredMiniAppCapabilities(compiled).map(id=>({id,available:id!=='sceneGroups'}))};
  assert.throws(()=>assertMiniAppCapabilities(compiled,snapshot),error=>error.path==='capabilities/sceneGroups');
  for(const changes of [{groups:false},{groups:'true'},{kind:'canvas2d'}]){
    const bad=structuredClone(plan);Object.assign(bad.viewports[0],changes);assert.throws(()=>compileMiniAppPlan(bad));
  }
  const old=structuredClone(compiled.plan.viewports);delete old[0].groups;
  assert.throws(()=>validateMiniAppFrame(initial.frame,compiled.document,old),error=>error.path==='frame/scenes/assembly/groups');
});

test('the executable grouped example survives real selection probes and historical restoration without altering publication state',async()=>{
  assert.deepEqual(initial.snapshot.state,{selected:'',cameraRevision:0});
  assert.equal(initial.frame.scenes.assembly.meshes.find(mesh=>mesh.id==='tip').parent,'joint');
  const snapshot=structuredClone(initial.snapshot);snapshot.inputs.bodyAngle=90;snapshot.inputs.jointAngle=90;
  const restored=await trialMiniApp(plan,{snapshot});
  assert.deepEqual(restored.snapshot,snapshot);
  assert.deepEqual(restored.frame.scenes.assembly.groups.map(group=>group.rotation),[[0,0,Math.PI/2],[0,0,Math.PI/2]]);
});

test('group graphs reject cycles, missing parents, aliases and unbounded transform data',()=>{
  for(const mutate of [
    s=>s.groups[0].parent='root',s=>s.groups[0].parent='joint',s=>s.groups[1].parent='missing',
    s=>s.groups.push(group('root')),s=>s.meshes[0].id='root',s=>s.meshes[0].parent='body',
    s=>s.groups[0].scale[0]=0,s=>s.groups[0].rotation[1]=Infinity,s=>s.groups[0].position=[0,0],
    s=>s.groups[0].matrix=Array(16).fill(1),
  ]){const frame=structuredClone(initial.frame);mutate(frame.scenes.assembly);assert.throws(()=>validate(frame));}
  const frame=structuredClone(initial.frame);frame.scenes.assembly.groups.reverse();
  assert.deepEqual(validate(frame),frame,'forward parent references do not depend on declaration order');
});

test('group nesting and the total frame budget have distinct bounded limits',()=>{
  const frame=structuredClone(initial.frame),scene=frame.scenes.assembly;
  scene.groups=Array.from({length:8},(_,i)=>group(`g${i}`,i?`g${i-1}`:undefined));
  for(const mesh of scene.meshes)mesh.parent='g7';assert.doesNotThrow(()=>validate(frame));
  scene.groups.push(group('g8','g7'));assert.throws(()=>validate(frame),error=>/8 levels/.test(error.message));
  scene.groups=Array.from({length:64},(_,i)=>group(`g${i}`));assert.doesNotThrow(()=>validate(frame));
  scene.groups.push(group('g64'));assert.throws(()=>validate(frame),error=>/64/.test(error.message));
  scene.groups.pop();frame.scenes.second={...structuredClone(scene),groups:[group('g7')]};
  assert.throws(()=>validateMiniAppFrame(frame,compiled.document,[...compiled.plan.viewports,{...compiled.plan.viewports[0],id:'second'}]),error=>error.code==='LIMIT'&&/across scenes/.test(error.message));
});

test('a removed group cannot leave a dangling mesh, while an explicit root reparent keeps mesh identity',()=>{
  const frame=structuredClone(initial.frame);delete frame.scenes.assembly.groups;
  assert.throws(()=>validate(frame),error=>/parent/.test(error.path));
  for(const mesh of frame.scenes.assembly.meshes)delete mesh.parent;
  assert.deepEqual(validate(frame).scenes.assembly.meshes.map(mesh=>mesh.id),['body','arm','tip']);
});

test('current-window guidance exposes the hierarchy example only with the same admitted capability',()=>{
  const snapshot={manifestVersion:1,development:false,capabilities:MINI_APP_CAPABILITIES.map(cap=>({id:cap.id,available:cap.implementation==='implemented',status:cap.implementation}))};
  assert.ok(miniAppEnvironmentContext(snapshot).includes(JSON.stringify(plan)));
  assert.ok(miniAppDecisionPrompt(snapshot).promptGuidelines.some(line=>line.includes('64 groups')));
  snapshot.capabilities.find(cap=>cap.id==='sceneGroups').available=false;
  assert.ok(!miniAppEnvironmentContext(snapshot).includes(JSON.stringify(plan)));
  assert.ok(miniAppEnvironmentContext(snapshot).includes(JSON.stringify(miniAppSceneExample())));
});
