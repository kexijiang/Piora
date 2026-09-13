import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import ts from "typescript";

const source=readFileSync(new URL("../app/api/remote/v1/commands/[id]/cancel/route.ts",import.meta.url),"utf8");
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function fixture({scope=true,allowed=true,revoked=false}={}) {
  const calls=[];const principal={tokenId:"fixture",scopes:new Set(scope?["session.abort"]:[]),allowedSessionIds:new Set(allowed?["session"]:[])};
  const fail=()=>{throw new Error("forbidden");};
  const dependencies={
    "@/lib/remote-control-auth":{
      requireRemotePrincipal:(_request,required)=>{calls.push("authenticate");if(!principal.scopes.has(required))fail();return principal;},
      assertRemotePrincipalCurrent:(actual,required,sessionId)=>{calls.push("reauthorize");assert.equal(actual,principal);if(revoked||!principal.scopes.has(required)||!principal.allowedSessionIds.has(sessionId))fail();},
    },
    "@/lib/remote-control-response":{remoteErrorResponse:()=>Response.json({error:"forbidden"},{status:403})},
    "@/lib/session-message-router":{getSessionMessageRouter:()=>({
      getCommand:async id=>{calls.push("lookup:"+id);return {targetSessionId:"session"};},
      cancelCommand:async(id,actual)=>{assert.equal(actual,principal);calls.push("cancel:"+id);return {accepted:true,commandId:id,sessionId:"session",status:"cancelled"};},
    })},
  };
  const exports={};new Function("require","exports",compiled)(name=>{if(!dependencies[name])throw new Error("Unexpected import");return dependencies[name];},exports);
  return {calls,invoke:()=>exports.POST(new Request("http://localhost/api/remote/v1/commands/fixture/cancel",{method:"POST"}),{params:Promise.resolve({id:"fixture"})})};
}
test("cancellation authenticates before command lookup and uses the command's actual session",async()=>{
  const {calls,invoke}=fixture();const response=await invoke();assert.equal(response.status,200);assert.equal((await response.json()).status,"cancelled");
  assert.deepEqual(calls,["authenticate","lookup:fixture","reauthorize","cancel:fixture"]);
});
test("a token lacking abort scope cannot look up or cancel commands",async()=>{
  const {calls,invoke}=fixture({scope:false});assert.equal((await invoke()).status,403);assert.deepEqual(calls,["authenticate"]);
});
test("a command outside the session allowlist cannot be cancelled",async()=>{
  const {calls,invoke}=fixture({allowed:false});assert.equal((await invoke()).status,403);assert.ok(!calls.some(call=>call.startsWith("cancel:")));
});
test("revocation during lookup is checked before a cancellation mutation",async()=>{
  const {calls,invoke}=fixture({revoked:true});assert.equal((await invoke()).status,403);assert.ok(!calls.some(call=>call.startsWith("cancel:")));
});
