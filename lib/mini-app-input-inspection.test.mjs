import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
import {counterPlan} from './mini-app-fixtures.mjs';
import {prepareMiniAppRuntime} from '../scripts/prepare-mini-app-runtime.mjs';
const jiti=createJiti(import.meta.url);
const {parseMiniAppInspection}=await jiti.import('./mini-app/action-inspection.ts');
const {compactMiniAppInputEvidence}=await jiti.import('./mini-app/input-inspection.ts');
const {previewMiniAppInputs,trialMiniApp}=await jiti.import('./mini-app/server-trial.ts');
await prepareMiniAppRuntime();

test('input inspection accepts a bounded alternative to action IDs and rejects ambiguous or executable requests',()=>{
  const query={appId:'counter',inputCases:[{inputId:'start',value:7}]};assert.deepEqual(parseMiniAppInspection(query),query);
  for(const bad of [{...query,actionIds:['increment']},{appId:'counter'},
    {...query,inputCases:[]},{...query,inputCases:Array(9).fill(query.inputCases[0])},
    ...[NaN,{},[],null,'a'.repeat(513)].map(value=>({...query,inputCases:[{inputId:'start',value}]})),
    {...query,inputCases:[{inputId:'../state',value:2}]},{...query,inputCases:[{inputId:'start',value:2,program:'x'}]}])assert.throws(()=>parseMiniAppInspection(bad));
});

test('each parameter sample runs a real reducer from the same saved progress without changing the source',async()=>{
  const plan=counterPlan();plan.program=plan.program.replace("event.type==='input'?ctx.inputs.start", "event.type==='input'?state.count+ctx.inputs.start");
  const initial=await trialMiniApp(plan),before=JSON.stringify(initial.snapshot);
  const evidence=await previewMiniAppInputs(plan,initial.snapshot,[{inputId:'start',value:7},{inputId:'start',value:8},{inputId:'start',value:2}]);
  assert.equal(evidence.scope,'independent-single-input-events');assert.equal(evidence.omittedCases,0);
  assert.deepEqual(evidence.cases.map(c=>c.projectionText.values.find(v=>v.id==='count').text),['9','10','4']);
  assert.deepEqual(evidence.cases.map(c=>c.changes.items.find(v=>v.path==='/state/count').before),[2,2,2]);
  assert.equal(JSON.stringify(initial.snapshot),before);
  for(const cases of [[{inputId:'unknown',value:2}],[{inputId:'start',value:21}],[{inputId:'start',value:'7'}]])await assert.rejects(previewMiniAppInputs(plan,initial.snapshot,cases));
  const signal=AbortSignal.abort();await assert.rejects(previewMiniAppInputs(plan,initial.snapshot,[{inputId:'start',value:3}],{signal}),e=>e.code==='STOPPED');
  const compact=compactMiniAppInputEvidence(evidence,550);assert.ok(JSON.stringify(compact).length<=550);
  assert.equal(compact.cases.length+compact.omittedCases,3);assert.equal(evidence.cases.length,3);
});
