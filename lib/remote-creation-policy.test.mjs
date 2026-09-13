import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,realpathSync,symlinkSync,readFileSync,writeFileSync,rmSync,renameSync} from "node:fs";
import {join,resolve,dirname,basename} from "node:path";
import {tmpdir} from "node:os";
import test from "node:test";
import {createJiti} from "jiti";

const jiti=createJiti(import.meta.url);const policy=await jiti.import("./remote-creation-policy.ts");const store=await jiti.import("./remote-control-store.ts");
const root=mkdtempSync(join(tmpdir(),"piora-creation-policy-"));const vault=join(root,"vault");const nested=join(vault,"nested");const outside=join(root,"outside");mkdirSync(nested,{recursive:true});mkdirSync(outside);
test.after(()=>{if(dirname(resolve(root))===resolve(tmpdir())&&basename(root).startsWith("piora-creation-policy-"))rmSync(root,{recursive:true,force:true});});

test("notes-only creation accepts canonical descendants but denies agent and sibling directories",()=>{
  const restriction=policy.normalizeRemoteCreationPolicy({allowedPolicies:["notes"],cwdRoots:[vault]});
  assert.equal(policy.resolveRemoteCreationCwd(restriction,"notes",nested),realpathSync(nested));
  assert.throws(()=>policy.resolveRemoteCreationCwd(restriction,"agent",vault));assert.throws(()=>policy.resolveRemoteCreationCwd(restriction,"notes",outside));
});
test("junctions and traversal cannot escape a creation root",()=>{
  const link=join(vault,"escape");symlinkSync(outside,link,process.platform==="win32"?"junction":"dir");
  const restriction=policy.normalizeRemoteCreationPolicy({allowedPolicies:["notes"],cwdRoots:[vault]});
  assert.throws(()=>policy.resolveRemoteCreationCwd(restriction,"notes",link));assert.throws(()=>policy.resolveRemoteCreationCwd(restriction,"notes",join(vault,"..","outside")));
});
test("an empty root list denies all new sessions and malformed restrictions fail closed",()=>{
  assert.throws(()=>policy.resolveRemoteCreationCwd({allowedPolicies:["notes"],cwdRoots:[]},"notes",vault));
  for(const invalid of [null,{allowedPolicies:["other"],cwdRoots:[vault]},{allowedPolicies:["notes"],cwdRoots:["relative"]},{allowedPolicies:"notes",cwdRoots:[vault]}])assert.throws(()=>policy.normalizeRemoteCreationPolicy(invalid));
});
test("new creation tokens default to notes-only with no implicitly allowed filesystem root",async()=>{
  const path=join(root,"default-tokens.json");const created=await store.createRemoteCapabilityToken({name:"default",scopes:["session.create"]},path);
  assert.deepEqual(created.record.creationPolicy,{allowedPolicies:["notes"],cwdRoots:[]});
});
test("restrictions survive persistence and malformed stored restrictions never become unrestricted",async()=>{
  const path=join(root,"restricted-tokens.json");const created=await store.createRemoteCapabilityToken({name:"restricted",scopes:["session.create"],creationPolicy:{allowedPolicies:["notes"],cwdRoots:[vault]}},path);
  assert.deepEqual(store.authenticateRemoteCapabilityToken(created.token,path).creationPolicy,{allowedPolicies:["notes"],cwdRoots:[realpathSync(vault)]});
  const data=JSON.parse(readFileSync(path,"utf8"));data.tokens[0].creationPolicy={allowedPolicies:["notes"],cwdRoots:"broken"};writeFileSync(path,JSON.stringify(data));
  assert.equal(store.authenticateRemoteCapabilityToken(created.token,path),undefined);
});
test("legacy records remain explicitly distinguishable from newly restricted tokens",async()=>{
  const path=join(root,"legacy-tokens.json");const created=await store.createRemoteCapabilityToken({name:"legacy fixture",scopes:["session.create"]},path);
  const data=JSON.parse(readFileSync(path,"utf8"));delete data.tokens[0].creationPolicy;writeFileSync(path,JSON.stringify(data));
  assert.equal(store.authenticateRemoteCapabilityToken(created.token,path).creationPolicy,undefined);
});

test("repointing a previously pinned creation root does not grant a different directory",()=>{
  const anchor=join(root,"anchor");mkdirSync(anchor);const restriction=policy.normalizeRemoteCreationPolicy({allowedPolicies:["notes"],cwdRoots:[anchor]});
  renameSync(anchor,join(root,"old-anchor"));symlinkSync(outside,anchor,process.platform==="win32"?"junction":"dir");
  assert.throws(()=>policy.resolveRemoteCreationCwd(restriction,"notes",anchor));
});

test("creation authorization rereads the current token policy and rejects later revocation",async()=>{
  const auth=await jiti.import("./remote-control-auth.ts");const previous=process.env.PIORA_REMOTE_CONTROL_ROOT;process.env.PIORA_REMOTE_CONTROL_ROOT=root;
  try {
    const created=await store.createRemoteCapabilityToken({name:"admission fixture",scopes:["session.create"],creationPolicy:{allowedPolicies:["notes"],cwdRoots:[vault]}});
    const principal={tokenId:created.record.id,scopes:new Set(["session.create"]),allowedSessionIds:new Set(),allowedRoomIds:new Set()};
    assert.equal(auth.authorizeRemoteCreation(principal,"notes",nested),realpathSync(nested));
    assert.throws(()=>auth.authorizeRemoteCreation(principal,"agent",vault),error=>error.code==="REMOTE_CREATION_DENIED");
    await store.revokeRemoteCapabilityToken(created.record.id);
    assert.throws(()=>auth.authorizeRemoteCreation(principal,"notes",vault),error=>error.code==="REMOTE_TOKEN_EXPIRED");
  }finally{if(previous===undefined)delete process.env.PIORA_REMOTE_CONTROL_ROOT;else process.env.PIORA_REMOTE_CONTROL_ROOT=previous;}
});
