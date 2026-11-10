import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {createJiti} from 'jiti';
import {counterPlan} from './mini-app-fixtures.mjs';
const jiti=createJiti(import.meta.url,{alias:{'@':resolve(import.meta.dirname,'..')}});
const {createOwnedSessionManager}=await jiti.import('./session-owned-manager.ts');
const {persistLazySessionManager}=await jiti.import('./session-persistence.ts');
const {MiniAppJournal,miniAppEnvelope,miniAppJournalPath}=await jiti.import('./mini-app/journal.ts');
const {MiniAppActionHost,miniAppActionData}=await jiti.import('./mini-app/action-host.ts');
const {trialMiniApp}=await jiti.import('./mini-app/server-trial.ts');
const {readMiniAppOutput,saveMiniAppOutput}=await jiti.import('./mini-app/state-service.ts');
export function actionPlan(){
 const plan=counterPlan();
 plan.program=plan.program.replace("event.type==='input'?ctx.inputs.start:","event.type==='input'?state.count+ctx.inputs.start:");
 plan.actions={version:1,actions:[{id:'save',label:'保存报告',kind:'save_snapshot',path:'report.json',format:'json'},
  {id:'read',label:'读取参数',kind:'read_json_parameters',path:'parameters.json'},
  {id:'markdown',label:'保存文本报告',kind:'save_snapshot',path:'report.md',format:'markdown'}]};
 return plan;
}
export async function actionFixture(t){
 const root=mkdtempSync(join(tmpdir(),'piora-mini-actions-')),owned=createOwnedSessionManager(root,join(root,'sessions'),root),manager=owned.manager;
 t.after(()=>{owned.release();assert.equal(dirname(root),tmpdir());rmSync(root,{recursive:true,force:true});});
 manager.appendMessage({role:'user',content:'Make a counter with project actions',timestamp:1});persistLazySessionManager(manager);
 const id=manager.getSessionId(),file=manager.getSessionFile(),journal=new MiniAppJournal({manager,root,runId:'generation',assertActive:owned.assertOwned});
 await journal.start();const {context}=await journal.capture(),plan=actionPlan();
 const call=manager.appendMessage({role:'assistant',content:[{type:'toolCall',id:'call',name:'piora_render_mini_app',arguments:plan}],timestamp:2});
 const record=await journal.create(context.requestId,'call',plan,await trialMiniApp(plan));
 const receipt=manager.appendMessage({role:'toolResult',toolCallId:'call',toolName:'piora_render_mini_app',isError:false,content:[{type:'text',text:'candidate'}],details:miniAppEnvelope(record),timestamp:3});
 await journal.publish(record.operationId,{messageEntryId:call,toolResultEntryIds:[receipt]});
 const stateOptions={sessionId:id,root,readManager:()=>manager};
 const read=()=>readMiniAppOutput({...stateOptions,toolCallId:'call'});
 const save=async(checkpoint,requestId='changed')=>{const current=await read();return saveMiniAppOutput({...stateOptions,enabled:()=>true,request:{requestId,toolCallId:'call',publicationId:record.operationId,planDigest:record.planDigest,runtimeVersion:record.runtimeVersion,leafId:current.leafId,expectedRevision:current.stateRevision,checkpoint}});};
 await save({...record.initial.snapshot,state:{count:19},tick:13,rng:12345},'progress');
 const host=new MiniAppActionHost({manager,root}),source=await host.readActionSource('call'),controller=new AbortController();
 const assertActive=()=>{owned.assertOwned();if(controller.signal.aborted)throw new Error('cancelled');};
 const run={identity:{sessionId:id,runId:'action-run',source:'ui'},signal:controller.signal,assertActive,
  authorize:async({evidence})=>{await evidence(controller.signal);return assertActive;}};
 const input={requestId:'click',toolCallId:'call',sourceDigest:source.digest,actionId:'save'};
 const options={host,data:miniAppActionData,cwd:root,input,run,enabled:()=>true,prepared:()=>{},ask:async()=> 'once'};
 return {root,id,file,manager,owned,host,source,run,controller,options,read,save,journalPath:miniAppJournalPath(id,root)};
}
