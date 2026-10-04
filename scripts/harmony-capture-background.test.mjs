import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function deferred() { let resolve, reject; const promise=new Promise((yes,no)=>{resolve=yes;reject=no;}); return {promise,resolve,reject}; }
async function fixture() {
  const source=await readFile(new URL('../third_party/harmony-mirror/entry/src/main/ets/CaptureBackground.ets',import.meta.url),'utf8');
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
  const timers=new Map(), listeners=new Map(), starts=[], releases=[], storage=new Map();
  const pendingStarts=[], pendingAgents=[];
  let now=0, timerId=0, started=false, nativeStops=0;
  const manager={
    on:(event,callback)=>listeners.set(event,callback), off:event=>listeners.delete(event),
    BackgroundTaskMode:{MODE_AV_PLAYBACK_AND_RECORD:12}, BackgroundTaskSubmode:{SUBMODE_SCREEN_RECORD_NORMAL_NOTIFICATION:7},
    ContinuousTaskRequest:class {},
    async startBackgroundRunning(context,request){starts.push({context,request});return pendingStarts.length?pendingStarts.shift().promise:{continuousTaskId:starts.length};},
    async stopBackgroundRunning(context,id){releases.push({context,id});}
  };
  const modules={
    '@kit.AbilityKit':{wantAgent:{OperationType:{START_ABILITY:0},WantAgentFlags:{UPDATE_PRESENT_FLAG:0},async getWantAgent(){return pendingAgents.length?pendingAgents.shift().promise:{};}}},
    '@kit.BackgroundTasksKit':{backgroundTaskManager:manager}, '@kit.PerformanceAnalysisKit':{hilog:{info(){},error(){}}},
    'libscrcpy_capture.so':{isCaptureStarted:()=>started,stopCapture:()=>{nativeStops++;started=false;}},
  };
  const context={exports:{},require:name=>{assert.ok(modules[name],name);return modules[name];},
    Date:{now:()=>now},setTimeout:(callback,delay)=>{const id=++timerId;timers.set(id,{callback,at:now+delay});return id;},clearTimeout:id=>timers.delete(id),
    AppStorage:{set:(key,value)=>storage.set(key,value),setOrCreate:(key,value)=>storage.set(key,value)}};
  vm.runInNewContext(compiled,context);
  const controller=context.exports.captureBackground, ability={owned:true};controller.bind(ability);
  const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
  return {controller,ability,starts,releases,listeners,pendingStarts,pendingAgents,timers,storage,
    set started(value){started=value;},get nativeStops(){return nativeStops;},flush,
    async advance(ms){now+=ms;for(const[id,timer]of[...timers])if(timer.at<=now){timers.delete(id);timer.callback();}await flush();}};
}

test('a record task waits for real STARTED and native termination releases its exact id',async()=>{
  const f=await fixture();f.controller.request();await f.advance(500);assert.equal(f.starts.length,0);
  f.started=true;await f.advance(500);assert.equal(f.starts.length,1);
  assert.equal(f.starts[0].request.backgroundTaskModes[0],12);assert.equal(f.starts[0].request.backgroundTaskSubmodes[0],7);
  f.started=false;await f.advance(500);assert.equal(f.releases[0].id,1);assert.equal(f.timers.size,0);
  assert.equal(f.storage.get('mirrorCaptureRequested'),false);
});

test('stop during want-agent creation never starts a task or touches a newer capture',async()=>{
  const f=await fixture(), wait=deferred();f.pendingAgents.push(wait);f.started=true;
  f.controller.request();await f.advance(500);f.controller.stop();wait.resolve({});await f.flush();
  assert.equal(f.starts.length,0);assert.equal(f.nativeStops,0);assert.equal(f.timers.size,0);
});

test('a stale start result releases the old id after a newer request owns another task',async()=>{
  const f=await fixture(), old=deferred();f.pendingStarts.push(old);f.started=true;
  f.controller.request();await f.advance(500);f.controller.request();await f.advance(500);
  assert.equal(f.starts.length,2);old.resolve({continuousTaskId:71});await f.flush();
  assert.deepEqual(f.releases.map(value=>value.id),[71]);assert.equal(f.nativeStops,0);
  f.controller.stop();await f.flush();assert.deepEqual(f.releases.map(value=>value.id),[71,2]);
});

test('a task returned after ability disposal is released using its captured old context',async()=>{
  const f=await fixture(), old=deferred();f.pendingStarts.push(old);f.started=true;
  f.controller.request();await f.advance(500);f.controller.dispose();old.resolve({continuousTaskId:18});await f.flush();
  assert.equal(f.releases[0].context,f.ability);assert.equal(f.releases[0].id,18);
  assert.equal(f.listeners.size,0);assert.equal(f.timers.size,0);
});

test('owned system cancellation stops capture without an automatic request; other ids are ignored',async()=>{
  const f=await fixture();f.started=true;f.controller.request();await f.advance(500);
  const cancel=f.listeners.get('continuousTaskCancel');cancel({id:99});assert.equal(f.nativeStops,0);
  cancel({id:1});await f.advance(5000);assert.equal(f.nativeStops,1);assert.equal(f.starts.length,1);
  assert.equal(f.storage.get('mirrorCaptureRequested'),false);assert.equal(f.timers.size,0);
});

test('system cancellation before its start promise settles cannot leave a capture running',async()=>{
  const f=await fixture(), pending=deferred();f.pendingStarts.push(pending);f.started=true;
  f.controller.request();await f.advance(500);f.listeners.get('continuousTaskCancel')({id:83});
  pending.resolve({continuousTaskId:83});await f.flush();assert.equal(f.nativeStops,1);assert.equal(f.releases[0].id,83);
  assert.equal(f.timers.size,0);
});

test('owned suspension and task rejection stop capture and do not retry',async()=>{
  const f=await fixture();f.started=true;f.controller.request();await f.advance(500);
  f.listeners.get('continuousTaskSuspend')({continuousTaskId:1,suspendState:true});await f.flush();assert.equal(f.nativeStops,1);
  const rejected=deferred();f.pendingStarts.push(rejected);f.started=true;f.controller.request();await f.advance(500);
  rejected.reject({code:201});await f.flush();await f.advance(5000);assert.equal(f.nativeStops,2);assert.equal(f.starts.length,2);
  assert.match(f.storage.get('mirrorStatus'),/无法保持后台录屏/);
});

test('an unfinished consent expires without ever starting a background task',async()=>{
  const f=await fixture();f.controller.request();await f.advance(30000);
  assert.equal(f.starts.length,0);assert.equal(f.nativeStops,1);assert.equal(f.timers.size,0);
});

test('native termination while awaiting a task result releases it and clears the request',async()=>{
  const f=await fixture(), pending=deferred();f.pendingStarts.push(pending);f.started=true;
  f.controller.request();await f.advance(500);f.started=false;pending.resolve({continuousTaskId:27});await f.flush();
  assert.equal(f.releases[0].id,27);assert.equal(f.nativeStops,1);assert.equal(f.storage.get('mirrorCaptureRequested'),false);
  assert.equal(f.timers.size,0);
});
