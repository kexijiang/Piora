import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {join} from 'node:path';
const {validateDevelopmentOnDevice}=await createJiti(import.meta.url).import('./harmony/development/validation-chain.ts');
test('development chain installs a stable artifact and records filtered device evidence',async()=> {
 const root=await mkdtemp(join(tmpdir(),'piora-dev-chain-')),hapPath=join(root,'app.hap'),calls=[];
 await writeFile(hapPath,'first');
 const options={projectRoot:root,hapPath,serial:'phone',leaseToken:'test',bundleName:'com.test.app',steps:[{action:'checkpoint',name:'ready'}]};
 let fingerprint='original',changeAfterSnapshot=true;
 const dependencies={fingerprint:()=>{const current=fingerprint;if(changeAfterSnapshot)fingerprint='changed';return current;},manager:{
  installPackage:async()=>calls.push('install'),launchApp:async()=>calls.push('launch'),runScenario:async()=>({status:'passed',executionId:'fixture'}),
  listProcesses:async()=>[{pid:10,name:'com.test.app'},{pid:20,name:'com.other.app'}],readLogs:async options=>{calls.push(['logs',options.pid]);return [];}
 }};
 try {
  assert.equal((await validateDevelopmentOnDevice(options,dependencies)).status,'incomplete');assert.deepEqual(calls,[]);
  changeAfterSnapshot=false;fingerprint='original';const report=await validateDevelopmentOnDevice(options,dependencies);assert.equal(report.status,'passed');assert.deepEqual(calls,['install','launch',['logs',10]]);
  assert.equal(report.artifactSourceBinding,'user-selected');assert.equal(report.stages[0].stage,'install');
 } finally {await rm(root,{recursive:true,force:true});}
});


test('development reports survive recreation and stay scoped to the selected project', async () => {
 const { DevelopmentReportStore } = await createJiti(import.meta.url).import('./harmony/development/report-store.ts');
 const root = await mkdtemp(join(tmpdir(), 'harmony-development-reports-'));
 try {
  const store = new DevelopmentReportStore(root);
  await store.save({ id: '00000000-0000-4000-8000-000000000001', status: 'incomplete', projectRoot: join(root, 'project-a'), stages: [] });
  await store.save({ id: '00000000-0000-4000-8000-000000000002', status: 'passed', projectRoot: join(root, 'project-b'), stages: [] });
  const records = await new DevelopmentReportStore(root).list(join(root, 'project-a'));
  assert.equal(records.length, 1); assert.equal(records[0].status, 'incomplete'); assert.ok(records[0].savedAt);
  await assert.rejects(store.save({ id: '../escape', projectRoot: root, stages: [] }));
 } finally { await rm(root, {recursive: true, force: true}); }
});
