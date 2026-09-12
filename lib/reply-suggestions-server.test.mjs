import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createJiti } from "jiti";

test("extraction route validates source, scopes models and shares cancellable requests without side effects",async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),"piora-reply-api-"));
  const sourcePath=path.resolve("lib/reply-suggestions-server.ts");
  const state={busy:false,leaf:"a",text:"可以选择深色或浅色。",calls:[],visible:true,generate:async()=>({stopReason:"stop",content:[{type:"text",text:'{"groups":[]}' }]})};
  globalThis.__replyApiFixture=state;
  try{
    const stub=path.join(directory,"stubs.ts");
    await writeFile(stub,`
      const s=globalThis.__replyApiFixture;
      export const SessionManager={open:()=>({getLeafId:()=>s.leaf,getCwd:()=>'/fixture',getEntries:()=>[{id:'a'},{id:'b'}]})};
      export const resolveSessionPath=async id=>id==='missing'?null:'/fixture/session.jsonl';
      export const buildSessionContext=()=>({entryIds:['a'],messages:[{role:'assistant',stopReason:'stop',content:[{type:'text',text:s.text}]}]});
      export const getRpcSession=()=>({isRunning:()=>s.busy});
      export class ModelRequestCwdError extends Error {}
      export const resolveModelRequestCwd=async()=>'/fixture';
      export const createTrustedModelServices=async()=>({settingsManager:{getEnabledModels:()=>undefined},modelRuntime:{completeSimple:async(model,input,options)=>{s.calls.push({model,input,options});return s.generate(options.signal)}}});
      export const resolveVisibleModels=async()=>({visible:s.visible?[{provider:'fixture',id:'extract'}]:[]});
    `);
    let source=await readFile(sourcePath,"utf8");
    for(const name of ["@earendil-works/pi-coding-agent","./session-reader","./rpc-manager","./model-runtime-context","./model-scope"])source=source.replaceAll(JSON.stringify(name),JSON.stringify(stub.replaceAll("\\","/")));
    for(const name of ["request-security","bounded-json","reply-suggestions"])source=source.replaceAll(JSON.stringify(`./${name}`),JSON.stringify(path.resolve(`lib/${name}.ts`).replaceAll("\\","/")));
    const target=path.join(directory,"server.ts");await writeFile(target,source);
    const {handleReplyRequest}=await createJiti(import.meta.url).import(target);
    const body=(patch={})=>({sourceEntryId:"a",leafId:null,source:state.text,model:{provider:"fixture",modelId:"extract"},systemPrompt:"提取明确选项",...patch});
    const request=(payload=body(),options={})=>new Request("http://localhost:30141/api/reply-suggestions/preview",{method:"POST",headers:{host:"localhost:30141","Content-Type":"application/json"},body:JSON.stringify(payload),...options});
    const reset=()=>{globalThis.__pioraReplyCache.clear();state.calls=[];state.busy=false;state.visible=true;state.leaf="a";state.text="可以选择深色或浅色。";state.generate=async()=>({stopReason:"stop",content:[{type:"text",text:'{"groups":[]}' }]});};
    await t.test("rejects cross-origin and invalid content before calling a model",async()=>{reset();assert.equal((await handleReplyRequest(request(body(),{headers:{host:"localhost:30141",origin:"https://evil.example","Content-Type":"application/json"}}))).status,403);assert.equal((await handleReplyRequest(request(body(),{headers:{host:"localhost:30141","Content-Type":"text/plain"}}))).status,415);assert.equal(state.calls.length,0)});
    await t.test("rejects invalid settings and bounded JSON",async()=>{reset();assert.equal((await handleReplyRequest(request(body({model:null})))).status,400);assert.equal((await handleReplyRequest(request(body(),{body:'{"invalid":'}))).status,400);assert.equal((await handleReplyRequest(request(body(),{body:"a".repeat(262145)}))).status,413);assert.equal(state.calls.length,0)});
    await t.test("rejects missing, busy or outdated session sources",async()=>{reset();assert.equal((await handleReplyRequest(request(),"missing")).status,409);state.busy=true;assert.equal((await handleReplyRequest(request(),"one")).status,409);state.busy=false;assert.equal((await handleReplyRequest(request(body({sourceEntryId:"wrong"})),"one")).status,409);assert.equal(state.calls.length,0)});
    await t.test("uses the dedicated model with no tools and no fallback or retry",async()=>{reset();const response=await handleReplyRequest(request(),"one");assert.equal(response.status,200);assert.deepEqual(await response.json(),{groups:[]});const call=state.calls[0];assert.equal(call.model.id,"extract");assert.equal(call.options.maxRetries,0);assert.equal(call.options.maxTokens,3072);assert.equal(call.options.timeoutMs,15000);assert.equal(call.input.tools,undefined);assert.equal(call.input.messages.length,1);assert.match(call.input.systemPrompt,/output protocol is fixed/i)});
    await t.test("unavailable explicit model does not fall back",async()=>{reset();state.visible=false;const response=await handleReplyRequest(request());assert.equal(response.status,422);assert.equal((await response.json()).code,"model_unavailable");assert.equal(state.calls.length,0)});
    await t.test("does not accept a source changed while the model was running",async()=>{reset();state.generate=async()=>{state.text="另一段回复";return {stopReason:"stop",content:[{type:"text",text:'{"groups":[]}' }]}};assert.equal((await handleReplyRequest(request(),"one")).status,409)});
    await t.test("rejects unsupported evidence and strips provider error details",async()=>{reset();state.generate=async()=>({stopReason:"stop",content:[{type:"text",text:JSON.stringify({groups:[{title:"伪造建议",selectionMode:"multiple",options:[{label:"删除",insertText:"请删除数据",evidence:"not in source",recommended:false}]}]})}]});let response=await handleReplyRequest(request());assert.equal((await response.json()).code,"invalid_output");reset();state.generate=async()=>{throw Error("api-key=secret")};response=await handleReplyRequest(request());assert.equal(await response.text(),'{"code":"provider_error"}');assert.equal(state.calls.length,1)});
    await t.test("deduplicates consumers; cancelling one leaves the other active",async()=>{reset();let finish;state.generate=signal=>new Promise(resolve=>{finish=()=>resolve({stopReason:"stop",content:[{type:"text",text:'{"groups":[]}' }]});state.signal=signal});const controller=new AbortController();const one=handleReplyRequest(request(body(),{signal:controller.signal}));const two=handleReplyRequest(request());while(!finish)await new Promise(resolve=>setImmediate(resolve));controller.abort();assert.equal((await one).status,499);assert.equal(state.signal.aborted,false);finish();assert.equal((await two).status,200);assert.equal(state.calls.length,1);assert.equal((await handleReplyRequest(request())).status,200);assert.equal(state.calls.length,1)});
    await t.test("cancels provider work when all consumers leave",async()=>{reset();let started;const ready=new Promise(resolve=>started=resolve);state.generate=signal=>new Promise(resolve=>{state.signal=signal;signal.addEventListener("abort",()=>resolve({stopReason:"aborted",content:[]}));started()});const c=new AbortController();const pending=handleReplyRequest(request(body(),{signal:c.signal}));await ready;c.abort();assert.equal((await pending).status,499);assert.equal(state.signal.aborted,true)});
  }finally{delete globalThis.__replyApiFixture;assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir())+path.sep)&&path.basename(directory).startsWith("piora-reply-api-"));await rm(directory,{recursive:true,force:true,maxRetries:5});}
});
