import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {createJiti} from 'jiti';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {counterPlan} from './mini-app-fixtures.mjs';
const jiti=createJiti(import.meta.url,{alias:{'@':resolve(import.meta.dirname,'..')}});
const {createOwnedSessionManager,openOwnedSessionManager}=await jiti.import('./session-owned-manager.ts');
const {persistLazySessionManager}=await jiti.import('./session-persistence.ts');
const {MiniAppJournal,miniAppEnvelope,readMiniAppConversionSource}=await jiti.import('./mini-app/journal.ts');
const {UiGenerationPrototype}=await jiti.import('./intelligent-ui/generation-journal.ts');
const {compileUiRichPlan}=await jiti.import('./intelligent-ui/rich-plan.ts');
const {compileUiPlan}=await jiti.import('./intelligent-ui/plan.ts');
const {trialMiniApp}=await jiti.import('./mini-app/server-trial.ts');
const {readMiniAppOutput,saveMiniAppOutput}=await jiti.import('./mini-app/state-service.ts');
const {readUiOutput}=await jiti.import('./intelligent-ui/read-output.ts');
const {writeBetaFeatures}=await jiti.import('./beta-features.ts');
const {cacheSessionPath,invalidateSessionPathCache}=await jiti.import('./session-reader.ts');
const {GET,POST}=await jiti.import('../app/api/sessions/[id]/answer-output/conversion/route.ts');
const {confirmAnswerConversion}=await jiti.import('./answer-output-conversion-service.ts');
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
export function componentPlan(){return {planVersion:2,id:'counter',title:'Counter parameters',inputs:[{id:'start',valueType:'number',label:'Starting value',value:3,min:0,max:20,unit:'count'}],derived:[],views:[{id:'value',kind:'metric',label:'Value',value:{input:'start'}}],layout:[{id:'parameters',type:'group',title:'Parameters',columns:1,nodeIds:['start','value']}]};}
export async function conversionFixture(t,{targetKind='mini-app',mutateTarget,legacySource=false}={}){
  const root=mkdtempSync(join(tmpdir(),'piora-conversion-')),previous=process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR=root;writeBetaFeatures({intelligentUi:true},root);
  let owned=createOwnedSessionManager(root,join(root,'sessions'),root),manager=owned.manager;
  manager.appendMessage({role:'user',content:'Build a counter',timestamp:1});persistLazySessionManager(manager);
  const id=manager.getSessionId(),file=manager.getSessionFile(),options={sessionId:id,root,readManager:()=>SessionManager.open(file)};
  const sourceKind=targetKind==='mini-app'?'intelligent-ui':'mini-app';
  async function publish(kind,toolCallId,plan){
    const ui=new UiGenerationPrototype({manager,root}),mini=new MiniAppJournal({manager,root,runId:'generation-'+toolCallId,assertActive:owned.assertOwned});
    if(kind==='intelligent-ui')await ui.startRun();else await mini.start();
    const context=kind==='intelligent-ui'?await ui.captureContext(plan.id):(await mini.capture()).context;
    const tool=kind==='intelligent-ui'?'piora_render_ui_plan':'piora_render_mini_app';
    const call=manager.appendMessage({role:'assistant',api:'openai-completions',provider:'fixture',model:'fixture',stopReason:'toolUse',usage,timestamp:2,content:[{type:'toolCall',id:toolCallId,name:tool,arguments:plan}]});
    const record=kind==='intelligent-ui'?await ui.createCandidate(context.contextId,toolCallId,compileUiRichPlan(plan,{revision:context.source.surfaceRevision+1}))
      :await mini.create(context.requestId,toolCallId,plan,await trialMiniApp(plan));
    const envelope=kind==='intelligent-ui'?record.details:miniAppEnvelope(record);
    const result=manager.appendMessage({role:'toolResult',toolCallId,toolName:tool,isError:false,content:[{type:'text',text:'candidate'}],details:envelope,timestamp:3});
    if(kind==='intelligent-ui'){
      await ui.observePersistedCandidate(record.operationId,{messageEntryId:call,toolResultEntryIds:[result]});
      if(plan.conversion){await assert.rejects(ui.commitCandidate(record.operationId),e=>e.code==='MIGRATION_REQUIRED');await ui.stageCandidateConfirmation(record.operationId);}
      else await ui.commitCandidate(record.operationId);
      await ui.finishRun('idle');
    }else await mini.publish(record.operationId,{messageEntryId:call,toolResultEntryIds:[result]});
    return {kind,toolCallId,envelope,record};
  }
  let old;
  if(legacySource){
    assert.equal(sourceKind,'intelligent-ui');const plan=componentPlan();delete plan.layout;plan.planVersion=1;
    const surface=compileUiPlan(plan,{revision:1}).surface,envelope={answerOutput:{kind:'intelligent-ui',version:1,snapshot:'Counter parameters',payload:surface}};
    manager.appendMessage({role:'assistant',api:'openai-completions',provider:'fixture',model:'fixture',stopReason:'toolUse',usage,timestamp:2,content:[{type:'toolCall',id:'old',name:'piora_render_ui',arguments:surface}]});
    manager.appendMessage({role:'toolResult',toolCallId:'old',toolName:'piora_render_ui',isError:false,content:[{type:'text',text:'Counter parameters'}],details:envelope,timestamp:3});
    old={kind:sourceKind,toolCallId:'old',envelope};
  }else old=await publish(sourceKind,'old',sourceKind==='mini-app'?counterPlan():componentPlan());
  if(sourceKind==='mini-app'){
    const value=await readMiniAppOutput({...options,toolCallId:'old'});
    await saveMiniAppOutput({...options,enabled:()=>true,request:{requestId:'progress',toolCallId:'old',publicationId:value.publication.id,planDigest:value.publication.planDigest,runtimeVersion:value.publication.runtimeVersion,leafId:value.leafId,expectedRevision:0,checkpoint:{...value.result.snapshot,inputs:{start:7},state:{count:19},tick:13}}});
  }
  manager.appendMessage({role:'user',content:'Change the output form',timestamp:4});
  const source=sourceKind==='intelligent-ui'?await new UiGenerationPrototype({manager,root}).readConversionSource('old'):readMiniAppConversionSource(id,file,'old',manager.getLeafId(),root);
  const plan=targetKind==='mini-app'?counterPlan():componentPlan();
  plan.conversion={fromKind:sourceKind,fromToolCallId:'old',fromDigest:source.identity.digest,description:'Use a new interface; start task progress over and select the parameters to retain.'};
  mutateTarget?.(plan);
  const next=await publish(targetKind,'new',plan);owned.release();cacheSessionPath(id,file);
  t.after(()=>{invalidateSessionPathCache(id);owned.release();if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;assert.equal(dirname(root),tmpdir());rmSync(root,{recursive:true,force:true});});
  const context={params:Promise.resolve({id})};
  const request=(body,extra={})=>new Request(`http://localhost/api/sessions/${id}/answer-output/conversion?kind=${targetKind}&toolCallId=new`,{method:body?'POST':'GET',...extra,headers:{host:'localhost',...(body?{'content-type':'application/json'}:{}),...extra.headers},...(body?{body:JSON.stringify(body)}:{})});
  const review=async()=>{const response=await GET(request(),context);assert.equal(response.status,200,JSON.stringify(await response.clone().json()));return(await response.json()).review;};
  const choice=async(decision='confirm')=>{const r=await review();return{kind:targetKind,toolCallId:'new',requestId:'choice-'+decision,leafId:r.leafId,digest:r.digest,decision,inputs:decision==='confirm'?r.target.inputs:{}};};
  const read=async(which='new',leafId)=>{const output=which==='new'?next:old;return output.kind==='mini-app'?readMiniAppOutput({...options,toolCallId:which,leafId}):readUiOutput(SessionManager.open(file),which,{root,leafId});};
  const mutate=async(work)=>{owned=openOwnedSessionManager(file,undefined,root);manager=owned.manager;try{return await work(manager);}finally{owned.release();}};
  return{root,id,file,source,sourceKind,targetKind,old,next,options,context,request,review,choice,read,mutate,publish,
    post:(input,extra)=>POST(request(input,extra),context),confirm:(input,extra={})=>confirmAnswerConversion({sessionId:id,sessionFile:file,input,root,enabled:()=>true,...extra})};
}
