import assert from 'node:assert/strict';
import test from 'node:test';
import {createJiti} from 'jiti';
import {counterPlan} from './mini-app-fixtures.mjs';
const {MiniAppController}=await createJiti(import.meta.url).import('./mini-app/controller.ts');
const result=request=>({snapshot:{...request.snapshot,state:{count:request.snapshot.inputs.start}},
  frame:{summary:'Count: '+request.snapshot.inputs.start,bindings:{count:request.snapshot.inputs.start},playback:{finished:false}}});
const turn=()=>new Promise(done=>setImmediate(done));

test('reset acknowledges only edits cancelled at its boundary, never newer queued typing',async()=>{
  // Scheduling unit fixture: a deferred Worker reply exposes the exact race.
  // Browser tests separately cover real native controls and actual QuickJS.
  const host=new MiniAppController(counterPlan(),{onChange(){},onStatus(){},onError(error){throw error;}});
  host.current=result({snapshot:{inputs:{start:2},state:{count:2},tick:0,rng:42}});
  const pending=[],frames=[];
  host.worker={run:request=>new Promise(resolve=>pending.push({request,resolve}))};
  host.frame={render:(frame,inputs,identity)=>frames.push({inputs:{...inputs},ack:identity.ack})};
  host.interact({type:'input',id:'start',value:7,serial:1});
  host.interact({type:'input',id:'start',value:8,serial:2});
  host.reset();
  host.interact({type:'input',id:'start',value:9,serial:3});
  assert.equal(pending.length,1);
  pending[0].resolve(result(pending[0].request));await turn();
  assert.equal(pending[1].request.command,'init');
  pending[1].resolve(result(pending[1].request));await turn();
  assert.deepEqual(frames,[{inputs:{start:7},ack:1},{inputs:{start:7},ack:2}], 'Newer input serial 3 is still pending when reset projects');
  pending[2].resolve(result(pending[2].request));await turn();
  assert.deepEqual(frames.at(-1),{inputs:{start:9},ack:3});assert.equal(host.snapshot.inputs.start,9);
  host.interact({type:'input',id:'start',value:4,serial:2});await turn();
  assert.equal(pending.length,3,'A duplicate or late serial cannot replay an earlier value');
});
