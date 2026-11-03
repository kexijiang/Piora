import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {prepareMiniAppRuntime} from '../scripts/prepare-mini-app-runtime.mjs';
import {actionRouteFixture,route,waitFor} from './mini-app-action-route-fixtures.mjs';
await prepareMiniAppRuntime(join(import.meta.dirname,'..'));
test('mini app uses the real wrapper permission gate and consumes one approval once',async t=>{
 const f=await actionRouteFixture(t);assert.equal((await f.post(f.start)).status,202);
 const pending=(await waitFor(f.get,v=>v.operations[0]?.approval)).operations[0];assert.equal(existsSync(join(f.root,'report.json')),false);
 assert.equal((await f.post({command:'approve',operationId:'click',approvalId:'wrong'})).status,409);
 f.manager.appendSessionInfo('Automatic title');
 const approval={command:'approve',operationId:'click',approvalId:pending.approval.id};
 const responses=await Promise.all([f.post(approval),f.post(approval)]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
 await waitFor(f.get,v=>v.operations[0]?.status==='completed');await waitFor(()=>f.wrapper.isRunning(),v=>!v);
 assert.equal(JSON.parse(readFileSync(join(f.root,'report.json'),'utf8')).checkpoint.state.count,19);
 assert.equal((await(await f.post(f.start)).json()).status,'completed');assert.equal((await f.get()).operations.length,1);
});
test('route blocks cross origin, arbitrary file paths, unavailable write capability and disabled Beta',async t=>{
 const f=await actionRouteFixture(t);
 assert.equal((await route.POST(f.request(f.start,'https://outside.test'),f.context)).status,403);
 assert.equal((await f.post({...f.start,path:'../outside.json'})).status,400);
 f.setActive(['read','piora_render_mini_app']);assert.equal((await f.post(f.start)).status,202);
 await waitFor(f.get,v=>v.operations[0]?.status==='failed');await waitFor(()=>f.wrapper.isRunning(),v=>!v);
 assert.equal(existsSync(join(f.root,'report.json')),false);f.setBeta(false);
 assert.equal((await f.post({...f.start,requestId:'other'})).status,403);
});
test('a changed checkpoint revokes pending approval and leaves no file',async t=>{
 const f=await actionRouteFixture(t);assert.equal((await f.post(f.start)).status,202);
 const pending=(await waitFor(f.get,v=>v.operations[0]?.approval)).operations[0];
 await f.save({...f.source.result.snapshot,state:{count:20}});
 assert.equal((await f.post({command:'approve',operationId:'click',approvalId:pending.approval.id})).status,409);
 await waitFor(()=>f.wrapper.isRunning(),v=>!v);assert.equal(existsSync(join(f.root,'report.json')),false);
 assert.ok(['cancelled','failed'].includes((await f.get()).operations[0].status));
});
test('parameter read follows existing permissions and leaves progress unchanged until explicit apply',async t=>{
 const f=await actionRouteFixture(t);writeFileSync(join(f.root,'parameters.json'),'{"start":8}');
 assert.equal((await f.post({...f.start,actionId:'read'})).status,202);
 const pending=(await waitFor(f.get,v=>v.operations[0]?.approval||v.operations[0]?.status==='completed')).operations[0];
 if(pending.approval)assert.equal((await f.post({command:'approve',operationId:'click',approvalId:pending.approval.id})).status,200);
 await waitFor(f.get,v=>v.operations[0]?.status==='completed');await waitFor(()=>f.wrapper.isRunning(),v=>!v);
 assert.equal((await f.read()).result.snapshot.state.count,19);
 assert.equal((await f.post({command:'apply',operationId:'click'})).status,200);
 const after=(await f.read()).result.snapshot;assert.equal(after.state.count,27);assert.equal(after.tick,13);assert.equal(after.rng,12345);
 assert.equal((await(await f.post({command:'apply',operationId:'click'})).json()).alreadyApplied,true);
});
