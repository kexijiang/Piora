import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { prepareMiniAppRuntime } from '../scripts/prepare-mini-app-runtime.mjs';
const jiti=createJiti(import.meta.url);
const { miniAppAuthoringExample }=await jiti.import('./mini-app/authoring-example.ts');
const { miniAppRepeatExample }=await jiti.import('./mini-app/repeat-example.ts');
const { miniAppSceneExample }=await jiti.import('./mini-app/scene-example.ts');
const { MINI_APP_CAPABILITIES }=await jiti.import('./mini-app/capability-manifest.ts');
const { miniAppPlanSchema }=await jiti.import('./mini-app/plan-schema.ts');
const { miniAppDecisionPrompt, miniAppEnvironmentContext }=await jiti.import('./mini-app/decision-policy.ts');
const { compileMiniAppPlan }=await jiti.import('./mini-app/plan.ts');
const { originalMiniAppPlanDiagnostic }=await jiti.import('./mini-app/plan-admission.ts');
const { trialMiniApp }=await jiti.import('./mini-app/server-trial.ts');
const { miniAppDiagnostic }=await jiti.import('./mini-app/diagnostic.ts');

test('field-local program guidance permits literal module constants and local arithmetic without weakening module isolation',async()=>{
  await prepareMiniAppRuntime();const plan=miniAppSceneExample();
  const original=plan.program;plan.program='const DEG=Math.PI/180;'+original;
  const issue=originalMiniAppPlanDiagnostic(plan);assert.equal(issue.code,'SYNTAX');assert.equal(issue.path,'program');assert.match(issue.message,/inside functions/);
  assert.match(miniAppPlanSchema.properties.program.description,/const DEG=Math.PI\/180 is not/);
  for(const program of ['const DEG=0.017453292519943295;'+original,original.replace('function project(state,inputs,ctx){','function project(state,inputs,ctx){const DEG=Math.PI/180;')]){
    plan.program=program.replaceAll('Math.PI/180]', 'DEG]');plan.inputs[0].value=90;
    const result=await trialMiniApp(plan);assert.ok(Math.abs(result.frame.scenes.airspace.meshes[0].rotation[0]-Math.PI/2)<1e-12);
  }
  for(const declaration of ['const shared={x:1};','const shared=[];','const random=Math.random();','let shared=1;'])assert.throws(()=>compileMiniAppPlan({...plan,program:declaration+original}),error=>error.code==='SYNTAX');
});

test('field-local responsive CSS examples match both compiler endpoints and retain unsupported-query rejection',()=>{
  const plan=miniAppAuthoringExample();assert.match(miniAppPlanSchema.properties.document.properties.css.description,/200 through 1999/);
  for(const width of [200,640,1999])assert.doesNotThrow(()=>compileMiniAppPlan({...plan,document:{...plan.document,css:`p{color:var(--text)}@media (max-width:${width}px){p{margin:0}}`}}));
  for(const query of ['(min-width:640px)','(max-width:199px)','(max-width:2000px)','(max-width:640px) and (orientation:portrait)']){
    const broken={...plan,document:{...plan.document,css:`@media ${query}{p{margin:0}}`}};
    const issue=originalMiniAppPlanDiagnostic(broken);assert.equal(issue.code,'SCHEMA');assert.equal(issue.path,'document/css');assert.match(issue.message,/default layout outside/);
  }
});

test('unknown fields retain precise paths and bounded repair directions without echoing field values',()=>{
  const plan={...miniAppAuthoringExample(),invented_container:'private generated content'};
  let caught;try{compileMiniAppPlan(plan);}catch(error){caught=error;}
  const issue=miniAppDiagnostic(caught,{});assert.equal(issue.path,'plan/invented_container');assert.equal(issue.repairable,true);
  assert.match(issue.message,/Allowed keys.*viewports/);assert.doesNotMatch(issue.message,/private generated content/);assert.ok(issue.message.length<=600);
  delete plan.invented_container;assert.doesNotThrow(()=>compileMiniAppPlan(plan));
});

test('the per-turn submission check is capability-gated and applies beyond spatial tasks',()=>{
  const snapshot={manifestVersion:1,development:false,capabilities:MINI_APP_CAPABILITIES.map(cap=>({id:cap.id,version:cap.version,status:'verified',available:cap.id==='document',reason:'Prompt-shape fixture'}))};
  assert.match(miniAppEnvironmentContext(snapshot),/Before calling piora_render_mini_app/);assert.doesNotMatch(miniAppEnvironmentContext(snapshot),/Executable spatial-interaction/);
  snapshot.capabilities.forEach(cap=>cap.available=false);assert.doesNotMatch(miniAppEnvironmentContext(snapshot),/Before calling piora_render_mini_app/);
});

