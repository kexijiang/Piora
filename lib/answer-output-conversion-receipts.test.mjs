import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url);
const {answerDataDigest}=await jiti.import('./answer-output-receipts.ts');
const {parseAnswerConversionSpec}=await jiti.import('./answer-output-conversion-types.ts');
const {ANSWER_CONVERSION_INTENT,ANSWER_CONVERSION_COMPLETE,readAnswerConversionReceipts,answerConversionOutcome,answerConversionCurrentKind}=await jiti.import('./answer-output-conversion-receipts.ts');
const identity=(kind,operationId)=>({kind,operationId,appId:'budget',toolCallId:operationId+'-call',digest:'a'.repeat(64)});
function fixture(decision='confirm'){
 const root={id:'root',parentId:null,type:'message',message:{role:'user',content:'Convert this answer'}};
 const intent={version:1,requestId:'click',runId:'run',leafId:'root',decision,source:identity('intelligent-ui','component'),target:identity('mini-app','app'),inputs:decision==='confirm'?{people:4}:{},resultDigest:decision==='confirm'?'b'.repeat(64):null};
 const start={id:'intent',parentId:'root',type:'custom',customType:ANSWER_CONVERSION_INTENT,data:intent};
 const complete={id:'complete',parentId:'intent',type:'custom',customType:ANSWER_CONVERSION_COMPLETE,data:{version:1,intentId:'intent',intentHash:answerDataDigest(intent),requestDigest:answerDataDigest({requestId:intent.requestId,decision,source:intent.source,target:intent.target,inputs:intent.inputs})}};
 const entries=[root,start,complete],disk={entries,byId:new Map(entries.map(entry=>[entry.id,entry]))};return {disk,intent,complete};
}
test('conversion metadata is explicit, bounded, data-only and always changes kind',()=>{
 const spec={fromKind:'intelligent-ui',fromToolCallId:'call',fromDigest:'a'.repeat(64),description:'Keep the inputs; start the simulation from its initial state'};
 assert.deepEqual(parseAnswerConversionSpec(spec,'mini-app'),spec);
 for(const input of [{...spec,extra:true},{...spec,fromKind:'mini-app'},{...spec,fromDigest:'bad'},{...spec,description:''}])assert.throws(()=>parseAnswerConversionSpec(input,'mini-app'));
 const getter={...spec};Object.defineProperty(getter,'description',{get(){throw new Error('Accessor executed');},enumerable:true});assert.throws(()=>parseAnswerConversionSpec(getter,'mini-app'),/documented/);
});
test('an intent does not activate a target; completion is visible only on its own ancestry',()=>{
 const {disk}=fixture();assert.deepEqual(readAnswerConversionReceipts(disk,'intent'),[]);
 assert.equal(answerConversionOutcome(disk,'intent','mini-app','app'),undefined);
 assert.equal(answerConversionOutcome(disk,'complete','mini-app','app'),'confirmed');
 assert.equal(answerConversionOutcome(disk,'complete','intelligent-ui','component'),'superseded');
 assert.equal(answerConversionCurrentKind(disk,'complete','budget'),'mini-app');
 const sibling={id:'sibling',parentId:'root',type:'message',message:{role:'user',content:'Other branch'}};disk.entries.push(sibling);disk.byId.set(sibling.id,sibling);
 assert.equal(answerConversionCurrentKind(disk,'sibling','budget'),undefined);
});
test('cancelling a conversion keeps the source active and never changes the current kind',()=>{
 const {disk}=fixture('cancel');assert.equal(answerConversionOutcome(disk,'complete','mini-app','app'),'cancelled');
 assert.equal(answerConversionOutcome(disk,'complete','intelligent-ui','component'),undefined);assert.equal(answerConversionCurrentKind(disk,'complete','budget'),undefined);
});
test('changed intent bytes, request digests and non-ancestral intents fail closed',()=>{
 for(const change of [f=>f.intent.inputs.people=9,f=>f.complete.data.requestDigest='c'.repeat(64),f=>f.complete.parentId='root']){
  const f=fixture();change(f);assert.throws(()=>readAnswerConversionReceipts(f.disk,'complete'));
 }
});
test('a second completion of the same intent is rejected instead of acting as a new user choice',()=>{
 const {disk,complete}=fixture();const duplicate={...structuredClone(complete),id:'duplicate',parentId:'complete'};disk.entries.push(duplicate);disk.byId.set(duplicate.id,duplicate);
 assert.throws(()=>readAnswerConversionReceipts(disk,'duplicate'),/intent/);
});
