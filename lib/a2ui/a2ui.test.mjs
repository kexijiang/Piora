import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
import { prepareMiniAppRuntime } from '../../scripts/prepare-mini-app-runtime.mjs';
const jiti=createJiti(import.meta.url);
const {compileA2uiUi}=await jiti.import('./ui-compiler.ts');
const {a2uiUiExample,a2uiUiSchema}=await jiti.import('./authoring.ts');
const {a2uiMiniAppExample}=await jiti.import('./mini-authoring.ts');
const {a2uiExplodedExample}=await jiti.import('./exploded-example.ts');
const {formatSnapshot,validateSurface}=await jiti.import('../intelligent-ui/surface-document.ts');
const {trialUiInputBoundaries}=await jiti.import('../intelligent-ui/input-trial.ts');
const {originalUiPlanDiagnostic}=await jiti.import('../intelligent-ui/plan-admission.ts');
const {compileMiniAppPlan}=await jiti.import('../mini-app/plan.ts');
const {trialMiniApp,previewMiniAppActions}=await jiti.import('../mini-app/server-trial.ts');
const surface=plan=>plan.messages[0].createSurface;

test('official A2UI messages compile to a reactive answer and round-trip without losing the source',()=>{
  const compiled=compileA2uiUi(a2uiUiExample(),{revision:4});
  assert.equal(compiled.surface.a2ui.version,'1.0');
  assert.deepEqual(validateSurface(JSON.parse(JSON.stringify(compiled.surface))),compiled.surface);
  assert.match(formatSnapshot(compiled.surface,{people:5}),/150/);
  assert.ok(trialUiInputBoundaries(compiled.surface).sampleCount>1);
  assert.ok(a2uiUiSchema.properties.messages);assert.equal(a2uiUiSchema.properties.planVersion,undefined);
});
test('separate messages use official data replacement and preserve the same surface',()=>{
  const plan=a2uiUiExample(),first=surface(plan),components=first.components,dataModel=first.dataModel;
  delete first.components;delete first.dataModel;
  plan.messages.push({version:'1.0',updateComponents:{surfaceId:plan.id,components}},
    {version:'1.0',updateDataModel:{surfaceId:plan.id,value:dataModel}},
    {version:'1.0',updateDataModel:{surfaceId:plan.id,path:'/inputs/people',value:6}});
  assert.match(formatSnapshot(compileA2uiUi(plan,{revision:1}).surface),/180/);
});
test('changing explanations and lazy branches stay reactive',()=>{
  const plan=a2uiUiExample(),s=surface(plan);
  s.components.push({id:'explanation',component:'Text',text:{'@call':'concat',args:{values:['当前人数 ',{'@path':'/inputs/people'}]}}});
  s.components[0].children.push('explanation');
  const compiled=compileA2uiUi(plan,{revision:1});assert.match(formatSnapshot(compiled.surface,{people:7}),/当前人数 7/);
});

test('component IDs are independent from input data paths in both profiles',()=>{
  const plan=a2uiUiExample(),s=surface(plan);
  s.components[1].id='peopleControl';s.components[0].children[0]='peopleControl';
  const ui=compileA2uiUi(plan,{revision:1}).surface;
  assert.match(formatSnapshot(validateSurface(ui),{people:6}),/180/);
  const mini=a2uiExplodedExample(),m=mini.document.messages[0].createSurface;
  m.components.find(c=>c.id==='part').id='partControl';
  m.components[0].children=m.components[0].children.map(id=>id==='part'?'partControl':id);
  const compiled=compileMiniAppPlan(mini);
  assert.deepEqual(compiled.document.inputs,['part']);
  assert.match(compiled.plan.document.html,/data-input="part"/);
  assert.deepEqual(compileMiniAppPlan(compiled.plan),compiled);
});

test('A2UI admission reports its own contract for missing parameters',()=>{
  const error=originalUiPlanDiagnostic({},true);
  assert.equal(error.code,'PLAN_SHAPE');assert.match(error.expected,/id/);
  assert.doesNotMatch(error.expected,/planVersion/);
});

test('official five-call nesting budget is honored without disabling SDK checks',()=>{
  const plan=a2uiUiExample();let expression={'@path':'/inputs/people'};
  for(let i=0;i<5;i++)expression={'@call':'add',args:{values:[expression,1]}};
  surface(plan).components[2].value=expression;
  assert.match(formatSnapshot(compileA2uiUi(plan,{revision:1}).surface),/7/);
  surface(plan).components[2].value={'@call':'add',args:{values:[expression,1]}};
  assert.throws(()=>compileA2uiUi(plan,{revision:1}),/depth|budget/);
});

