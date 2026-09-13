import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const {RemoteDiscoveryLease}=await createJiti(import.meta.url).import("./remote-discovery.ts");
const discovery=await createJiti(import.meta.url).import("./remote-discovery.ts");
const serverId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
test("runtime startup shares a process registration and unregisters its own lease",async()=>{
 const root=mkdtempSync(join(tmpdir(),"piora-discovery-start-"));const keys=["PORT","PIORA_DISCOVERY_DIR","PIORA_REMOTE_CONTROL_ROOT","PIORA_DISCOVERY_DISABLED"];const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));let lease;
 try{
  Object.assign(process.env,{PORT:"30142",PIORA_DISCOVERY_DIR:join(root,"services"),PIORA_REMOTE_CONTROL_ROOT:join(root,"remote"),PIORA_DISCOVERY_DISABLED:"0"});
  assert.equal(typeof discovery.startRemoteDiscovery,"function");const results=await Promise.all([discovery.startRemoteDiscovery(),discovery.startRemoteDiscovery()]);lease=results[0];assert.equal(lease,results[1]);assert.equal(existsSync(lease.path),true);lease.stop();assert.equal(existsSync(lease.path),false);
 }finally{lease?.stop();delete globalThis.__pioraRemoteDiscovery;for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}}
});
test("discovery leases publish only bounded public identity and renew independently",()=>{
 const root=join(mkdtempSync(join(tmpdir(),"piora-discovery-")),"services");let now=100000;
 const first=new RemoteDiscoveryLease({root,serverId,port:30142,now:()=>now,token:"never-publish"});const second=new RemoteDiscoveryLease({root,serverId,port:30143,now:()=>now});
 first.publish();second.publish();assert.equal(existsSync(first.path),true);assert.notEqual(first.path,second.path);
 const record=JSON.parse(readFileSync(first.path,"utf8"));assert.deepEqual(Object.keys(record).sort(),["version","protocol","serverId","instanceId","pid","address","updatedAt","expiresAt"].sort());assert.equal(record.address,"http://127.0.0.1:30142/api/remote/v1");assert.equal(record.expiresAt,now+90000);assert.equal(record.serverId,serverId);
 now+=20000;first.publish();assert.equal(JSON.parse(readFileSync(first.path,"utf8")).expiresAt,now+90000);first.stop();assert.equal(existsSync(first.path),false);assert.equal(existsSync(second.path),true);second.stop();
});
test("discovery never advertises arbitrary hosts or follows a linked metadata directory",()=>{
 const root=mkdtempSync(join(tmpdir(),"piora-discovery-guard-"));
 for(const port of [0,65536,NaN])assert.throws(()=>new RemoteDiscoveryLease({root,serverId,port}));
 assert.throws(()=>new RemoteDiscoveryLease({root,serverId,port:80,host:"remote.example"}));
 const outside=join(root,"outside");mkdirSync(outside);const linked=join(root,"linked");symlinkSync(outside,linked,process.platform==="win32"?"junction":"dir");
 assert.throws(()=>new RemoteDiscoveryLease({root:linked,serverId,port:30142}).publish());
});
test("lease shutdown does not remove a registration that is no longer its own",()=>{
 const root=join(mkdtempSync(join(tmpdir(),"piora-discovery-own-")),"services");const lease=new RemoteDiscoveryLease({root,serverId,port:30142});lease.publish();const record=JSON.parse(readFileSync(lease.path,"utf8"));record.instanceId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";writeFileSync(lease.path,JSON.stringify(record));lease.stop();assert.equal(existsSync(lease.path),true);
});
