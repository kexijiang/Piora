import assert from 'node:assert/strict';
import test from 'node:test';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createJiti} from 'jiti';
import {counterPlan,heldInputPlan} from './mini-app-fixtures.mjs';
const jiti=createJiti(import.meta.url);
const {MINI_APP_CAPABILITIES}=await jiti.import('./mini-app/capability-manifest.ts');
const {evaluateMiniAppCapabilities,requiredMiniAppCapabilities,assertMiniAppCapabilities}=await jiti.import('./mini-app/capabilities.ts');
const {miniAppDevelopmentCapabilities}=await jiti.import('./mini-app/capability-host.ts');
const {miniAppDecisionPrompt}=await jiti.import('./mini-app/decision-policy.ts');
const {compileMiniAppPlan}=await jiti.import('./mini-app/plan.ts');
const sources=Object.fromEntries(MINI_APP_CAPABILITIES[0].sources.map(file=>[file,'a'.repeat(64)]));
const environment={platform:'win32',wasm:true,webgl:false,development:false};
const evidence=()=>({manifestVersion:1,entries:MINI_APP_CAPABILITIES.filter(cap=>cap.implementation==='implemented'&&cap.id!=='scene3d').map(cap=>({id:cap.id,version:cap.version,result:'passed',platform:'win32',scope:'Deterministic browser/SDK fixtures, not task semantics',checks:['fixture'],sources:{...sources}}))});
const snapshot=(proof=evidence(),digests=sources,env=environment)=>evaluateMiniAppCapabilities(proof,digests,env);

test('current evidence permits implemented capabilities, while stale inputs, version and platform revoke admission',()=>{
  assert.doesNotThrow(()=>assertMiniAppCapabilities(compileMiniAppPlan(heldInputPlan()),snapshot()));
  const stale={...sources,[MINI_APP_CAPABILITIES[0].sources[0]]:'b'.repeat(64)};
  assert.throws(()=>assertMiniAppCapabilities(compileMiniAppPlan(counterPlan()),snapshot(evidence(),stale)),error=>error.code==='CAPABILITY_UNAVAILABLE'&&!error.repairable);
  const wrong=evidence();wrong.entries[0].version=2;
  assert.equal(snapshot(wrong).capabilities.find(cap=>cap.id==='document').available,false);
  assert.equal(snapshot(evidence(),sources,{...environment,platform:'darwin'}).capabilities.some(cap=>cap.available),false);
  assert.equal(evaluateMiniAppCapabilities(undefined,sources,environment).capabilities.some(cap=>cap.available),false);
});
test('development allows testing implemented capabilities without inventing verification evidence',()=>{
  const dev=evaluateMiniAppCapabilities(undefined,sources,{...environment,development:true});
  assert.equal(dev.capabilities.find(cap=>cap.id==='document').status,'implemented');
  assert.equal(dev.capabilities.find(cap=>cap.id==='document').available,true);
  assert.equal(dev.capabilities.find(cap=>cap.id==='scene3d').available,false,'Unconfirmed WebGL remains unavailable');
  assert.equal(dev.capabilities.find(cap=>cap.id==='registeredActions').available,true);
  assert.equal(dev.capabilities.find(cap=>cap.id==='registeredActions').status,'implemented');
  const absent=evidence();absent.entries=absent.entries.filter(cap=>cap.id!=='registeredActions');
  assert.equal(snapshot(absent).capabilities.find(cap=>cap.id==='registeredActions').available,false);
  assert.equal(miniAppDevelopmentCapabilities({PIORA_MINI_APP_CAPABILITIES:'development'}),false);
  assert.equal(miniAppDevelopmentCapabilities({PIORA_MINI_APP_CAPABILITIES:'development',PI_CODING_AGENT_DIR:join(homedir(),'.pi','agent')}),false);
  assert.equal(miniAppDevelopmentCapabilities({NODE_ENV:'production',PIORA_MINI_APP_CAPABILITIES:'development',PI_CODING_AGENT_DIR:join(homedir(),'isolated')}),false);
  assert.equal(miniAppDevelopmentCapabilities({NODE_ENV:'development',PIORA_MINI_APP_CAPABILITIES:'development',PI_CODING_AGENT_DIR:join(homedir(),'isolated')}),true);
});
test('requirements come from compiled structure; unavailable new actions do not block historical parsing',()=>{
  assert.deepEqual(new Set(requiredMiniAppCapabilities(compileMiniAppPlan(heldInputPlan()))),new Set(['document','events','playback','svg']));
  const plan=counterPlan();plan.actions={version:1,actions:[{id:'save',label:'Save',path:'result.json',kind:'save_snapshot',format:'json'}]};
  const historical=compileMiniAppPlan(plan);
  assert.ok(historical.plan.actions,'Existing plans remain readable');
  assert.equal(historical.runtimeVersion,'mini-app-1.8');
  assert.doesNotThrow(()=>assertMiniAppCapabilities(historical,snapshot()));
  const missing=evidence();missing.entries=missing.entries.filter(cap=>cap.id!=='registeredActions');
  assert.throws(()=>assertMiniAppCapabilities(historical,snapshot(missing)),error=>error.code==='CAPABILITY_UNAVAILABLE'&&error.path==='capabilities/registeredActions');
  assert.ok(miniAppDecisionPrompt(snapshot()).promptGuidelines.some(line=>line.startsWith('Registered actions:')));
  assert.ok(!miniAppDecisionPrompt(snapshot(missing)).promptGuidelines.some(line=>line.startsWith('Registered actions:')));
});
test('model-visible capabilities and actual acceptance share the same availability snapshot',()=>{
  const available=snapshot(),prompt=miniAppDecisionPrompt(available);
  assert.match(prompt.description,/Canvas 2D/);assert.doesNotMatch(prompt.description,/3D scenes/);
  assert.ok(!prompt.promptGuidelines.some(line=>line.startsWith('A scene is')));
  const plan=counterPlan();plan.viewports=[{id:'view',kind:'scene3d',label:'Scene',width:200,height:200}];plan.document.html+='<div data-viewport="view"></div>';
  assert.throws(()=>assertMiniAppCapabilities(compileMiniAppPlan(plan),available),error=>error.path==='capabilities/scene3d');
  const denied=miniAppDecisionPrompt(evaluateMiniAppCapabilities(undefined,sources,environment));
  assert.match(denied.promptSnippet,/unavailable/);
  assert.ok(!denied.promptGuidelines.some(line=>line.startsWith('Complete valid JSON arguments')));
});

test('cross-form conversion is versioned and requires its own current evidence',()=>{
  const plan=counterPlan();plan.conversion={fromKind:'intelligent-ui',fromToolCallId:'old',fromDigest:'a'.repeat(64),description:'Switch forms; restart progress'};
  const compiled=compileMiniAppPlan(plan);assert.equal(compiled.runtimeVersion,'mini-app-1.9');
  assert.ok(requiredMiniAppCapabilities(compiled).includes('outputConversion'));assert.doesNotThrow(()=>assertMiniAppCapabilities(compiled,snapshot()));
  const missing=evidence();missing.entries=missing.entries.filter(cap=>cap.id!=='outputConversion');
  assert.throws(()=>assertMiniAppCapabilities(compiled,snapshot(missing)),e=>e.code==='CAPABILITY_UNAVAILABLE'&&e.path==='capabilities/outputConversion');
  assert.ok(miniAppDecisionPrompt(snapshot()).promptGuidelines.some(line=>line.startsWith('Changing an existing answer')));
  assert.ok(!miniAppDecisionPrompt(snapshot(missing)).promptGuidelines.some(line=>line.startsWith('Changing an existing answer')));
});
