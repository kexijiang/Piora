import assert from "node:assert/strict";
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import ts from "typescript";
import {createJiti} from "jiti";
const jiti=createJiti(import.meta.url);const store=await jiti.import("./remote-control-store.ts");const auth=await jiti.import("./remote-control-auth.ts");
const source=readFileSync(new URL("../app/api/remote/v1/capabilities/route.ts",import.meta.url),"utf8");
const exports={};new Function("require","exports",ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(name=>{
  if(name==="@/lib/remote-control-store")return store;
  if(name==="@/lib/remote-control-auth")return {requireRemotePrincipal:()=>({scopes:new Set(),allowedSessionIds:new Set()})};
  if(name==="@/lib/remote-control-response")return {remoteErrorResponse:()=>Response.json({error:"fixture"},{status:400})};
  throw new Error("Unexpected dependency: "+name);
},exports);
const invoke=()=>exports.GET(new Request("http://localhost/api/remote/v1/capabilities"));
async function isolated(action){const previous=process.env.PIORA_REMOTE_CONTROL_ROOT;const root=mkdtempSync(join(tmpdir(),"piora-identity-"));process.env.PIORA_REMOTE_CONTROL_ROOT=root;try{await action(root);}finally{if(previous===undefined)delete process.env.PIORA_REMOTE_CONTROL_ROOT;else process.env.PIORA_REMOTE_CONTROL_ROOT=previous;await new Promise(resolve=>setTimeout(resolve,30));rmSync(root,{recursive:true,force:true});}}
test("concurrent discovery shares one durable identity independent of tokens",()=>isolated(async root=>{
  const responses=await Promise.all(Array.from({length:8},async()=>{const response=await invoke();assert.equal(response.status,200);return response.json();}));
  const id=responses[0].serverId;assert.match(id,/^[0-9a-f-]{36}$/);assert.ok(responses.every(response=>response.serverId===id));
  assert.equal(JSON.parse(readFileSync(join(root,"identity.json"),"utf8")).serverId,id);
  await store.createRemoteCapabilityToken({name:"fixture",scopes:["capabilities.read"]});assert.equal((await (await invoke()).json()).serverId,id);
}));
test("persisted identity is reused and corrupt identity is not silently replaced",()=>isolated(async root=>{
  const id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";const path=join(root,"identity.json");writeFileSync(path,JSON.stringify({version:1,serverId:id}));assert.equal((await (await invoke()).json()).serverId,id);
  writeFileSync(path,"corrupt");assert.notEqual((await invoke()).status,200);assert.equal(readFileSync(path,"utf8"),"corrupt");
}));
test("separate data roots do not share a service identity",()=>isolated(async()=>{
  const first=(await (await invoke()).json()).serverId;assert.equal(typeof first,"string");
  await isolated(async()=>{assert.notEqual((await (await invoke()).json()).serverId,first);});
}));
test("an expected-instance header is checked before authenticating a capability",()=>isolated(async root=>{
  writeFileSync(join(root,"identity.json"),JSON.stringify({version:1,serverId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}));
  const created=await store.createRemoteCapabilityToken({name:"fixture",scopes:["capabilities.read"]});
  const request=new Request("http://localhost/api/remote/v1/capabilities",{headers:{Authorization:"Bearer "+created.token,"X-Piora-Server-Id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}});
  assert.throws(()=>auth.requireRemotePrincipal(request,"capabilities.read"),error=>error.code==="REMOTE_SERVER_CHANGED");
}));
test("an identity-bound live principal cannot survive a changed server identity",()=>isolated(async root=>{
  const identity="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";const path=join(root,"identity.json");writeFileSync(path,JSON.stringify({version:1,serverId:identity}));
  const created=await store.createRemoteCapabilityToken({name:"fixture",scopes:["session.events.read"],allowedSessionIds:["session"]});
  const principal=auth.requireRemotePrincipal(new Request("http://localhost/api/remote/v1/sessions/session/events",{headers:{Authorization:"Bearer "+created.token,"X-Piora-Server-Id":identity}}),"session.events.read","session");
  auth.assertRemotePrincipalCurrent(principal,"session.events.read","session");writeFileSync(path,JSON.stringify({version:1,serverId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}));
  assert.throws(()=>auth.assertRemotePrincipalCurrent(principal,"session.events.read","session"),error=>error.code==="REMOTE_SERVER_CHANGED");
}));
test("a recovered request cannot silently switch the capability that owns its idempotency key",()=>isolated(async()=>{
 const created=await store.createRemoteCapabilityToken({name:"fixture",scopes:["session.create"]});
 const request=new Request("http://localhost/api/remote/v1/sessions",{headers:{Authorization:"Bearer "+created.token,"X-Piora-Capability-Id":"different-capability"}});
 assert.throws(()=>auth.requireRemotePrincipal(request,"session.create"),error=>error.code==="REMOTE_CAPABILITY_CHANGED");
}));
