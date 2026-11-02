import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { QuickJS } from "quickjs-wasi";

const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url);
const { boundedJson } = await jiti.import("./mini-app/json.ts");
const { miniAppProgramFactory } = await jiti.import("./mini-app/program.ts");
const { limitMiniAppWasmMemory } = await jiti.import("./mini-app/wasm-memory.ts");
const { MINI_APP_LIMITS } = await jiti.import("./mini-app/limits.ts");
const wasm = readFileSync(require.resolve("quickjs-wasi/quickjs.wasm"));
const vmPath = fileURLToPath(new URL("./mini-app/vm.ts", import.meta.url));

const program = `
function init(inputs, ctx) { return { total: inputs.start, last: ctx.random() }; }
function reduce(state, event, ctx) { return { total: state.total + event.amount, last: ctx.random() }; }
function advance(state, dt, ctx) { return { total: state.total + dt, last: ctx.random() }; }
function project(state, inputs, ctx) { return { text: { total: String(state.total) }, summary: "Total: " + state.total, tick: ctx.tick }; }
`;
const checkpoint = () => ({ inputs: { start: 4 }, state: null, rng: 123456, tick: 0 });

test("ordinary string parsing supports deterministic regular expressions in the isolated VM", async () => {
  const source = `function init(inputs,ctx){return '6, 2、5 1'.split(/[^0-9]+/).map(Number);}
function reduce(s,e,ctx){return s;} function advance(s,dt,ctx){return s;}
function project(s,inputs,ctx){return {summary:s.join(','),bindings:{count:s.length}};}`;
  const result = await inWorker(source, [{command:'init'}, {command:'project'}]);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.replies[0].snapshot.state, [6, 2, 5, 1]);
  assert.equal(result.replies[1].frame.summary, '6,2,5,1');
});

