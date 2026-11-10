import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url);
const {miniAppRepeatExample}=await jiti.import('./mini-app/repeat-example.ts');
const {compileMiniAppPlan,validateMiniAppResult}=await jiti.import('./mini-app/plan.ts');
const {validateMiniAppFrame}=await jiti.import('./mini-app/frame.ts');
const {miniAppEventRequest}=await jiti.import('./mini-app/events.ts');
const {MiniAppRepeatIdentity,miniAppRepeatContext}=await jiti.import('./mini-app/repeat.ts');
const {MiniAppVm}=await jiti.import('./mini-app/vm.ts');
const {compileMiniAppCss}=await jiti.import('./mini-app/document.ts');
const {requiredMiniAppCapabilities}=await jiti.import('./mini-app/capabilities.ts');
const {miniAppAuthoringExample}=await jiti.import('./mini-app/authoring-example.ts');
const wasm=readFileSync(createRequire(import.meta.url).resolve('quickjs-wasi/quickjs.wasm'));
const compiled=()=>compileMiniAppPlan(miniAppRepeatExample());
const frame=()=>({summary:'List',bindings:{status:'List'},repeats:{tasks:[{key:'one',bindings:{title:'One',done:false,priority:'high'}}]}});

test('native row control selectors and literal list markers work without permitting arbitrary attributes or resources',()=>{
  const css='ul{list-style:none}input[type=text]{flex:1}input[type="checkbox"]{width:1rem}[data-repeat=tasks] [data-field=title]{color:var(--text)}';
  assert.match(compileMiniAppCss(css),/list-style:none/);
  for(const invalid of ['input[value=secret]{color:red}','input[type=file]{color:red}','input[type^=text]{color:red}','ul{list-style:url(https://example.com/a)}','ul{list-style-type:custom}','ul{list-style-position:fixed}']) assert.throws(()=>compileMiniAppCss(invalid));
});

test('new style syntax selects the new runtime without changing historical plan identities for comments or older CSS',()=>{
  const plan=miniAppAuthoringExample();assert.equal(compileMiniAppPlan(plan).runtimeVersion,'mini-app-1.2');
  plan.document.css+='/* list-style:none; input[type=text] */';assert.equal(compileMiniAppPlan(plan).runtimeVersion,'mini-app-1.2');
  plan.document.css+='input[type=text]{color:var(--text)}';assert.equal(compileMiniAppPlan(plan).runtimeVersion,'mini-app-1.3');
  const inline=miniAppAuthoringExample();inline.document.html=inline.document.html.replace('<section>','<section style="list-style:none">');
  assert.equal(compileMiniAppPlan(inline).runtimeVersion,'mini-app-1.3');
});

test('follow-up row excerpts preserve whole values and display positions with explicit omissions',()=>{
  const data={tasks:[{key:'large',bindings:{title:'x'.repeat(2000)}},{key:'small',bindings:{title:'Keep this',done:true}}]};
  const context=miniAppRepeatContext(data,300);
  assert.ok(JSON.stringify(context).length<=300);assert.equal(context[0].totalRows,2);assert.equal(context[0].omittedRows,1);
  assert.deepEqual(context[0].rows,[{index:1,...data.tasks[1]}]);assert.equal(miniAppRepeatContext(undefined),undefined);
});

test('row templates have scoped bindings, versioned runtime and an independently gated capability',()=>{
  const c=compiled();assert.equal(c.runtimeVersion,'mini-app-1.3');
  assert.deepEqual(c.document.bindings,[{id:'status'}]);
  assert.equal(c.document.repeats[0].fields.length,3);
  assert.ok(requiredMiniAppCapabilities(c).includes('repeat'));
  for(const [before,after] of [
    ['<li>','<li id="duplicate">'],['<li>','<li data-repeat="nested">'],
    ['aria-label="事项名称"',''],['maxlength="80"','maxlength="8000"'],
    ['data-field="title"','data-input="title"'],['data-field="title"','data-field="done"'],
  ]){const plan=miniAppRepeatExample();plan.document.html=plan.document.html.replace(before,after);assert.throws(()=>compileMiniAppPlan(plan));}
});

