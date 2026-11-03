import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createJiti} from 'jiti';
import {counterPlan} from './mini-app-fixtures.mjs';
import {prepareMiniAppRuntime} from '../scripts/prepare-mini-app-runtime.mjs';
const jiti=createJiti(import.meta.url);
const {compileMiniAppPlan,validateMiniAppResult}=await jiti.import('./mini-app/plan.ts');
const {miniAppEventRequest}=await jiti.import('./mini-app/events.ts');
const {MiniAppVm}=await jiti.import('./mini-app/vm.ts');
const {trialMiniApp}=await jiti.import('./mini-app/server-trial.ts');
const {requiredMiniAppCapabilities,assertMiniAppCapabilities}=await jiti.import('./mini-app/capabilities.ts');
const {miniAppEnvironmentContext}=await jiti.import('./mini-app/decision-policy.ts');
const {MINI_APP_CAPABILITIES}=await jiti.import('./mini-app/capability-manifest.ts');
const wasm=readFileSync(createRequire(import.meta.url).resolve('quickjs-wasi/quickjs.wasm'));
await prepareMiniAppRuntime();
function planFixture(){
 const plan=counterPlan();
 plan.inputs.push({id:'ceiling',label:'Ceiling',meaning:'Upper bound for the chosen start',type:'number',value:5,min:0,max:20,step:1});
 plan.inputPresets=[{id:'example',label:'Example bounds',values:{ceiling:10,start:8}}];
 plan.document.html=plan.document.html.replace('</section>','<input data-input="ceiling"><button data-preset="example">Wrong markup label</button></section>');
 plan.document.css+='button[data-preset]{padding:8px}';
 plan.program=plan.program.replace("return {count:event.type==='input'?ctx.inputs.start:event.type==='click'?state.count+1:state.count};",
  "if(event.type==='input'){if(ctx.inputs.start>ctx.inputs.ceiling)throw new Error('partial-input-set');return {count:(state.count%100)*10+(event.id==='start'?1:2)};}return state;");
 return plan;
}

test('presets select a capability/version and bind labels while old plans keep their original identity',()=>{
 const compiled=compileMiniAppPlan(planFixture());assert.equal(compiled.runtimeVersion,'mini-app-1.6');
 assert.equal(compileMiniAppPlan(counterPlan()).runtimeVersion,'mini-app-1.1');
 assert.ok(requiredMiniAppCapabilities(compiled).includes('inputPresets'));
 assert.throws(()=>assertMiniAppCapabilities(compiled,{capabilities:requiredMiniAppCapabilities(compiled).map(id=>({id,available:id!=='inputPresets'}))}),error=>error.path==='capabilities/inputPresets');
 const button=compiled.document.nodes[0].children.find(node=>node.attrs?.['data-preset']);
 assert.equal(button.attrs.type,'button');assert.equal(button.attrs['aria-label'],'Example bounds');assert.deepEqual(button.children,[{type:'text',text:'Example bounds'}]);
 assert.deepEqual(Object.keys(compiled.plan.inputPresets[0].values),['start','ceiling']);
});

test('preset declarations reject unknown or invalid values and require one unambiguous button',()=>{
 for(const mutate of [
   p=>p.inputPresets[0].values.unknown=1,p=>p.inputPresets[0].values.start=21,p=>p.inputPresets[0].values.start='8',
   p=>p.inputPresets[0].values={},p=>p.inputPresets.push(structuredClone(p.inputPresets[0])),p=>p.inputPresets=[],
   p=>p.document.html=p.document.html.replace('data-preset="example"','data-preset="missing"'),
   p=>p.document.html=p.document.html.replace('data-preset="example"','data-preset="example" data-event="other"'),
   p=>p.document.html=p.document.html.replace('Wrong markup label','<b>Nested label</b>'),
   p=>p.document.html+='<button data-preset="example"></button>',p=>p.document.html=p.document.html.replace('data-preset="example"',''),
 ]){const plan=planFixture();mutate(plan);assert.throws(()=>compileMiniAppPlan(plan));}
 const excessive=planFixture();excessive.inputPresets=Array.from({length:17},(_,i)=>({id:`p${i}`,label:'Preset',values:{start:1}}));assert.throws(()=>compileMiniAppPlan(excessive));
});

