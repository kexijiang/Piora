import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createJiti } from 'jiti';

const { MiniAppVm } = await createJiti(import.meta.url).import('./mini-app/vm.ts');
const wasm = readFileSync(createRequire(import.meta.url).resolve('quickjs-wasi/quickjs.wasm'));
const snapshot = { inputs: {}, state: { count: 42 }, tick: 17, rng: 77 };
const program = `
function init(inputs, ctx) { throw new Error('Restore must not initialize business state'); }
function reduce(state, event, ctx) { return state; }
function advance(state, dt, ctx) { return state; }
function project(state, inputs, ctx) {
  let sum = 0; for (let i = 0; i < 10000; i++) sum += i;
  return {summary:'Count: '+state.count, bindings:{sum:sum}};
}`;

test('cold checkpoint projection has bounded startup time without reinitializing progress; subsequent projections keep the operation limit', async () => {
  let clock = 0, armed = false;
  // A deterministic slow execution clock models cold-start overhead without
  // relying on workstation load. Real QuickJS still performs the projection.
  const vm = await MiniAppVm.create(wasm, program, () => armed ? clock += 10 : 0);
  armed = true;
  try {
    const result = vm.run({ command: 'project', snapshot });
    assert.deepEqual(result.snapshot, snapshot);
    assert.equal(result.frame.summary, 'Count: 42');
    assert.equal(result.frame.bindings.sum, 49_995_000);
    assert.throws(() => vm.run({ command: 'project', snapshot }), error => error.code === 'TIME_LIMIT');
    assert.throws(() => vm.run({ command: 'project', snapshot }), error => error.code === 'TIME_LIMIT');
  } finally { vm.dispose(); }
});

test('the cold projection allowance still interrupts an infinite program and does not renew after failure', async () => {
  let clock = 0, armed = false;
  const source = program.replace('let sum = 0; for (let i = 0; i < 10000; i++) sum += i;', 'let sum=0; while (true) { sum++; }');
  const vm = await MiniAppVm.create(wasm, source, () => armed ? clock += 10 : 0);
  armed = true;
  try {
    assert.throws(() => vm.run({ command: 'project', snapshot }), error => error.code === 'TIME_LIMIT');
    const firstElapsed = clock;
    assert.ok(firstElapsed <= 240, 'startup remains bounded');
    // Move outside the CPU accounting window; only the per-operation budget remains.
    clock += 2000; const retryStarted = clock;
    assert.throws(() => vm.run({ command: 'project', snapshot }), error => error.code === 'TIME_LIMIT');
    assert.ok(clock - retryStarted < 100, 'failed startup cannot renew its larger allowance');
  } finally { vm.dispose(); }
});

test('restoration releases held input and projects within one bounded startup operation', async()=>{
  let clock=0,armed=false;
  const source=program.replace('return state;','return {...state,held:false,restores:state.restores+1};');
  const saved={...snapshot,state:{count:42,held:true,restores:0},view:{version:1,cameras:{view:{reset:0,camera:{position:[4,3,5],target:[0,0,0],fov:45}}}}};
  const vm=await MiniAppVm.create(wasm,source,()=>armed?clock+=10:0);armed=true;
  try{
    const restored=vm.run({command:'restore',snapshot:saved,event:{type:'click',id:'injected'}});
    assert.deepEqual(restored.snapshot,{...saved,state:{count:42,held:false,restores:1}});
    assert.equal(restored.frame.summary,'Count: 42');assert.equal(restored.frame.bindings.sum,49_995_000);
    assert.throws(()=>vm.run({command:'restore',snapshot:restored.snapshot}),error=>error.code==='TIME_LIMIT','another restore cannot renew startup time');
  }finally{vm.dispose();}
});

test('restoration delivers only host-owned blur and keeps cleanup loops bounded',async()=>{
  const source=program.replace('return state;',"if(event.type!=='blur')throw new Error('Wrong restore event'); return state;");
  const vm=await MiniAppVm.create(wasm,source);
  try{assert.deepEqual(vm.run({command:'restore',snapshot,event:{type:'click'}}).snapshot,snapshot);}finally{vm.dispose();}
  let clock=0,armed=false;
  const looping=await MiniAppVm.create(wasm,program.replace('return state;','while(true){}'),()=>armed?clock+=10:0);armed=true;
  try{assert.throws(()=>looping.run({command:'restore',snapshot}),error=>error.code==='TIME_LIMIT');assert.ok(clock<=240);}finally{looping.dispose();}
});