test('the exact complete prompt example passes transport, compiler and server VM, including restored terminal projection',async()=>{
  await prepareMiniAppRuntime();
  const plan=miniAppAuthoringExample();
  assert.deepEqual(validateToolArguments({name:'piora_render_mini_app',parameters:miniAppPlanSchema},{id:'example',name:'piora_render_mini_app',arguments:structuredClone(plan)}),plan);
  assert.ok(miniAppDecisionPrompt().promptGuidelines.some(line=>line.includes(JSON.stringify(plan))));
  assert.equal(compileMiniAppPlan(plan).runtimeVersion,'mini-app-1.2');
  const initial=await trialMiniApp(plan);
  assert.deepEqual(initial.snapshot.state,{count:0,phase:'active'});
  const restored=await trialMiniApp(plan,{snapshot:{...initial.snapshot,state:{count:6,phase:'complete'},tick:6}});
  assert.equal(restored.frame.playback.finished,true);
  assert.match(restored.frame.summary,/Count: 6; complete/);
});

test('the editable-list prompt example passes transport, compilation and server projection',async()=>{
  await prepareMiniAppRuntime();const plan=miniAppRepeatExample();
  assert.deepEqual(validateToolArguments({name:'piora_render_mini_app',parameters:miniAppPlanSchema},{id:'rows-example',name:'piora_render_mini_app',arguments:structuredClone(plan)}),plan);
  assert.ok(miniAppDecisionPrompt().promptGuidelines.some(line=>line.includes(JSON.stringify(plan))));
  assert.equal(compileMiniAppPlan(plan).runtimeVersion,'mini-app-1.3');
  const result=await trialMiniApp(plan);assert.equal(result.frame.repeats.tasks.length,3);
  assert.deepEqual((await trialMiniApp(plan,{snapshot:result.snapshot})),result);
});

test('spatial example matches tool transport and server restoration; guidance is conditional on real capability availability',async()=>{
  await prepareMiniAppRuntime();const plan=miniAppSceneExample();
  assert.deepEqual(validateToolArguments({name:'piora_render_mini_app',parameters:miniAppPlanSchema},{id:'scene-example',name:'piora_render_mini_app',arguments:structuredClone(plan)}),plan);
  assert.equal(compileMiniAppPlan(plan).runtimeVersion,'mini-app-1.4');
  const result=await trialMiniApp(plan),snapshot=structuredClone(result.snapshot);
  snapshot.inputs.pitch=90;snapshot.state.selected='aircraft';snapshot.view={version:1,cameras:{airspace:{reset:0,camera:{position:[6,5,4],target:[0,0,0],fov:45}}}};
  const restored=await trialMiniApp(plan,{snapshot});assert.deepEqual(restored.snapshot,snapshot);assert.equal(restored.frame.scenes.airspace.selected,'aircraft');
  assert.ok(!miniAppDecisionPrompt().promptGuidelines.some(line=>line.includes(JSON.stringify(plan))),'Host has no negotiated WebGL environment yet');
  const snapshotFixture={manifestVersion:1,development:false,capabilities:MINI_APP_CAPABILITIES.map(cap=>({id:cap.id,version:cap.version,status:cap.implementation==='planned'?'planned':'verified',available:cap.implementation!=='planned',reason:'Explicit prompt-shape fixture, not a runtime grant'}))};
  snapshotFixture.capabilities.find(cap=>cap.id==='sceneGroups').available=false;
  const prompt=miniAppDecisionPrompt(snapshotFixture);assert.ok(prompt.promptGuidelines.some(line=>line.includes(JSON.stringify(plan))));assert.ok(prompt.promptGuidelines.some(line=>line.includes("type:'scene-pick'")));
});

test('independent plan errors are returned together with the exact complete-resubmission contract',()=>{
  const plan=miniAppAuthoringExample();delete plan.purpose;
  delete plan.stateSchema.properties.phase.maxLength;
  plan.program='var shared=3;'+plan.program;
  plan.document.css='p{font-family:unavailable}';
  const diagnostic=originalMiniAppPlanDiagnostic(plan);
  assert.equal(diagnostic.repairable,true);
  for(const path of ['purpose','stateSchema/properties/phase','program','document/css/font-family'])
    assert.ok(diagnostic.issues.some(issue=>issue.path===path),path);
  assert.equal(diagnostic.contract.tool,'piora_render_mini_app');
  assert.equal(diagnostic.contract.planVersion,1);
  assert.match(diagnostic.contract.resubmit,/complete.*purpose/);
  assert.ok(diagnostic.issues.length<=8);
  assert.equal(originalMiniAppPlanDiagnostic(miniAppAuthoringExample()),undefined);
});

test('bounded diagnostics do not hide nonrepairable limits or coerce invalid original fields',()=>{
  const plan=miniAppAuthoringExample();
  for(const key of ['id','title','purpose','assumptions','initialSnapshot','stateSchema','inputs','viewports'])plan[key]=null;
  plan.program=' '.repeat(64*1024+1);
  const issue=originalMiniAppPlanDiagnostic(plan);
  assert.equal(issue.repairable,true); // The original string field limit is a correctable schema error.
  assert.equal(issue.issues.length,8);
  const huge={...miniAppAuthoringExample(),program:'汉'.repeat(64000)};
  assert.equal(originalMiniAppPlanDiagnostic(huge).repairable,false);
});
