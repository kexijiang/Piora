import assert from 'node:assert/strict';
import test from 'node:test';
import {createJiti} from 'jiti';
import {counterPlan} from './mini-app-fixtures.mjs';
const jiti=createJiti(import.meta.url);
const {parseMiniAppPrefix,compileMiniAppPreview,validateMiniAppPreview}=await jiti.import('./mini-app/preview.ts');
const {MiniAppPreviewRuntime}=await jiti.import('./mini-app/preview-runtime.ts');
const pause=()=>new Promise(done=>setTimeout(done,10));
const reordered=()=>{const p=counterPlan();return {planVersion:p.planVersion,id:p.id,title:p.title,inputs:p.inputs,document:p.document,viewports:p.viewports,program:p.program,purpose:p.purpose,assumptions:p.assumptions,stateSchema:p.stateSchema,initialSnapshot:p.initialSnapshot,playback:p.playback};};

test('every prefix waits for closed layout dependencies and never includes or executes program code',()=>{
  const source=JSON.stringify(reordered()),programStart=source.indexOf(',"program"');let ready=0;
  for(let end=0;end<source.length;end++){
    const prefix=parseMiniAppPrefix(source.slice(0,end)),result=compileMiniAppPreview(prefix);
    assert.notEqual(prefix.status,'invalid');
    if(result.status==='ready'){
      ready++;assert.ok(end>=programStart);assert.equal(result.payload.program,undefined);assert.equal(result.payload.stateSchema,undefined);
      const compiled=validateMiniAppPreview(result.payload);assert.deepEqual(compiled.document.inputs,['start']);
    }
  }
  assert.ok(ready>100);
  assert.equal(compileMiniAppPreview(parseMiniAppPrefix(source)).status,'ready');
  const missing=counterPlan();delete missing.program;assert.equal(compileMiniAppPreview(parseMiniAppPrefix(JSON.stringify(missing))).status,'invalid');
  const script=counterPlan();script.document.html='<script>alert(1)</script>';assert.equal(compileMiniAppPreview(parseMiniAppPrefix(JSON.stringify(script))).status,'invalid');
});
function stream(){
  const emitted=[],runtime=new MiniAppPreviewRuntime({sessionId:'s',runId:'r',isActive:()=>true,emit:value=>emitted.push(value),intervalMs:1});runtime.beginRequest();
  const block={type:'toolCall',id:'t',name:'piora_render_mini_app',arguments:{}},message={role:'assistant',content:[block],timestamp:1};
  runtime.observe({type:'message_start',message});runtime.observe({type:'message_update',message,assistantMessageEvent:{type:'toolcall_start',contentIndex:0}});
  return {runtime,emitted,message,delta:delta=>runtime.observe({type:'message_update',message,assistantMessageEvent:{type:'toolcall_delta',contentIndex:0,delta}})};
}
test('streaming previews publish only validated layout, retire malformed streams and cancel old request timers',async()=>{
  const first=stream(),source=JSON.stringify(reordered()),end=source.indexOf(',"program"');first.delta(source.slice(0,end)+',');await pause();
  assert.equal(first.emitted.at(-1).phase,'partial');assert.equal(first.emitted.at(-1).payload.program,undefined);
  first.delta('"document":{}');await pause();assert.equal(first.emitted.at(-1).phase,'cleared');
  first.runtime.observe({type:'message_end',message:{...first.message,stopReason:'toolUse',content:[{...first.message.content[0],arguments:counterPlan()}]}});assert.equal(first.emitted.at(-1).phase,'cleared');
  const next=stream();next.delta(source);next.runtime.cancel();await pause();assert.deepEqual(next.emitted.map(value=>value.phase),['preparing','cleared']);
  const replacement=stream();replacement.delta(source);replacement.runtime.beginRequest();await pause();assert.deepEqual(replacement.emitted.map(value=>value.phase),['preparing','cleared']);
});
test('providers without raw argument deltas get a final validated document preview and no invented incremental content',()=>{
  const f=stream();f.runtime.observe({type:'message_end',message:{...f.message,stopReason:'toolUse',content:[{...f.message.content[0],arguments:counterPlan()}]}});
  assert.deepEqual(f.emitted.map(value=>value.phase),['preparing','complete']);
  assert.equal(f.emitted.at(-1).snapshot,'Step counter');f.runtime.cancel();assert.equal(f.emitted.at(-1).phase,'cleared');
});
