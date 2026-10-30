import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { validateToolArguments } from '@earendil-works/pi-ai';
const jiti=createJiti(import.meta.url);
const { compileUiRichPlan }=await jiti.import('./rich-plan.ts');
const { compileUiPlan }=await jiti.import('./plan.ts');
const { uiRichPlanSchema }=await jiti.import('./rich-plan-schema.ts');
const { validateSurface: validateLegacy }=await jiti.import('./protocol.ts');
const { validateSurface, formatSnapshot }=await jiti.import('./surface-document.ts');
const { richSnapshotUpperBound }=await jiti.import('./rich-protocol.ts');
const { compileUiPreview }=await jiti.import('./preview-plan.ts');
const { parseUiPlanPrefix }=await jiti.import('./preview-parser.ts');
const { actionSnapshotBytes }=await jiti.import('./action-files.ts');
const op=(op,...args)=>({op,args});
const plan=()=>({planVersion:2,id:'tickets',title:'Ticket costs',inputs:[
 {id:'people',label:'People',valueType:'number',value:6,min:0},
 {id:'cents',label:'Ticket',unit:'cents',valueType:'number',value:3500,min:0}],
 derived:[{id:'total',op:'divide',args:[op('multiply',{input:'people'},{input:'cents'}),100]}],
 views:[{id:'explanation',kind:'dynamicText',parts:['For ',{input:'people'},' people, total ',{derived:'total'},' yuan.']}],
 layout:[{id:'settings',type:'group',title:'Adjust',columns:1,nodeIds:['people','cents','explanation']}]});
const compile=value=>compileUiRichPlan(value,{revision:1});
const preview=raw=>compileUiPreview(parseUiPlanPrefix(raw));

test('dynamic prose uses the real schema and the same current state in snapshots and file output',()=>{
 const source=plan(),before=structuredClone(source);
 const args=validateToolArguments({name:'piora_render_ui_plan',parameters:uiRichPlanSchema},{id:'call',name:'piora_render_ui_plan',arguments:source});
 const {surface}=compile(args);assert.deepEqual(source,before);
 assert.equal(surface.nodes.at(-1).type,'dynamicText');
 assert.match(formatSnapshot(surface),/For 6 people, total 210 yuan\./);
 const state={people:6,cents:4500},snapshot=formatSnapshot(surface,state);
 assert.match(snapshot,/For 6 people, total 270 yuan\./);assert.doesNotMatch(snapshot,/210/);
 for(const format of ['markdown','json']){
  const bytes=actionSnapshotBytes({id:'save',label:'Save',kind:'save_snapshot',path:format==='json'?'result.json':'result.md',format},surface,state).toString('utf8');
  assert.match(bytes,/For 6 people, total 270 yuan\./);assert.doesNotMatch(bytes,/210/);
  if(format==='json')assert.deepEqual(JSON.parse(bytes).parameters,state);
 }
 assert.ok(snapshot.length<=richSnapshotUpperBound(surface));
});

test('bound conditional prose is lazy and arithmetic failures remain explicit',()=>{
 const value=plan();value.inputs[0].value=0;
 value.views[0].parts=['Result: ',op('if',op('equals',{input:'people'},0),'No participants','Sharing'),'; per person: ',op('if',op('equals',{input:'people'},0),0,op('divide',100,{input:'people'}))];
 const {surface}=compile(value);
 assert.match(formatSnapshot(surface),/Result: No participants/);
 assert.match(formatSnapshot(surface,{people:4,cents:3500}),/Result: Sharing; per person: 25/);
 const unguarded=plan();unguarded.views[0].parts=['Per person: ',op('divide',100,{input:'people'})];
 assert.match(formatSnapshot(compile(unguarded).surface,{people:0,cents:3500}),/Per person: \[calculation unavailable\]/);
});