test('one preset transaction gives every input reducer the complete values in declaration order and preserves clocks',async t=>{
 const compiled=compileMiniAppPlan(planFixture()),vm=await MiniAppVm.create(wasm,compiled.plan.program);t.after(()=>vm.dispose());
 const initial=validateMiniAppResult(compiled,vm.run({command:'init',snapshot:{inputs:compiled.initialInputs,state:null,tick:17,rng:77}}));
 const event={type:'input-preset',id:'example'},request=miniAppEventRequest(compiled,initial.snapshot,event,initial.frame);
 assert.deepEqual(initial.snapshot.inputs,{start:2,ceiling:5});
 const result=validateMiniAppResult(compiled,vm.run(request));
 assert.deepEqual(result.snapshot.inputs,{start:8,ceiling:10});assert.equal(result.snapshot.state.count,212);
 assert.equal(result.snapshot.tick,17);assert.equal(result.snapshot.rng,77);
 for(const forged of [{...event,values:{start:999}},{...event,id:'unknown'},{...event,type:'click'}])assert.throws(()=>miniAppEventRequest(compiled,initial.snapshot,forged,initial.frame));
});

test('all declared presets are trialed before publication but historical checkpoint reads remain unchanged',async()=>{
 const plan=planFixture(),initial=await trialMiniApp(plan);assert.equal(initial.snapshot.state.count,2);assert.deepEqual(initial.snapshot.inputs,{start:2,ceiling:5});
 const bad=structuredClone(plan);bad.inputPresets[0].values.ceiling=6;
 await assert.rejects(trialMiniApp(bad),error=>/Trial input preset example/.test(error.message)&&error.code==='EXECUTION');
 assert.deepEqual((await trialMiniApp(bad,{snapshot:initial.snapshot})).snapshot,initial.snapshot);
});

test('partial presets preserve current omitted values and retain native boolean, text and option types',async t=>{
 const plan=counterPlan();
 plan.inputs.push({id:'enabled',label:'Enabled',meaning:'Flag',type:'checkbox',value:false},
  {id:'note',label:'Note',meaning:'User text',type:'text',value:'before',maxLength:20},
  {id:'mode',label:'Mode',meaning:'Option',type:'select',value:'a',options:[{value:'a',label:'A'},{value:'b',label:'B'}]});
 plan.document.html+='<input data-input="enabled"><input data-input="note"><select data-input="mode"></select><button data-preset="choice"></button>';
 plan.inputPresets=[{id:'choice',label:'Choose example',values:{enabled:true,note:'after',mode:'b'}}];
 const compiled=compileMiniAppPlan(plan),vm=await MiniAppVm.create(wasm,compiled.plan.program);t.after(()=>vm.dispose());
 const initial=validateMiniAppResult(compiled,vm.run({command:'init',snapshot:{inputs:{...compiled.initialInputs,start:7},state:null,tick:3,rng:5}}));
 const result=validateMiniAppResult(compiled,vm.run(miniAppEventRequest(compiled,initial.snapshot,{type:'input-preset',id:'choice'},initial.frame)));
 assert.deepEqual(result.snapshot.inputs,{start:7,enabled:true,note:'after',mode:'b'});
 for(const values of [{enabled:'true'},{note:'x'.repeat(21)},{mode:'missing'}]){const bad=structuredClone(plan);bad.inputPresets[0].values=values;assert.throws(()=>compileMiniAppPlan(bad));}
});

test('a preset never gains an initialization time allowance for its input handlers',async t=>{
 const plan=planFixture();plan.program=plan.program.replace('if(event.type===\'input\'){',"if(event.type==='input'){let work=0;for(let i=0;i<10000;i++)work+=i;");
 let clock=0,armed=false;const vm=await MiniAppVm.create(wasm,plan.program,()=>{if(armed)clock+=2;return clock;});t.after(()=>vm.dispose());
 const compiled=compileMiniAppPlan(plan),initial=validateMiniAppResult(compiled,vm.run({command:'init',snapshot:{inputs:compiled.initialInputs,state:null,rng:1,tick:0}}));
 const request=miniAppEventRequest(compiled,initial.snapshot,{type:'input-preset',id:'example'},initial.frame);armed=true;
 assert.throws(()=>vm.run(request),error=>error.code==='TIME_LIMIT');assert.ok(clock<200);
});

test('preset guidance follows capability availability even without a 3D window',()=>{
 const snapshot={manifestVersion:1,development:false,capabilities:MINI_APP_CAPABILITIES.map(cap=>({id:cap.id,available:cap.implementation==='implemented'&&cap.environment!=='webgl'}))};
 assert.match(miniAppEnvironmentContext(snapshot),/Input presets:.*read-only/);
 snapshot.capabilities.find(cap=>cap.id==='inputPresets').available=false;
 assert.doesNotMatch(miniAppEnvironmentContext(snapshot),/Input presets:/);
});
