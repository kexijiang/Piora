import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createJiti } from 'jiti';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { counterPlan } from './mini-app-fixtures.mjs';
const jiti=createJiti(import.meta.url,{alias:{'@':resolve(import.meta.dirname,'..')}});
const {createOwnedSessionManager}=await jiti.import('./session-owned-manager.ts');
const {persistLazySessionManager}=await jiti.import('./session-persistence.ts');
const {MiniAppJournal,miniAppEnvelope,miniAppJournalPath}=await jiti.import('./mini-app/journal.ts');
const {trialMiniApp}=await jiti.import('./mini-app/server-trial.ts');
const {readMiniAppOutput,saveMiniAppOutput}=await jiti.import('./mini-app/state-service.ts');
const {writeBetaFeatures}=await jiti.import('./beta-features.ts');
const {cacheSessionPath,invalidateSessionPathCache}=await jiti.import('./session-reader.ts');
const {finishPromptRun,getActivePromptRun}=await jiti.import('./prompt-run-registry.ts');
const {GET,POST}=await jiti.import('../app/api/sessions/[id]/mini-app/migration/route.ts');
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
export async function migrationFixture(t,{next=counterPlan(),sourceInputs={start:7}}={}){
  const root=mkdtempSync(join(tmpdir(),'piora-mini-migration-')),previous=process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR=root;writeBetaFeatures({intelligentUi:true},root);
  const owned=createOwnedSessionManager(root,join(root,'sessions'),root),manager=owned.manager;
  manager.appendMessage({role:'user',content:'A counter',timestamp:1});persistLazySessionManager(manager);
  const id=manager.getSessionId(),file=manager.getSessionFile(),host=new MiniAppJournal({manager,root,runId:'generation',assertActive:owned.assertOwned});
  const readManager=()=>SessionManager.open(file),options={sessionId:id,readManager,root};
  await host.start();
  async function publish(plan,toolCallId){
    const {context}=await host.capture(),call=manager.appendMessage({role:'assistant',api:'openai-completions',provider:'fixture',model:'fixture',stopReason:'toolUse',usage,timestamp:2,content:[{type:'toolCall',id:toolCallId,name:'piora_render_mini_app',arguments:plan}]});
    const record=await host.create(context.requestId,toolCallId,plan,await trialMiniApp(plan));
    const result=manager.appendMessage({role:'toolResult',toolCallId,toolName:'piora_render_mini_app',isError:false,content:[{type:'text',text:'candidate'}],details:miniAppEnvelope(record),timestamp:3});
    await host.publish(record.operationId,{messageEntryId:call,toolResultEntryIds:[result]});
    return record;
  }
  await publish(counterPlan(),'old');
  let old=await readMiniAppOutput({...options,toolCallId:'old'});
  await saveMiniAppOutput({...options,enabled:()=>true,request:{requestId:'source-progress',toolCallId:'old',publicationId:old.publication.id,planDigest:old.publication.planDigest,runtimeVersion:old.publication.runtimeVersion,leafId:old.leafId,expectedRevision:0,checkpoint:{...old.result.snapshot,inputs:sourceInputs,state:{count:19},tick:13}}});
  manager.appendMessage({role:'user',content:'Revise it',timestamp:4});next.title='Revised counter';
  const candidate=await publish(next,'new');owned.release();cacheSessionPath(id,file);
  t.after(async()=>{await finishPromptRun(getActivePromptRun(id),'abort');invalidateSessionPathCache(id);owned.release();if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;assert.equal(dirname(root),tmpdir());rmSync(root,{recursive:true,force:true});});
  const request=(body,options={})=>new Request(`http://localhost/api/sessions/${id}/mini-app/migration?toolCallId=new`,{method:body===undefined?'GET':'POST',...options,headers:{host:'localhost',...(body===undefined?{}:{'content-type':'application/json'}),...options.headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const context={params:Promise.resolve({id})};
  const review=async()=>{const r=await GET(request(),context);assert.equal(r.status,200,JSON.stringify(await r.clone().json()));return (await r.json()).review;};
  const choice=async(decision='confirm')=>{const r=await review();return {toolCallId:'new',publicationId:r.publicationId,digest:r.digest,leafId:r.leafId,requestId:'click-'+decision,decision,inputs:decision==='confirm'?r.suggestedInputs:{}};};
  const post=async(input,opts)=>POST(request(input,opts),context);
  const read=(toolCallId='new',leafId)=>readMiniAppOutput({...options,toolCallId,leafId});
  const journal=()=>JSON.parse(readFileSync(miniAppJournalPath(id,root),'utf8'));
  return {root,id,file,options,context,request,review,choice,post,read,journal,candidate,sourceInputs};
}
