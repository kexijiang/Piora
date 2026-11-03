import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

test("prediction uses effective history, scopes the model and rejects stale sources",async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),"piora-predict-api-"));
 const state={busy:false,calls:[],messages:[{role:'user',content:'earlier goal'},{role:'toolResult',content:[{type:'text',text:'test result'}]},{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Finished'}]}]};globalThis.__predictionFixture=state;
 try{
 const stub=path.join(directory,'stub.ts');await writeFile(stub,`const s=globalThis.__predictionFixture;export const SessionManager={open:()=>({getLeafId:()=>"a",getEntries:()=>[],getCwd:()=>"/fixture"})};export const buildSessionContext=()=>({messages:s.messages,entryIds:["u","t","a"]});export const resolveSessionPath=async()=>'/fixture/session';export const getRpcSession=()=>({isRunning:()=>s.busy});export const createTrustedModelServices=async()=>({settingsManager:{getEnabledModels:()=>undefined},modelRuntime:{completeSimple:async(model,input,options)=>{s.calls.push({model,input,options});return {stopReason:'stop',content:[{type:'text',text:'Please continue.'}]}}}});export const resolveVisibleModels=async()=>({visible:[{provider:'fixture',id:'small'}]});`);
 let source=await readFile('lib/input-prediction-server.ts','utf8');for(const name of ['@earendil-works/pi-coding-agent','./session-reader','./rpc-manager','./model-runtime-context','./model-scope'])source=source.replaceAll(JSON.stringify(name),JSON.stringify(stub.replaceAll('\\','/')));
 for(const name of ['request-security','bounded-json','reply-suggestions','input-prediction'])source=source.replaceAll(JSON.stringify('./'+name),JSON.stringify(path.resolve('lib/'+name+'.ts').replaceAll('\\','/')));
 const file=path.join(directory,'server.ts');await writeFile(file,source);const {handlePrediction}=await createJiti(import.meta.url).import(file);
 const request=(extra={})=>new Request('http://localhost:30141/api',{method:'POST',headers:{host:'localhost:30141','content-type':'application/json'},body:JSON.stringify({enabled:true,model:{provider:'fixture',modelId:'small'},timeoutMs:5000,sourceEntryId:'a',...extra})});
 assert.equal((await handlePrediction(request({enabled:false}),'one')).status,200);assert.equal(state.calls.length,0);
 const response=await handlePrediction(request(),'one');assert.equal((await response.json()).text,'Please continue.');assert.equal(state.calls.length,1);assert.match(state.calls[0].input.messages[0].content,/earlier goal/);assert.match(state.calls[0].input.messages[0].content,/test result/);
 await handlePrediction(request(),'one');assert.equal(state.calls.length,1);
 assert.equal((await handlePrediction(request({model:{provider:'other',modelId:'unknown'}}),'one')).status,422);
 state.busy=true;assert.equal((await handlePrediction(request(),'one')).status,422);
 assert.equal(state.calls.length,1);
 } finally{delete globalThis.__predictionFixture;await rm(directory,{recursive:true,force:true});}
});
