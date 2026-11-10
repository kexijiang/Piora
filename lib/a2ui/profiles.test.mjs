import assert from 'node:assert/strict';
import test from 'node:test';
import {createJiti} from 'jiti';
import {prepareMiniAppRuntime} from '../../scripts/prepare-mini-app-runtime.mjs';
const jiti=createJiti(import.meta.url);
const {compileA2uiUi}=await jiti.import('./ui-compiler.ts');
const {formatSnapshot}=await jiti.import('../intelligent-ui/surface-document.ts');
const {miniAppRepeatExample}=await jiti.import('../mini-app/repeat-example.ts');
const {miniAppSceneExample}=await jiti.import('../mini-app/scene-example.ts');
const {trialMiniApp}=await jiti.import('../mini-app/server-trial.ts');
const catalogId='urn:piora:a2ui:interactive:1';
const path=id=>({'@path':`/inputs/${id}`});
const messages=(surfaceId,components,inputs)=>[{version:'1.0',createSurface:{surfaceId,catalogId,components,dataModel:{inputs}}}];

test('the eight original component types remain reactive through A2UI',()=>{
  const components=[
    {id:'quantity',component:'PioraNumber',label:'数量',value:path('quantity'),min:1,step:1},
    {id:'rate',component:'Slider',label:'比例',value:path('rate'),min:0,max:1,steps:10},
    {id:'choice',component:'PioraChoice',label:'方案',value:path('choice'),options:['A','B']},
    {id:'enabled',component:'CheckBox',label:'启用',value:path('enabled')},
    {id:'caption',component:'Text',text:'改变输入核对表格和图表'},
    {id:'value',component:'PioraMetric',label:'当前数量',value:path('quantity')},
    {id:'table',component:'PioraTable',columns:['数量','比例','方案','启用'],rows:[[path('quantity'),path('rate'),path('choice'),path('enabled')]]},
    {id:'chart',component:'PioraBarChart',labels:['数量','比例'],values:[path('quantity'),path('rate')]},
  ];
  const ui=compileA2uiUi({id:'allControls',title:'组件联动',messages:messages('allControls',[{id:'root',component:'Column',children:components.map(c=>c.id)},...components],{quantity:2,rate:0.5,choice:'A',enabled:false})},{revision:1}).surface;
  assert.match(formatSnapshot(ui,{quantity:7,rate:0.8,choice:'B',enabled:true}),/7 \| 0.8 \| B \| true/);
  assert.equal(ui.nodes.find(n=>n.id==='rate').step,0.1);
});

test('A2UI repeat and 3D viewport adapters preserve the original executable frames',{timeout:60000},async()=>{
  await prepareMiniAppRuntime();
  const repeat=miniAppRepeatExample(),scene=miniAppSceneExample();
  const repeated=structuredClone(repeat),spatial=structuredClone(scene);
  repeated.document={messages:messages(repeat.id,[
    {id:'root',component:'Column',children:['status','newTitle','add','tasks']},
    {id:'status',component:'Text',text:{'@path':'/frame/status'}},
    {id:'newTitle',component:'TextField',label:repeat.inputs[0].label,value:path('newTitle')},
    {id:'add',component:'Button',child:'addLabel',action:{functionCall:{'@call':'pioraEvent',args:{id:'add'}}}},
    {id:'addLabel',component:'Text',text:'添加'},
    {id:'tasks',component:'PioraRepeat',repeatId:'tasks',template:repeat.document.html.match(/<ul data-repeat="tasks">([\s\S]*)<\/ul>/)[1]},
  ],{newTitle:''})};
  spatial.document={messages:messages(scene.id,[
    {id:'root',component:'Column',children:[...scene.inputs.map(i=>i.id),'space','selection','angles','reset']},
    ...scene.inputs.map(i=>({id:i.id,component:'PioraNumber',label:i.label,value:path(i.id)})),
    {id:'space',component:'PioraViewport',viewportId:'airspace'},
    ...['selection','angles'].map(id=>({id,component:'Text',text:{'@path':`/frame/${id}`}})),
    {id:'reset',component:'Button',child:'resetLabel',action:{functionCall:{'@call':'pioraEvent',args:{id:'cameraReset'}}}},
    {id:'resetLabel',component:'Text',text:'重置观察'},
  ],Object.fromEntries(scene.inputs.map(i=>[i.id,i.value])))};
  for(const [oldPlan,newPlan] of [[repeat,repeated],[scene,spatial]]) {
    const oldResult=await trialMiniApp(oldPlan),newResult=await trialMiniApp(newPlan);
    assert.deepEqual(newResult.frame,oldResult.frame);
    assert.deepEqual(newResult.snapshot.state,oldResult.snapshot.state);
    assert.deepEqual((await trialMiniApp(newPlan,{snapshot:newResult.snapshot})).frame,newResult.frame);
  }
});