test('mini-app presentation properties are either rendered or rejected explicitly',()=>{
  for(const patch of [{weight:2},{justify:'center'},{align:'end'}]) {
    const plan=a2uiMiniAppExample();Object.assign(plan.document.messages[0].createSurface.components[0],patch);
    assert.throws(()=>compileMiniAppPlan(plan),/omit weight/);
  }
  const plan=a2uiMiniAppExample();plan.document.messages[0].createSurface.components[1].variant='caption';
  assert.match(compileMiniAppPlan(plan).plan.document.html,/class="a2ui-caption" data-text="count"/);
});
for(const [name,mutate] of [
  ['foreign catalog',p=>surface(p).catalogId='https://untrusted.test/catalog'],
  ['old version',p=>p.messages[0].version='0.9'],
  ['unknown component',p=>surface(p).components[1].component='ArbitraryReact'],
  ['unknown function',p=>surface(p).components[2].value={'@call':'eval',args:{values:['process.exit()']}}],
  ['unreachable component',p=>surface(p).components.push({id:'orphan',component:'Text',text:'hidden'})],
  ['cycle',p=>surface(p).components[0].children.push('root')],
  ['wrong initial type',p=>surface(p).dataModel.inputs.people='2'],
  ['unbound control',p=>surface(p).components[1].value={'@path':'/inputs/missing'}],
  ['RPC side effect',p=>p.messages.push({version:'1.0',callRendererFunction:{functionCallId:'x',callFunction:{'@call':'pioraSet',catalogId:surface(p).catalogId,args:{input:'people',value:3}}}})],
]) test(`reject ${name} before publication`,()=>{const plan=a2uiUiExample();mutate(plan);assert.throws(()=>compileA2uiUi(plan,{revision:1}));});
test('source and internal calculation projection cannot be altered independently',()=>{
  const s=compileA2uiUi(a2uiUiExample(),{revision:1}).surface;
  s.nodes.find(node=>node.id==='total').value=999;
  assert.throws(()=>validateSurface(s),/projection do not match/);
});
test('known local set buttons validate their target value and reject out-of-range mutations',()=>{
  const plan=a2uiUiExample(),s=surface(plan);
  s.components[0].children.push('set');
  s.components.push({id:'set',component:'Button',child:'setLabel',action:{functionCall:{'@call':'pioraSet',args:{input:'people',value:4}}}},{id:'setLabel',component:'Text',text:'四个人'});
  assert.ok(compileA2uiUi(plan,{revision:1}));
  s.components.find(c=>c.id==='set').action.functionCall.args.value=0;
  assert.throws(()=>compileA2uiUi(plan,{revision:1}));
});
test('mini-app A2UI is compiled to bounded native controls and reloads exactly',()=>{
  const compiled=compileMiniAppPlan(a2uiMiniAppExample());
  assert.deepEqual(compiled.document.events,['next']);
  assert.equal(compiled.plan.document.a2ui.version,'1.0');
  assert.deepEqual(compileMiniAppPlan(compiled.plan),compiled);
  const changed=structuredClone(compiled.plan);changed.document.html+='<p>changed</p>';
  assert.throws(()=>compileMiniAppPlan(changed),/does not match/);
});
test('SVG extensions still reject scripts, external resources and sibling markup',()=>{
  for(const markup of ['<svg><script>alert(1)</script></svg>','<svg><image href="https://example.com/x"/></svg>','<svg></svg><button>extra</button>']) {
    const plan=a2uiExplodedExample();plan.document.messages[0].createSurface.components.find(c=>c.component==='PioraSvg').markup=markup;
    assert.throws(()=>compileMiniAppPlan(plan));
  }
});
test('bike and fan use the same A2UI contract with separate validated geometry',()=>{
  for(const kind of ['bike','fan']) {const compiled=compileMiniAppPlan(a2uiExplodedExample(kind));assert.ok(compiled.document.bindings.length>=8);assert.deepEqual(compiled.document.events,['explode','assemble']);}
});
test('A2UI executable trial, action inspection and checkpoint reload retain results',{timeout:60000},async()=>{
  await prepareMiniAppRuntime();
  for(const plan of [a2uiMiniAppExample(),a2uiExplodedExample('bike'),a2uiExplodedExample('fan')]) {
    const initial=await trialMiniApp(plan);
    const restored=await trialMiniApp(plan,{snapshot:initial.snapshot});
    assert.deepEqual(restored,initial);
    const evidence=await previewMiniAppActions(plan,initial.snapshot);
    assert.ok(evidence);
  }
});
