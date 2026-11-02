import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {createJiti} from 'jiti';
import {actionFixture} from './mini-app-action-fixtures.mjs';
const jiti=createJiti(import.meta.url,{alias:{'@':resolve(import.meta.dirname,'..')}});
const {AgentSessionWrapper}=await jiti.import('./rpc-manager.ts');
const {bindSessionAgentRuntimeProfile}=await jiti.import('./agent-profile-store.ts');
const {writeBetaFeatures}=await jiti.import('./beta-features.ts');
const {writeToolPermission}=await jiti.import('./tool-permission-store.ts');
const {cacheSessionPath,invalidateSessionPathCache}=await jiti.import('./session-reader.ts');
export const route=await jiti.import('../app/api/sessions/[id]/mini-app/actions/route.ts');
export async function waitFor(read,accept){for(let n=0;n<100;n++){const value=await read();if(accept(value))return value;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('Timed out waiting for action state');}
export async function actionRouteFixture(t){
 const cleanup=[],f=await actionFixture({after:fn=>cleanup.push(fn)}),previous=process.env.PI_CODING_AGENT_DIR;
 process.env.PI_CODING_AGENT_DIR=f.root;writeBetaFeatures({intelligentUi:true},f.root);
 await bindSessionAgentRuntimeProfile(f.id,'normal');cacheSessionPath(f.id,f.file);
 let active=['read','write','piora_render_mini_app'];
 const inner={sessionId:f.id,sessionFile:f.file,sessionManager:f.manager,agent:{state:{systemPrompt:'',thinkingLevel:'off'}},
  isStreaming:false,isCompacting:false,isBashRunning:false,autoCompactionEnabled:true,autoRetryEnabled:true,
  modelRuntime:{getModel:()=>undefined,refresh:async()=>{}},extensionRunner:{getRegisteredCommands:()=>[]},
  resourceLoader:{getSkills:()=>({skills:[]}),getExtensions:()=>({extensions:[],errors:[]})},promptTemplates:[],subscribe:()=>()=>{},
  prompt:async()=>{throw new Error('Actions must not invoke a model turn');},reload:async()=>{},abort:async()=>{},abortCompaction:()=>{},abortBash:()=>{},clearQueue:()=>({steering:[],followUp:[]}),
  getActiveToolNames:()=>[...active],setActiveToolsByName:names=>{active=names;},getAllTools:()=>['read','write','piora_render_mini_app'].map(name=>({name,description:name})),
  getContextUsage:()=>undefined,pendingMessageCount:0,getSteeringMessages:()=>[],getFollowUpMessages:()=>[],dispose:()=>{}};
 const wrapper=new AgentSessionWrapper(inner);wrapper.start();(globalThis.__piSessions??=new Map()).set(f.id,wrapper);writeToolPermission(f.id,'ask',f.root);
 t.after(async()=>{try{if(wrapper.isRunning())await wrapper.send({type:'abort'});await wrapper.shutdownForFileMutation();globalThis.__piSessions.delete(f.id);invalidateSessionPathCache(f.id);
  await waitFor(()=>globalThis.__pioraUiActions?.size??0,size=>size===0);
 }finally{if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;for(const fn of cleanup)await fn();}});
 const context={params:Promise.resolve({id:f.id})};
 const request=(body,origin)=>new Request(`http://localhost/api/sessions/${f.id}/mini-app/actions?toolCallId=call`,{method:body?'POST':'GET',headers:{host:'localhost',...(body?{'content-type':'application/json'}:{}),...(origin?{origin}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const get=async()=>{const response=await route.GET(request(),context);assert.equal(response.status,200,await response.clone().text());return response.json();};
 return {...f,wrapper,context,request,get,post:body=>route.POST(request(body),context),start:{command:'start',...f.options.input},setActive:names=>{active=names;},setBeta:value=>writeBetaFeatures({intelligentUi:value},f.root)};
}
