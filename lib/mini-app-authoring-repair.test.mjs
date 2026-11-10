import assert from 'node:assert/strict';
import test from 'node:test';
import {createJiti} from 'jiti';
import {counterPlan} from './mini-app-fixtures.mjs';
const jiti=createJiti(import.meta.url);
const {compileMiniAppPlan}=await jiti.import('./mini-app/plan.ts');
const {miniAppDiagnostic}=await jiti.import('./mini-app/diagnostic.ts');
const {UiAdmissionBudget}=await jiti.import('./intelligent-ui/admission.ts');
const {compileUiRichPlan}=await jiti.import('./intelligent-ui/rich-plan.ts');
const {uiRichPlanAuthoringExample}=await jiti.import('./intelligent-ui/authoring-example.ts');
const names=['piora_render_mini_app','piora_render_ui_plan'];
const outcome=plan=>{
  try{compileMiniAppPlan(plan);return {isError:false,result:{content:[]}};}
  catch(error){const d=miniAppDiagnostic(error,{code:'UNKNOWN',message:'Failed',repairable:false});
    return {isError:true,result:{content:[{type:'text',text:JSON.stringify(d)}],details:{answerOutputDiagnostic:d}}};}
};

test('a layout authoring correction shares the original budget, with no increase or automatic plan rewriting',async t=>{
  const b=new UiAdmissionBudget({sessionId:'authoring',runId:'run',toolNames:names,isActive:()=>true});t.after(()=>b.cancel());
  const original=counterPlan();original.document.css='main{grid-template-columns:repeat(auto-fit,minmax(120px,1fr))}';
  const bytes=JSON.stringify(original),first=outcome(original);
  assert.equal(first.isError,true);assert.equal(first.result.details.answerOutputDiagnostic.repairable,true);
  assert.match(first.result.details.answerOutputDiagnostic.message,/integer from 1 to 8/);
  assert.equal(JSON.stringify(original),bytes);
  (await b.admit({toolCall:{id:'first',name:names[0],arguments:original}})).settle(first,'execution');
  const corrected=structuredClone(original);corrected.document.css='main{grid-template-columns:repeat(2,minmax(120px,1fr))}';
  (await b.admit({toolCall:{id:'second',name:names[0],arguments:corrected}})).settle(outcome(corrected),'execution');
  assert.deepEqual([b.snapshot().attempts,b.snapshot().corrections],[2,1]);
  const another=structuredClone(original);another.document.css='main{grid-template-columns:repeat(99999,1fr)}';
  (await b.admit({toolCall:{id:'third',name:names[0],arguments:another}})).settle(outcome(another),'execution');
  assert.ok((await b.admit({toolCall:{id:'switch',name:names[1],arguments:{}}})).immediate);
});

test('syntax diagnostics locate invalid code without echoing user source and retain exact complete-resubmission fields',()=>{
  const plan=counterPlan();plan.program='function init(){return "private-secret";}\nfunction reduce( {';
  const d=outcome(plan).result.details.answerOutputDiagnostic;
  assert.equal(d.repairable,true);assert.match(d.message,/line 2, column/);assert.doesNotMatch(JSON.stringify(d),/private-secret/);
  assert.deepEqual(d.contract.required,['planVersion','id','title','purpose','assumptions','inputs','stateSchema','document','viewports','playback','program','initialSnapshot']);
  assert.equal(d.contract.planVersion,1);assert.ok(d.contract.omitUnused.includes('inputPresets'));
  const escaped=counterPlan();escaped.program='const VALUE=1;\\n'+escaped.program;
  assert.match(outcome(escaped).result.details.answerOutputDiagnostic.message,/real line breaks/);
  assert.match(outcome(escaped).result.details.answerOutputDiagnostic.message,/do not double-escape/);
});

test('nested syntax diagnostics locate delimiters without confusing private literals, comments or regular expressions',()=>{
  const p=counterPlan();p.program='function project(){ const secret="} private-value"; const pattern=/[{}]/; /* { */ return {scenes:{space:{meshes:[]}}; }';
  const d=outcome(p).result.details.answerOutputDiagnostic;
  assert.match(d.message,/Innermost still-open delimiter '\{' starts at line 1, column 90/);
  assert.doesNotMatch(JSON.stringify(d),/private-value|pattern|secret/);
  const unchanged=p.program;
  assert.equal(outcome(p).isError,true);assert.equal(p.program,unchanged,'Diagnostics must not repair the submitted code');
  p.program='function project(){const s=`private-template ${1+2}`;return {scenes:{space:{meshes:[]}}; }';
  assert.match(outcome(p).result.details.answerOutputDiagnostic.message,/closing '\}'/);
  assert.doesNotMatch(JSON.stringify(outcome(p)),/private-template/);
});

test('real resource exhaustion remains terminal and no unsupported markup is silently accepted',()=>{
  const large=counterPlan();large.document.css='main{width:999999px}';
  const d=outcome(large).result.details.answerOutputDiagnostic;assert.equal(d.code,'LIMIT');assert.equal(d.repairable,false);
  for(const css of ['main{grid-template-columns:repeat(9,1fr)}','main{grid-template-columns:repeat(auto-fill,1fr)}','main{aspect-ratio:1}']){
    const plan=counterPlan();plan.document.css=css;assert.equal(outcome(plan).isError,true);
  }
  const empty=counterPlan();empty.inputPresets=[];assert.equal(outcome(empty).isError,true);
});

test('known component version confusion can use exactly one correction but unknown future versions stay terminal',async t=>{
  const b=new UiAdmissionBudget({sessionId:'versions',runId:'run',toolNames:names,isActive:()=>true});t.after(()=>b.cancel());
  const plan=uiRichPlanAuthoringExample();delete plan.planVersion;
  let d;try{compileUiRichPlan(plan,{revision:1});}catch(e){d=e.diagnostic;}
  assert.equal(d?.code,'PLAN_VERSION');assert.equal(d?.repairable,true);
  (await b.admit({toolCall:{id:'missing',name:names[1],arguments:plan}})).settle({isError:true,result:{content:[],details:{intelligentUiDiagnostic:d}}},'execution');
  plan.planVersion=2;assert.doesNotThrow(()=>compileUiRichPlan(plan,{revision:1}));
  (await b.admit({toolCall:{id:'fixed',name:names[1],arguments:plan}})).settle({isError:false,result:{content:[]}},'execution');
  assert.deepEqual([b.snapshot().attempts,b.snapshot().corrections],[2,1]);
  plan.planVersion=99;assert.throws(()=>compileUiRichPlan(plan,{revision:1}),e=>e.diagnostic.code==='PLAN_VERSION'&&!e.diagnostic.repairable);
});
