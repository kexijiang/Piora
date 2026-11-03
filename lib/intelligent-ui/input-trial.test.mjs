import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
import { validateToolArguments } from '@earendil-works/pi-ai';
const jiti=createJiti(import.meta.url);
const { trialUiInputBoundaries,uiInputTrialSamples,UI_INPUT_TRIAL_POLICY }=await jiti.import('./input-trial.ts');
const { compileUiRichPlan }=await jiti.import('./rich-plan.ts');
const { originalUiPlanDiagnostic }=await jiti.import('./plan-admission.ts');
const { uiRichPlanAuthoringExample }=await jiti.import('./authoring-example.ts');
const { uiRichPlanSchema }=await jiti.import('./rich-plan-schema.ts');
const { intelligentUiRichPlanPrompt }=await jiti.import('./decision-policy.ts');
const { evaluateRichSurface }=await jiti.import('./rich-protocol.ts');
const compile=plan=>compileUiRichPlan(plan,{revision:1}).surface;

test('exact component example is complete, tool-specific, and executes at its sampled input boundaries',()=>{
  const plan=uiRichPlanAuthoringExample();
  assert.deepEqual(validateToolArguments({name:'piora_render_ui_plan',parameters:uiRichPlanSchema},{id:'example',name:'piora_render_ui_plan',arguments:structuredClone(plan)}),plan);
  const guidelines=intelligentUiRichPlanPrompt().promptGuidelines;
  assert.ok(guidelines.some(line=>line.includes(JSON.stringify(plan))));
  assert.equal(guidelines.some(line=>line.startsWith('Views are text, metric, table or barChart.')),false);
  assert.equal(originalUiPlanDiagnostic(plan),undefined);
  assert.ok(trialUiInputBoundaries(compile(plan)).sampleCount>1);
});

test('the full quantity example accepts counts beyond its initial value without inventing an upper bound',()=>{
  const plan=uiRichPlanAuthoringExample(),surface=compile(plan);
  assert.equal(Object.hasOwn(plan.inputs[0],'max'),false);
  assert.equal(Object.hasOwn(surface.nodes.find(node=>node.id==='quantity'),'max'),false);
  for(const quantity of [0,2,11,10001]){
    const evaluated=evaluateRichSurface(surface,{quantity});
    assert.deepEqual(evaluated.nodes.find(node=>node.id==='totalView').value,{value:quantity*12});
    assert.equal(evaluated.nodes.find(node=>node.id==='explanation').parts.map(part=>part.value).join(''),`At ${quantity} items, the total is ${quantity*12}.`);
  }
});

test('a zero input failure absent at defaults is rejected before publication without changing the domain',()=>{
  const plan=uiRichPlanAuthoringExample();
  plan.derived.push({id:'average',op:'divide',args:[{derived:'total'},{input:'quantity'}]});
  plan.views[0].value={derived:'average'};
  const before=JSON.stringify(plan),surface=compile(plan);
  assert.throws(()=>trialUiInputBoundaries(surface),e=>e.diagnostic.code==='PLAN_INPUT_EVALUATION'&&e.diagnostic.path==='$.views[0].value');
  assert.equal(originalUiPlanDiagnostic(plan).code,'PLAN_INPUT_EVALUATION');
  assert.equal(JSON.stringify(plan),before);
  plan.derived[1]={id:'average',op:'if',args:[{op:'equals',args:[{input:'quantity'},0]},0,{op:'divide',args:[{derived:'total'},{input:'quantity'}]}]};
  assert.equal(originalUiPlanDiagnostic(plan),undefined,'A meaningful lazy zero-state remains valid');
});

test('discrete combinations expose failures hidden by single-input probes, while bounds and budgets remain enforced',()=>{
  const surface={version:2,id:'combined',title:'Combined inputs',revision:1,layout:[],nodes:[
    {id:'a',type:'checkbox',label:'a',value:false},{id:'b',type:'checkbox',label:'b',value:false},
    {id:'result',type:'dynamicText',parts:[{op:'if',args:[{ref:'a'},{op:'if',args:[{ref:'b'},{op:'divide',args:[1,0]},1]},1]}]},
  ]};
  assert.throws(()=>trialUiInputBoundaries(surface),e=>e.diagnostic.code==='PLAN_INPUT_EVALUATION'&&e.diagnostic.path==='$.views[0].parts[0]');
  const many={version:1,id:'many',title:'Many controls',revision:1,nodes:Array.from({length:64},(_,i)=>({id:`v${i}`,type:'select',label:'choice',value:'default',options:['default','a','b','c','d','e']}))};
  const samples=uiInputTrialSamples(many);
  assert.equal(samples.states.length,UI_INPUT_TRIAL_POLICY.maxSamples);assert.equal(samples.truncated,true);
  assert.ok(samples.states.some(state=>state.v63==='a'),'Every control gets its first alternate before later options');
  const bounded={...many,nodes:[{id:'n',type:'number',label:'bounded',value:2,min:1,max:3,step:1}]};
  assert.ok(uiInputTrialSamples(bounded).states.every(state=>state.n>=1&&state.n<=3));
});
