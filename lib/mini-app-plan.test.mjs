import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
import { counterPlan } from './mini-app-fixtures.mjs';
const jiti = createJiti(import.meta.url);
const { compileMiniAppPlan, validateMiniAppCheckpoint, validateMiniAppInputs, validateMiniAppResult } = await jiti.import('./mini-app/plan.ts');
const { compileMiniAppStateSchema, validateMiniAppState } = await jiti.import('./mini-app/state-schema.ts');
const { readMiniAppResource } = await jiti.import('./mini-app/resource.ts');
const { miniAppStepRequest } = await jiti.import('./mini-app/playback.ts');
const { miniAppEventRequest } = await jiti.import('./mini-app/events.ts');

test('playback binds one declared step button and preserves historical plan identity', () => {
  const plan=counterPlan();plan.playback={mode:'discrete',stepEvent:'increment'};
  const compiled=compileMiniAppPlan(plan),snapshot={inputs:{start:2},state:{count:2},tick:0,rng:42};
  assert.deepEqual(miniAppStepRequest(compiled,snapshot),miniAppEventRequest(compiled,snapshot,{type:'click',id:'increment'}));
  assert.equal(compiled.runtimeVersion,'mini-app-1.1');
  for(const playback of [{mode:'automatic'},{mode:'none',stepEvent:'increment'},{mode:'discrete'},{mode:'discrete',stepEvent:'unknown'},{mode:'discrete',stepEvent:'start'}]) {
    assert.throws(()=>compileMiniAppPlan({...plan,playback}));
  }
  const result={snapshot,frame:{summary:'Count: 2',bindings:{count:2}}};
  assert.throws(()=>validateMiniAppResult(compiled,result),e=>e.code==='FRAME'&&e.path==='frame/playback');
  assert.throws(()=>validateMiniAppResult(compiled,{...result,frame:{...result.frame,playback:{finished:'yes'}}}),e=>e.code==='FRAME');
  const none=compileMiniAppPlan({...plan,playback:{mode:'none'}});assert.equal(miniAppStepRequest(none,snapshot),undefined);
  assert.deepEqual(validateMiniAppResult(none,result),result);
  delete plan.playback;
  const legacy=compileMiniAppPlan(plan);assert.equal(legacy.runtimeVersion,'mini-app-1.0');assert.deepEqual(legacy.plan,plan);
  assert.deepEqual(miniAppStepRequest(legacy,snapshot),{command:'step',snapshot});
  assert.deepEqual(validateMiniAppResult(legacy,result),result);
});

test('plan compiler binds declared constraints and rejects markup or host authority overrides', () => {
  const plan=counterPlan(), compiled=compileMiniAppPlan(plan);
  const input=compiled.document.nodes[0].children[1];
  assert.deepEqual(compiled.initialInputs,{start:2});
  assert.equal(input.attrs.min,'0');assert.equal(input.attrs.max,'20');assert.equal(input.attrs.type,'number');
  assert.equal(input.attrs['aria-label'],'Starting value');
  for(const patch of [p=>{p.revision=99;},p=>{p.runtimeVersion='anything';},p=>{p.inputs[0].value=21;},p=>{p.inputs.push(p.inputs[0]);},p=>{p.document.html=p.document.html.replace('data-input="start"','data-input="start" min="-10"');},p=>{p.document.html=p.document.html.replace('data-input="start"','data-input="start" type="checkbox"');},p=>{p.program+='; fetch("https://example.com")';}]) {
    const changed=counterPlan();patch(changed);assert.throws(()=>compileMiniAppPlan(changed));
  }
  const selected=counterPlan();selected.inputs=[{id:'choice',label:'Choose',meaning:'Choice of simulation',type:'select',value:'a',options:[{value:'a',label:'Option A'},{value:'b',label:'Option B'}]}];
  selected.document.html='<select data-input="choice"></select><p data-text="count"></p>';
  assert.deepEqual(compileMiniAppPlan(selected).document.nodes[0].children.map(n=>n.attrs.value),['a','b']);
});

test('state schema bounds nested data and rejects code, references, coercion and extra state', () => {
  const schema=compileMiniAppStateSchema({type:'array',maxItems:3,items:{type:'string',maxLength:4,enum:['one','two']}});
  assert.deepEqual(validateMiniAppState(schema,['one','two']),['one','two']);
  for(const value of [['one','two','one','two'],['three'],[1]])assert.throws(()=>validateMiniAppState(schema,value));
  for(const value of [{type:'number'},{type:'string',maxLength:100000},{type:'array',maxItems:10,items:{$ref:'#'}},{type:'string',maxLength:4,pattern:'.*'},{type:'object',properties:{n:{type:'boolean'}},required:[],additionalProperties:false}])assert.throws(()=>compileMiniAppStateSchema(value));
  const compiled=compileMiniAppPlan(counterPlan());
  const point={inputs:{start:2},state:{count:7},rng:42,tick:6};
  assert.deepEqual(validateMiniAppCheckpoint(compiled,point),point);
  for(const patch of [{tick:-1},{rng:1.5},{state:{count:7,secret:'x'}},{state:{count:7.5}},{inputs:{start:50}},{inputs:{start:'2'}},{program:'x'}])assert.throws(()=>validateMiniAppCheckpoint(compiled,{...point,...patch}));
  assert.throws(()=>validateMiniAppInputs(compiled.plan,{}));
  const result={snapshot:point,frame:{summary:'Count: 7',bindings:{count:7},playback:{finished:false}}};
  assert.deepEqual(validateMiniAppResult(compiled,result),result);
  assert.throws(()=>validateMiniAppResult(compiled,{...result,frame:{summary:'Count: 7',bindings:{}}}));
});

test('resource reads bound actual stream bytes even without or with a false content-length', async () => {
  let cancelled=0;
  const stream=()=>new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(10));},cancel(){cancelled++;}});
  for(const headers of [{},{'content-length':'1'}])await assert.rejects(readMiniAppResource(new Response(stream(),{headers}),15),error=>error.code==='LIMIT');
  assert.equal(cancelled,2);
  assert.deepEqual([...await readMiniAppResource(new Response(new Uint8Array([1,2,3])),3)],[1,2,3]);
});

test('input acknowledgements remain host metadata and never enter generated state events',()=>{
  const compiled=compileMiniAppPlan(counterPlan()),snapshot={inputs:{start:2},state:{count:2},tick:0,rng:42};
  const request=miniAppEventRequest(compiled,snapshot,{type:'input',id:'start',value:7,serial:3});
  assert.deepEqual(request.event,{type:'input',id:'start',value:7});assert.equal(request.snapshot.inputs.start,7);
  for(const serial of [0,-1,1.5,'3',Number.MAX_SAFE_INTEGER+1])assert.throws(()=>miniAppEventRequest(compiled,snapshot,{type:'input',id:'start',value:7,serial}));
  assert.deepEqual(miniAppEventRequest(compiled,snapshot,{type:'input',id:'start',value:7}).event,request.event);
});