test('rows reject duplicate identities, missing bindings and oversized expansion rather than truncating user data',()=>{
  const c=compiled();assert.deepEqual(validateMiniAppFrame(frame(),c.document,[]),frame());
  for(const change of [
    f=>f.repeats.tasks.push(structuredClone(f.repeats.tasks[0])),
    f=>{delete f.repeats;},f=>{f.repeats.tasks[0].bindings.done='yes';},
    f=>{f.repeats.tasks[0].bindings.priority='unknown';},
    f=>{f.repeats.tasks[0].bindings.title='x'.repeat(81);},
    f=>{f.repeats.tasks=Array.from({length:50},(_,i)=>({...f.repeats.tasks[0],key:'row'+i}));},
    f=>{f.repeats.tasks.push({key:'two',bindings:{title:'second',done:false,priority:'high'},html:'<script/>'});},
  ]){const value=frame();change(value);assert.throws(()=>validateMiniAppFrame(value,c.document,[]));}
  const empty=frame();empty.repeats.tasks=[];assert.equal(validateMiniAppFrame(empty,c.document,[]).repeats.tasks.length,0);
});

test('row generation survives reordering and queued typing, but rejects removed/reused keys and expired frames',()=>{
  const ids=new MiniAppRepeatIdentity(), rows={tasks:[{key:'one',bindings:{}},{key:'two',bindings:{}}]};
  const first=ids.publish(rows), event={repeat:'tasks',key:'one',frame:first};
  ids.publish({tasks:[...rows.tasks].reverse()});ids.validate(event);
  ids.publish({tasks:[rows.tasks[1]]});assert.throws(()=>ids.validate(event),e=>e.code==='STALE_EVENT');
  ids.publish(rows);assert.throws(()=>ids.validate(event),e=>e.code==='STALE_EVENT');
  const current=ids.publish(rows), next={...event,frame:current};ids.validate(next);
  for(let i=0;i<33;i++)ids.publish(rows);
  assert.throws(()=>ids.validate(next),e=>e.code==='STALE_EVENT');
  assert.throws(()=>ids.validate({...event,frame:1e9}),e=>e.code==='STALE_EVENT');
  ids.reset();assert.throws(()=>ids.validate(event),e=>e.code==='STALE_EVENT');
});

test('real QuickJS edits, reorders, deletes and restores the selected object without changing global input identity',async()=>{
  const c=compiled(),vm=await MiniAppVm.create(wasm,c.plan.program);let restored;
  try {
    let result=validateMiniAppResult(c,vm.run({command:'init',snapshot:{inputs:c.initialInputs,state:null,rng:77,tick:0}}));
    const interact=event=>{result=validateMiniAppResult(c,vm.run(miniAppEventRequest(c,result.snapshot,event,result.frame)));};
    const row={repeat:'tasks',key:'task2',frame:1,serial:1};
    interact({...row,type:'item-input',id:'title',value:'衣服和雨伞'});
    interact({...row,type:'item-input',id:'done',value:true});
    interact({...row,type:'item-click',id:'up'});
    assert.deepEqual(result.snapshot.state.items.map(x=>x.key),['task2','task1','task3']);
    assert.equal(result.frame.repeats.tasks[0].bindings.title,'衣服和雨伞');
    assert.equal(result.frame.repeats.tasks[0].bindings.done,true);
    assert.deepEqual(result.snapshot.inputs,c.initialInputs);
    assert.throws(()=>miniAppEventRequest(c,result.snapshot,{...row,type:'item-input',id:'title',value:42},result.frame));
    interact({...row,type:'item-click',id:'remove'});
    assert.deepEqual(result.snapshot.state.items.map(x=>x.key),['task1','task3']);
    assert.throws(()=>miniAppEventRequest(c,result.snapshot,{...row,type:'item-click',id:'remove'},result.frame));
    restored=await MiniAppVm.create(wasm,c.plan.program);
    const read=validateMiniAppResult(c,restored.run({command:'project',snapshot:result.snapshot}));
    assert.deepEqual(read,result);
  }finally{vm.dispose();restored?.dispose();}
});