/** A broken VM interruption must not hang the test runner itself. Node worker != browser coverage. */
function inWorker(source, operations, options = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { createJiti } = require(workerData.jiti);
      (async () => {
        const { MiniAppVm } = await createJiti(workerData.vmPath).import(workerData.vmPath);
        let vm;
        try {
          vm = await MiniAppVm.create(new Uint8Array(workerData.wasm), workerData.source,
            workerData.serializationFixtureClock ? () => 0 : undefined);
          let snapshot = workerData.snapshot;
          const replies = [];
          for (const operation of workerData.operations) {
            const reply = vm.run({ ...operation, snapshot });
            snapshot = reply.snapshot; replies.push(reply);
          }
          parentPort.postMessage({ replies, memory: vm.memoryUsage() });
        } catch (error) { parentPort.postMessage({ error: { code: error.code, message: error.message } }); }
        finally { vm?.dispose(); }
      })().catch(error => parentPort.postMessage({ fatal: String(error) }));
    `, { eval: true, workerData: { jiti: require.resolve("jiti"), vmPath, wasm, source,
      operations, snapshot: options.snapshot ?? checkpoint(), serializationFixtureClock: options.serializationFixtureClock === true } });
    let settled = false;
    const timer = setTimeout(() => { settled = true; void worker.terminate(); reject(new Error("Outer worker watchdog expired")); }, 15_000);
    worker.once("message", result => { settled = true; clearTimeout(timer); void worker.terminate(); if (result.fatal) reject(new Error(result.fatal)); else resolve(result); });
    worker.once("error", error => { clearTimeout(timer); reject(error); });
    worker.once("exit", code => { clearTimeout(timer); if (!settled) reject(new Error(`Worker exited without a result: ${code}`)); });
  });
}

test("bounded JSON rejects non-finite numbers, accessors, sparse arrays, cycles and byte overflow", () => {
  let touched = false;
  const getter = Object.defineProperty({}, "secret", { enumerable: true, get() { touched = true; return "x"; } });
  const cycle = {}; cycle.self = cycle;
  for (const value of [NaN, Infinity, getter, cycle, new Array(5), { toJSON() { touched = true; } }, { value: 2n }]) {
    assert.throws(() => boundedJson(value, 1024));
  }
  assert.equal(touched, false);
  assert.throws(() => boundedJson({ text: "中".repeat(30) }, 60));
  assert.equal(boundedJson({ a: [false, 3, null] }, 1024), '{"a":[false,3,null]}');
});

test("program parser accepts helper functions but rejects module state and wrapper escape", () => {
  assert.match(miniAppProgramFactory(program + "function square(x) { return x*x; }"), /return \{init,reduce,advance,project\}/);
  for (const source of [program + "let counter=0;", program + "globalThis.pwned=true;", program + "function init(){}", program + "async function helper(){}", "}); globalThis.pwned=true; (function(){", "export function init(){}", "function init(){}"])
    assert.throws(() => miniAppProgramFactory(source), error => error.code === "SYNTAX");
});

test("primitive constants are deterministic across operations and restoration, while mutation is rejected", async () => {
  const source='const OFFSET=-2, LABEL="constant", ACTIVE=true, EMPTY=null;'+program
    .replace('state.total + event.amount','state.total + event.amount + OFFSET');
  const run=await inWorker(source,[{command:'init'},{command:'event',event:{amount:3}}]);
  assert.equal(run.error,undefined,JSON.stringify(run));
  assert.equal(run.replies[1].snapshot.state.total,5);
  const restored=await inWorker(source,[{command:'project'},{command:'event',event:{amount:3}}],{snapshot:run.replies[1].snapshot});
  assert.deepEqual(restored.replies[0],run.replies[1]);
  assert.equal(restored.replies[1].snapshot.state.total,6);
  const mutated=await inWorker(source.replace('return { total: inputs.start','OFFSET=8; return { total: inputs.start'),[{command:'init'}]);
  assert.equal(mutated.error?.code,'EXECUTION');
  for(const declaration of ['const x={};','const x=[];','const x=Math.PI;','const x=1+2;','const x=()=>1;','const x=Infinity;','const x=1e400;','const x=/pattern/;','const x=1n;','const {x}={x:1};','let x=2;','var x=2;'])
    assert.throws(()=>miniAppProgramFactory(declaration+program),error=>error.code==='SYNTAX',declaration);
  assert.throws(()=>miniAppProgramFactory('const init=1;function reduce(){} function advance(){} function project(){}'),error=>error.code==='SYNTAX');
});

test("runtime binary has an actual 64 MiB memory maximum before instantiation", async () => {
  const wasmModule = await WebAssembly.compile(limitMiniAppWasmMemory(wasm));
  assert.equal(WebAssembly.Module.imports(wasmModule).some(item => item.kind === "memory"), false);
  // Parse the rewritten memory section independently of the production encoder.
  const data = limitMiniAppWasmMemory(wasm); let cursor = 8;
  const uint = () => { let n = 0, shift = 0, byte; do { byte = data[cursor++]; n |= (byte & 127) << shift; shift += 7; } while (byte & 128); return n; };
  let maximum;
  while (cursor < data.length) { const id = data[cursor++], size = uint(), end = cursor + size; if (id === 5) { assert.equal(uint(), 1); assert.equal(uint(), 1); uint(); maximum = uint(); } cursor = end; }
  assert.equal(maximum * 65536, MINI_APP_LIMITS.wasmBytes);
  const runtime = await QuickJS.create({ wasm: wasmModule });
  try {
    const memory = runtime._getMemory();
    assert.throws(() => memory.grow(maximum + 1 - memory.buffer.byteLength / 65536), RangeError,
      "The engine must refuse growth beyond the rewritten maximum");
  } finally { runtime.dispose(); }
  assert.throws(() => limitMiniAppWasmMemory(new Uint8Array([0,1,2])), error => error.code === "RUNTIME");
});

test("real QuickJS runs linked input, state, frame and deterministic random progression", async () => {
  const operations = [{ command: "init" }, { command: "event", event: { amount: 7 } }, { command: "step" }];
  const result = await inWorker(program, operations);
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(result.replies[0].snapshot.state.total, 4);
  assert.equal(result.replies[1].snapshot.state.total, 11);
  assert.equal(result.replies[1].frame.summary, "Total: 11");
  assert.ok(Math.abs(result.replies[2].snapshot.state.total - (11 + 1/30)) < 1e-12);
  assert.equal(result.replies[2].snapshot.tick, 1);
  const replay = await inWorker(program, operations);
  assert.deepEqual(replay.replies, result.replies);
  const restored = await inWorker(program, [{ command: "step" }], { snapshot: result.replies[1].snapshot });
  assert.deepEqual(restored.replies[0], result.replies[2]);
  assert.equal(result.memory.mallocLimit, MINI_APP_LIMITS.heapBytes);
});

test("guest cannot reach host APIs, mutate intrinsics or carry hidden global state", async () => {
  const source = program.replace('return { total: inputs.start, last: ctx.random() };', `
    return { APIs: [typeof process,typeof require,typeof fetch,typeof window,typeof document,typeof Worker,typeof Date,typeof performance,typeof eval,typeof Function,typeof Promise,typeof Proxy].join(',') };
  `).replace('return { text: { total: String(state.total) }, summary: "Total: " + state.total, tick: ctx.tick };', 'return { summary: state.APIs };');
  const result = await inWorker(source, [{ command: "init" }]);
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(result.replies[0].frame.summary, Array(12).fill("undefined").join(","));
  for (const statement of ['globalThis.saved=1;', 'Object.prototype.saved=1;', 'JSON.stringify=()=>"fake";', 'Math.random();']) {
    const bad = program.replace('return { total: inputs.start, last: ctx.random() };', statement + ' return {};');
    const failed = await inWorker(bad, [{ command: "init" }]);
    assert.equal(failed.error?.code, "EXECUTION", statement + JSON.stringify(failed));
  }
});

test("infinite guest loops interrupt and allocation bombs fail without killing the host", async () => {
  const loop = program.replace('return { total: inputs.start, last: ctx.random() };', 'while(true) {}');
  const looping = await inWorker(loop, [{ command: "init" }]);
  assert.equal(looping.error?.code, "TIME_LIMIT", JSON.stringify(looping));
  const bomb = program.replace('return { total: inputs.start, last: ctx.random() };', 'return new Array(100000000).fill(1);');
  const allocating = await inWorker(bomb, [{ command: "init" }]);
  assert.ok(["EXECUTION", "TIME_LIMIT"].includes(allocating.error?.code), JSON.stringify(allocating));
});

test("guest cannot export accessors, huge frames, cyclic data or mutate state while projecting", async () => {
  for (const expression of ['({get summary(){while(true){}}})', '({summary:"x".repeat(200000)})', '(()=>{const x={};x.x=x;return x})()', '(()=>{state.total=99;return {summary:"changed"}})()', '({summary:String(ctx.random())})']) {
    const bad = program.replace('return { text: { total: String(state.total) }, summary: "Total: " + state.total, tick: ctx.tick };', `return ${expression};`);
    const result = await inWorker(bad, [{ command: "init" }]);
    assert.equal(result.error?.code, "EXECUTION", expression + JSON.stringify(result));
  }
});

test('composed replies retain aggregate node, envelope-depth and UTF-8 byte limits',async()=>{
  // Fixed fixture clock isolates serialization bounds from CPU scheduling. The
  // existing interruption tests retain the real clock and outer worker watchdog.
  const source=(state,frame)=>`function nested(n){let v=0;for(let i=0;i<n;i++)v={v:v};return v;}
function init(inputs,ctx){return ${state};}function reduce(s,e,c){return s;}function advance(s,d,c){return s;}
function project(s,i,c){return ${frame};}`;
  const cases=[
    {state:'new Array(9000).fill(0)',frame:'{summary:"ok",values:new Array(9000).fill(0)}',valid:true},
    {state:'new Array(10000).fill(0)',frame:'{summary:"over nodes",values:new Array(10000).fill(0)}',valid:false},
    {state:'nested(22)',frame:'{summary:"ok"}',valid:true},
    {state:'nested(23)',frame:'{summary:"over state depth"}',valid:false},
    {state:'0',frame:'{summary:"ok",tree:nested(22)}',valid:true},
    {state:'0',frame:'{summary:"over frame depth",tree:nested(23)}',valid:false},
    {state:'0',frame:'{summary:"图😀".repeat(15000)}',valid:true},
    {state:'0',frame:'{summary:"图😀".repeat(19000)}',valid:false},
    {state:'"s".repeat(200000)',frame:'{summary:"f".repeat(60000)}',inputLength:260000,valid:true},
    {state:'"s".repeat(200000)',frame:'{summary:"f".repeat(60000)}',inputLength:270000,valid:false},
    {state:'"s".repeat(250000)',frame:'{summary:"f".repeat(120000)}',manyInputNodes:15000,valid:false},
  ];
  for(const [index,fixture] of cases.entries()){
    const result=await inWorker(source(fixture.state,fixture.frame),[{command:'init'}],{
      serializationFixtureClock:true,snapshot:{...checkpoint(),inputs:fixture.manyInputNodes?{values:Array(fixture.manyInputNodes).fill(0)}:{text:'i'.repeat(fixture.inputLength??1)}},
    });
    if(fixture.valid)assert.equal(result.error,undefined,`fixture ${index}: ${JSON.stringify(result.error)}`);
    else assert.equal(result.error?.code,'EXECUTION',`fixture ${index}: ${JSON.stringify(result.error)}`);
  }
});
