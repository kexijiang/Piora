import assert from 'node:assert/strict';
import test from 'node:test';
import {createJiti} from 'jiti';
import {Type} from '@earendil-works/pi-ai';
import {runToolCall} from '../node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js';
import {counterPlan} from './mini-app-fixtures.mjs';

const jiti = createJiti(import.meta.url);
const {bindAnswerOutputAdmission} = await jiti.import('./answer-output-admission.ts');
const {miniAppPlanSchema} = await jiti.import('./mini-app/plan-schema.ts');
const {miniAppDiagnostic} = await jiti.import('./mini-app/diagnostic.ts');
const {MiniAppError} = await jiti.import('./mini-app/limits.ts');
const mini = 'piora_render_mini_app', component = 'piora_render_ui';
const call = (id, args, name = mini) => ({id, name, arguments:args});
const diagnostic = result => result.result.details.answerOutputDiagnostic;

function fixture(t, {failExecution = false} = {}) {
  const agent = {pioraToolAdmissionVersion:2};
  let executions = 0, permissions = 0, active = true;
  const tools = [
    {name:mini, parameters:miniAppPlanSchema},
    {name:component, parameters:Type.Object({count:Type.Number()})},
  ].map(tool => ({...tool, description:'Admission fixture, not a generated answer', executionMode:'sequential',
    async execute() {
      executions++;
      return failExecution ? {content:[], isError:true, details:{answerOutputDiagnostic:{code:'FRAME',message:'Missing bound value',repairable:true}}}
        : {content:[{type:'text',text:'executed fixture'}]};
    }}));
  const binding = bindAnswerOutputAdmission({agent, identity:{sessionId:'session',runId:'run'}, loadedTools:tools,
    isActive:()=>active, onRepeatedDenial(){}});
  t.after(()=>binding.cancel());
  const message = {role:'assistant',content:[]};
  const options = {tools, context:{messages:[message],tools}, assistantMessage:message,
    admitToolCall:agent.admitToolCall, beforeToolCall(){ permissions++; }};
  return {binding, agent, options, run:c=>runToolCall(c, options), counts:()=>({executions,permissions}), deactivate:()=>{active=false;}};
}

test('host action declarations reject unsafe paths before SDK permissions, then admit the valid plan',async t=>{
  const f=fixture(t),plan=counterPlan();
  plan.actions={version:1,actions:[{id:'save',label:'Save result',path:'result.json',kind:'save_snapshot',format:'json'}]};
  const invalid=structuredClone(plan);invalid.actions.actions[0].path='../outside.json';
  const result=await f.run(call('unsafe-action',invalid));
  assert.equal(result.isError,true);assert.ok(diagnostic(result).message);
  assert.deepEqual(f.counts(),{executions:0,permissions:0});
  const valid=await f.run(call('valid-action',plan));assert.equal(valid.isError,false);
  assert.deepEqual(f.counts(),{executions:1,permissions:1});
});

test('actual SDK rejects original mini app arguments before coercion, permission and execution, sharing the total budget', async t=>{
  const f = fixture(t), invalid = counterPlan(); invalid.inputs[0].value = '2';
  const first = await f.run(call('string-number', invalid));
  assert.equal(first.isError,true);
  assert.equal(diagnostic(first).repairable,true);
  assert.match(diagnostic(first).path,/inputs.*value/);
  assert.ok(diagnostic(first).message.length > 0);
  assert.deepEqual(f.counts(),{executions:0,permissions:0});
  assert.equal(first.toolCall.arguments.inputs[0].value,'2','original SDK history remains intact');
  const fixed = await f.run(call('fixed',counterPlan())); assert.equal(fixed.isError,false);
  const legacy = await f.run(call('component',{count:3},component)); assert.equal(legacy.isError,false);
  assert.equal(diagnostic(await f.run(call('fourth',counterPlan()))).code,'UI_ATTEMPTS_EXHAUSTED');
  assert.deepEqual(f.counts(),{executions:2,permissions:2});
  assert.deepEqual([f.binding.snapshot().attempts,f.binding.snapshot().corrections],[3,1]);
});

test('a mini app execution diagnostic permits one correction but another tool cannot reset it', async t=>{
  const f = fixture(t,{failExecution:true});
  assert.equal(diagnostic(await f.run(call('runtime-failure',counterPlan()))).code,'FRAME');
  assert.equal(diagnostic(await f.run(call('component-failure',{count:3},component))).code,'FRAME');
  assert.equal(diagnostic(await f.run(call('again',counterPlan()))).code,'UI_CORRECTIONS_EXHAUSTED');
  assert.deepEqual(f.counts(),{executions:2,permissions:2});
});

test('actual SDK returns independent schema, program and layout problems in one correction slot',async t=>{
  const f=fixture(t),invalid=counterPlan();delete invalid.purpose;
  invalid.program='var externalCount=0;'+invalid.program;
  invalid.document.css='section{font-family:unavailable}';
  const failed=await f.run(call('multiple-problems',invalid)),problem=diagnostic(failed);
  assert.equal(failed.isError,true);assert.equal(problem.repairable,true);
  for(const path of ['purpose','program','document/css/font-family'])assert.ok(problem.issues.some(issue=>issue.path===path),path);
  assert.equal(problem.contract.tool,mini);assert.equal(problem.contract.planVersion,1);
  assert.deepEqual(f.counts(),{executions:0,permissions:0});
  assert.equal((await f.run(call('all-fixed',counterPlan()))).isError,false);
  assert.deepEqual([f.binding.snapshot().attempts,f.binding.snapshot().corrections],[2,1]);
  assert.deepEqual(f.counts(),{executions:1,permissions:1});
});

test('mini app duplicate delivery caches results, call ID conflicts and cancelled contexts cannot execute', async t=>{
  const f = fixture(t), original = call('same',counterPlan());
  await f.run(original); await f.run(structuredClone(original));
  assert.deepEqual(f.counts(),{executions:1,permissions:1});
  assert.equal(diagnostic(await f.run(call('same',{count:3},component))).code,'UI_CALL_ID_CONFLICT');
  f.deactivate();
  assert.equal(diagnostic(await f.run(call('late',counterPlan()))).code,'UI_RUN_UNAVAILABLE');
  assert.deepEqual(f.counts(),{executions:1,permissions:1});
});

test('mini app requires verified SDK admission and remains unavailable to a binding without the capability', async t=>{
  const options = {agent:{},identity:{sessionId:'s',runId:'r'},loadedTools:[{name:mini}],isActive:()=>true,onRepeatedDenial(){}};
  assert.throws(()=>bindAnswerOutputAdmission(options),/verified tool admission runtime/);
  const agent = {pioraToolAdmissionVersion:2};
  const binding = bindAnswerOutputAdmission({...options,agent,loadedTools:[]}); t.after(()=>binding.cancel());
  const result = await agent.admitToolCall({toolCall:call('old',counterPlan())});
  assert.equal(result.immediate.result.details.answerOutputDiagnostic.code,'UI_RUN_UNAVAILABLE');
  assert.equal(binding.snapshot(),undefined);
});

test('compiler diagnostics are bounded and arbitrary exceptions cannot expose source or stacks', ()=>{
  const fallback = {code:'GENERATION',message:'Host failed',repairable:false};
  const problem = miniAppDiagnostic(new MiniAppError('SCHEMA','a'.repeat(1000),'x'.repeat(1000),true),fallback);
  assert.equal(problem.message.length,600); assert.equal(problem.path.length,240);
  assert.deepEqual(miniAppDiagnostic(new Error('secret program text'),fallback),fallback);
});
