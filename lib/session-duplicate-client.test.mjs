import assert from 'node:assert/strict';
import test from 'node:test';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url);
const {requestSessionDuplication}=await jiti.import('./session-duplicate-client.ts');
const {registerAnswerStateWriter}=await jiti.import('./answer-output-client.ts');

test('duplication waits for the source checkpoint acknowledgement and ignores another session',async t=>{
  let acknowledge;const events=[];
  t.after(registerAnswerStateWriter('copy-source','source',()=>new Promise(resolve=>{events.push('save');acknowledge=resolve;})));
  t.after(registerAnswerStateWriter('copy-other','other',async()=>{throw new Error('Unrelated pending state');}));
  t.mock.method(globalThis,'fetch',async(url,options)=>{events.push('copy');assert.equal(url,'/api/sessions/source/duplicate');assert.equal(options.method,'POST');return Response.json({newSessionId:'copy'});});
  const pending=requestSessionDuplication('source');await Promise.resolve();assert.deepEqual(events,['save']);
  acknowledge();await pending;assert.deepEqual(events,['save','copy']);
});

test('a failed checkpoint prevents duplication, and retry can proceed without discarding it',async t=>{
  let unavailable=true,copies=0;
  t.after(registerAnswerStateWriter('copy-retry','source',async()=>{if(unavailable)throw new Error('Checkpoint unavailable');}));
  t.mock.method(globalThis,'fetch',async()=>{copies++;return Response.json({newSessionId:'copy'});});
  await assert.rejects(requestSessionDuplication('source'),/Checkpoint unavailable/);assert.equal(copies,0);
  unavailable=false;await requestSessionDuplication('source');assert.equal(copies,1);
});

test('duplication exposes server failures so the UI can report them',async t=>{
  t.mock.method(globalThis,'fetch',async()=>Response.json({error:'Source is busy'},{status:409}));
  await assert.rejects(requestSessionDuplication('source'),/Source is busy/);
});
