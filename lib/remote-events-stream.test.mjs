import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import ts from "typescript";

function fixture({deferred=false,aborted=false,events=[],after=0,lastEventId=0}={}) {
  let allowed=true,listener,unsubscribed=0,subscribed=0,resolveState;
  const timers=new Set();const abort=new AbortController();if(aborted)abort.abort();
  const state=deferred?new Promise(resolve=>{resolveState=resolve;}):Promise.resolve({runtime:"idle"});
  const authorize=()=>{if(!allowed)throw new Error("revoked");};
  const router={getState:()=>state,listEvents:()=>events,subscribeEvents:(_id,callback)=>{subscribed++;listener=callback;return()=>{unsubscribed++;listener=undefined;};}};
  const dependencies={
    "@/lib/remote-control-auth":{requireRemotePrincipal:()=>{authorize();return {};},assertRemotePrincipalCurrent:authorize},
    "@/lib/remote-control-response":{remoteErrorResponse:()=>Response.json({error:"forbidden"},{status:403})},
    "@/lib/session-message-router":{getSessionMessageRouter:()=>router},
  };
  const load=path=>{
    const source=readFileSync(new URL(path,import.meta.url),"utf8");
    const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const exports={};new Function("require","exports","setInterval","clearInterval",compiled)(name=>{
      if(dependencies[name])return dependencies[name];
      if(name==="@/lib/remote-events-stream")return load("./remote-events-stream.ts");
      throw new Error("Unexpected dependency: "+name);
    },exports,callback=>{timers.add(callback);return callback;},callback=>timers.delete(callback));return exports;
  };
  const route=load("../app/api/remote/v1/sessions/[id]/events/route.ts");
  return {abort,timers,counts:()=>({subscribed,unsubscribed}),revoke:()=>{allowed=false;},resolve:()=>resolveState?.({runtime:"private-state"}),
    emit:cursor=>listener?.({cursor,type:"command_running",sessionId:"session",commandId:"private-command"}),
    open:async()=>{const response=await route.GET(new Request("http://localhost/api/remote/v1/sessions/session/events?after="+after,{signal:abort.signal,headers:{"last-event-id":String(lastEventId)}}),{params:Promise.resolve({id:"session"})});assert.equal(response.status,200);return response.body.getReader();},
  };
}
const decode=result=>new TextDecoder().decode(result.value);
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test("snapshot precedes cursor-filtered replay and deduplicated pending events",async()=>{
  const events=[1,2,3,4].map(cursor=>({cursor,type:"command_running",sessionId:"session"}));
  const context=fixture({deferred:true,events,after:1,lastEventId:2});const reader=await context.open();
  try {context.emit(4);context.emit(5);context.resolve();assert.match(decode(await reader.read()),/snapshot/);for(const cursor of [3,4,5])assert.match(decode(await reader.read()),new RegExp("^id: "+cursor+"\n"));context.emit(6);assert.match(decode(await reader.read()),/^id: 6/);} finally {context.abort.abort();}
});
test("cancellation during state lookup cannot recreate timers or subscriptions",async()=>{
  const context=fixture({deferred:true});const reader=await context.open();await reader.cancel();context.resolve();await settle();assert.equal(context.counts().unsubscribed,1);assert.equal(context.timers.size,0);context.abort.abort();assert.equal(context.counts().unsubscribed,1);
});

test("lifecycle stream reauthorizes before delayed initial state",async()=>{
  const context=fixture({deferred:true});const reader=await context.open();
  try {context.revoke();context.resolve();const frame=decode(await reader.read());assert.match(frame,/REMOTE_ACCESS_ENDED/);assert.doesNotMatch(frame,/private-state/);assert.equal((await reader.read()).done,true);assert.equal(context.counts().unsubscribed,1);assert.equal(context.timers.size,0);} finally {context.abort.abort();}
});
test("lifecycle stream stops live events after revocation",async()=>{
  const context=fixture();const reader=await context.open();
  try {assert.match(decode(await reader.read()),/snapshot/);context.revoke();context.emit(1);const frame=decode(await reader.read());assert.match(frame,/REMOTE_ACCESS_ENDED/);assert.doesNotMatch(frame,/private-command/);assert.equal((await reader.read()).done,true);assert.equal(context.counts().unsubscribed,1);} finally {context.abort.abort();}
});
test("idle lifecycle authorization checks close revoked streams",async()=>{
  const context=fixture();const reader=await context.open();
  try {await reader.read();context.revoke();for(const tick of [...context.timers])tick();assert.match(decode(await reader.read()),/REMOTE_ACCESS_ENDED/);assert.equal(context.timers.size,0);} finally {context.abort.abort();}
});
test("consumer cancellation releases subscription and timer exactly once",async()=>{
  const context=fixture();const reader=await context.open();await reader.read();await reader.cancel();assert.equal(context.counts().unsubscribed,1);assert.equal(context.timers.size,0);context.abort.abort();assert.equal(context.counts().unsubscribed,1);
});
test("already aborted requests never subscribe",async()=>{
  const context=fixture({aborted:true});const reader=await context.open();assert.equal((await reader.read()).done,true);assert.equal(context.counts().subscribed,0);assert.equal(context.timers.size,0);
});
test("replay backlog overflow closes and releases the listener",async()=>{
  const context=fixture({deferred:true});const reader=await context.open();
  try {for(let cursor=1;cursor<=300;cursor++)context.emit(cursor);assert.equal(context.counts().unsubscribed,1);context.resolve();assert.match(decode(await reader.read()),/stream.reset/);assert.equal((await reader.read()).done,true);await settle();assert.equal(context.timers.size,0);} finally {context.resolve();context.abort.abort();}
});
test("slow readers cannot build an unbounded live event queue",async()=>{
  const context=fixture();const reader=await context.open();
  try {for(let cursor=1;cursor<=10000;cursor++)context.emit(cursor);assert.equal(context.counts().unsubscribed,1);let bytes=0;while(true){const frame=await reader.read();if(frame.done)break;bytes+=frame.value.byteLength;}assert.ok(bytes<=262144+128);assert.equal(context.timers.size,0);} finally {context.abort.abort();}
});