test('preview waits for bound prose dependencies and matches final output at every boundary',()=>{
 const value=plan();
 for(const order of [['inputs','derived','views','layout'],['layout','views','derived','inputs']]){
  const raw=JSON.stringify({planVersion:2,id:value.id,title:value.title,...Object.fromEntries(order.map(key=>[key,value[key]]))});
  for(let i=0;i<=raw.length;i++)assert.notEqual(preview(raw.slice(0,i)).status,'invalid',`${order} at ${i}`);
  const partial=preview(raw.slice(0,-1));assert.equal(partial.status,'ready');
  assert.deepEqual(partial.surface,compile(value).surface);
 }
 const pending=JSON.stringify({planVersion:2,id:value.id,title:value.title,views:value.views,layout:value.layout}).slice(0,-1);
 assert.equal(preview(pending).status,'waiting');
 assert.equal(preview(pending+',"derived":[]').status,'invalid');
});

test('bound prose retains reference, type, depth, field and aggregate expression budgets',()=>{
 const reject=(mutate,pattern)=>{const value=plan();mutate(value);assert.throws(()=>compile(value),pattern);};
 reject(p=>p.views[0].parts=[{input:'missing'}],/PLAN_REFERENCE.*parts/);
 reject(p=>p.views[0].parts=[op('add','bad',1)],/PLAN_TYPE/);
 reject(p=>p.views[0].text='alternate hidden copy',/PLAN_SHAPE/);
 reject(p=>p.views[0].parts=Array(13).fill('x'),/PLAN_LIMIT/);
 reject(p=>p.views[0].parts=[],/PLAN_LIMIT/);
 reject(p=>{let value={input:'people'};for(let i=0;i<14;i++)value=op('add',value,1);p.views[0].parts=[value];},/PLAN_LIMIT/);
 reject(p=>{let value={input:'people'};for(let i=0;i<10;i++)value=op('add',value,value);p.views[0].parts=[value,value,value];},/PLAN_LIMIT|PLAN_COMPLEXITY/);
 const value=plan();value.layout=[{id:'filter',type:'filteredTable',title:'Wrong kind',tableId:'explanation',filters:[{column:0,controlId:'people',operator:'equals'}]}];
 assert.throws(()=>compile(value),/PLAN_REFERENCE/);assert.equal(preview(JSON.stringify(value).slice(0,-1)).status,'invalid');
});

test('direct rich documents cannot bypass prose shape or expression validation; legacy contracts stay unchanged',()=>{
 const {surface}=compile(plan());
 for(const mutate of [n=>{n.parts=[{ref:'missing'}];},n=>{n.html='<script/>';},n=>{n.parts=Array(13).fill('x');},n=>{n.parts=[{op:'fetch',args:['url']}];}]){
  const bad=structuredClone(surface);mutate(bad.nodes.at(-1));assert.throws(()=>validateSurface(bad));
 }
 assert.throws(()=>validateLegacy({...surface,version:1,layout:undefined}));
 const legacy=plan();delete legacy.layout;legacy.planVersion=1;
 assert.throws(()=>compileUiPlan(legacy,{revision:1}));
 legacy.views=[{id:'note',kind:'text',text:'A fixed rule'}];
 legacy.derived=[];
 assert.equal(compileUiPlan(legacy,{revision:1}).surface.nodes.at(-1).text,'A fixed rule');
});

test('interpolated strings remain literal text and snapshot bounds include longest selectable values',()=>{
 const value=plan();value.inputs.push({id:'name',label:'Name',valueType:'string',value:'short',options:['short','<img src=x onerror=bad()>']});
 value.views[0].parts=['<script>bad()</script> ',{input:'name'},' ${people}'];value.layout[0].nodeIds.push('name');
 const {surface}=compile(value),snapshot=formatSnapshot(surface,{people:6,cents:4500,name:'<img src=x onerror=bad()>'});
 assert.match(snapshot,/<script>bad\(\)<\/script> <img src=x onerror=bad\(\)> \$\{people\}/);
 assert.ok(snapshot.length<=richSnapshotUpperBound(surface));
});
