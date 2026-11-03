import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url);
const {MiniAppEnvironmentStore}=await jiti.import('./mini-app/environment-store.ts');
const {MINI_APP_RENDERER_PROTOCOL,MINI_APP_ENVIRONMENT_TTL:ttl,validateMiniAppEnvironmentReport}=await jiti.import('./mini-app/environment-protocol.ts');
const digest='a'.repeat(64),other='b'.repeat(64);
const report=(overrides={})=>({protocol:MINI_APP_RENDERER_PROTOCOL,webgl:true,instance:'window-a-12345678',epoch:1,sequence:1,rendererDigest:digest,...overrides});
const run=(overrides={})=>({sessionId:'session-a',runId:'run-a',source:'ui',submissionId:'submission-a',...overrides});

test('environment protocol accepts only versioned bounded host data, not capabilities or generated flags',()=>{
  assert.deepEqual(validateMiniAppEnvironmentReport(report()),report());
  for(const change of [{webgl:'true'},{protocol:'old'},{epoch:0},{sequence:1.5},{rendererDigest:'bad'},{capabilities:['scene3d']},{instance:'short'}])assert.throws(()=>validateMiniAppEnvironmentReport(report(change)));
});
test('availability is bound to the originating session and submission; no report or late reports cannot upgrade a running task',()=>{
  const store=new MiniAppEnvironmentStore(()=>100);
  store.prepare('session-a','submission-a',report(),digest);store.bind(run());assert.equal(store.webgl(run(),digest),true);
  assert.equal(store.webgl(run({sessionId:'other'}),digest),false);assert.equal(store.webgl(undefined,digest),false);
  const late=run({runId:'late',submissionId:'late'});store.bind(late);store.prepare('session-a','late',report({sequence:2}),digest);store.bind(late);assert.equal(store.webgl(late,digest),false);
  const remote=run({runId:'remote',source:'scheduler'});store.bind(remote);assert.equal(store.webgl(remote,digest),false);
  store.release(run());assert.equal(store.webgl(run(),digest),false);
});
test('another window cannot replace a pending submission, and new epochs revoke already captured instances',()=>{
  const store=new MiniAppEnvironmentStore(()=>100);
  store.prepare('session-a','submission-a',report(),digest);
  assert.throws(()=>store.prepare('session-a','submission-a',report({instance:'window-b-12345678'}),digest));
  store.bind(run());assert.equal(store.webgl(run(),digest),true);
  store.report(report({epoch:2,sequence:2}),digest);assert.equal(store.webgl(run(),digest),false);
  assert.throws(()=>store.report(report({epoch:1,sequence:3}),digest));
});
test('heartbeats extend only the same resource epoch; expiry, source changes and close tombstones cannot resurrect old runs',()=>{
  let now=0;const store=new MiniAppEnvironmentStore(()=>now);
  store.prepare('session-a','submission-a',report(),digest);store.bind(run());now=ttl-1_000;
  store.report(report({sequence:2}),digest);now=ttl+1_000;assert.equal(store.webgl(run(),digest),true);assert.equal(store.webgl(run(),other),false);
  assert.throws(()=>store.report(report({sequence:3,rendererDigest:other}),other));
  now=ttl*2;assert.equal(store.webgl(run(),digest),false);
  store.report(report({sequence:4}),digest);assert.equal(store.webgl(run(),digest),false,'new lease cannot restore an expired reference');
  store.prepare('session-a','new',report({sequence:5}),digest);const next=run({runId:'next',submissionId:'new'});store.bind(next);assert.equal(store.webgl(next,digest),true);
  store.revoke('window-a-12345678',2,6);assert.equal(store.webgl(next,digest),false);
  assert.throws(()=>store.report(report({sequence:7}),digest));assert.throws(()=>store.report(report({epoch:2,sequence:7}),digest));
});
test('missing WebGL, invalid submission metadata and bounded registry pressure never grant a capability or block ordinary runs',()=>{
  const store=new MiniAppEnvironmentStore(()=>0);store.prepare('session-a','submission-a',report({webgl:false}),digest);store.bind(run());assert.equal(store.webgl(run(),digest),false);
  assert.doesNotThrow(()=>store.bind(run({runId:'old-format',submissionId:'older key with spaces'})));
  for(let i=0;i<300;i++)store.bind(run({runId:'many-'+i,submissionId:'none-'+i}));
  assert.equal(store.webgl(run(),digest),false);
});
