import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url);
const {appendMiniAppSaveHistory,validateMiniAppSaveHistory,miniAppSaveHistoryContext}=await jiti.import('./mini-app/save-history.ts');
const {answerDataDigest}=await jiti.import('./answer-output-receipts.ts');
const checkpoint=n=>({inputs:{amount:n},state:{count:n},tick:0,rng:1});

test('bounded saved comparisons retain return-to-start evidence and explicitly omit older comparisons',()=>{
  let history;
  for(let n=1;n<=20;n++)history=appendMiniAppSaveHistory(history,checkpoint(n-1),n-1,checkpoint(n),n);
  history=appendMiniAppSaveHistory(history,checkpoint(20),20,checkpoint(0),21);
  assert.equal(history.omitted,5);assert.equal(history.transitions.length,16);
  assert.equal(history.transitions[0].from.revision,5);
  assert.deepEqual(history.transitions.at(-1).changes.items,[{path:'/inputs/amount',kind:'replace',before:20,after:0},{path:'/state/count',kind:'replace',before:20,after:0}]);
  const source=JSON.stringify(history),context=miniAppSaveHistoryContext(history,700);
  assert.ok(JSON.stringify(context).length<=700);assert.ok(context.omittedTransitions>history.omitted);
  assert.equal(context.transitions.at(-1).toRevision,21);assert.equal(context.eventHistory,'unavailable');
  assert.equal(JSON.stringify(history),source,'context compaction cannot discard durable evidence');
  assert.equal(miniAppSaveHistoryContext(undefined).status,'unavailable');
  const omitted=miniAppSaveHistoryContext(history,0);assert.equal(omitted.transitions.length,0);assert.equal(omitted.omittedTransitions,21);
});

test('partial changes distinguish null, removed fields, and omitted large values without inventing missing history',()=>{
  const before=checkpoint(0),after=checkpoint(1);before.state={nullable:null,removed:1,large:'a'.repeat(300)};
  after.state={nullable:2,large:'b'.repeat(300)};
  const history=appendMiniAppSaveHistory(undefined,before,80,after,83);
  const changes=history.transitions[0].changes;
  assert.equal(changes.complete,false);assert.equal(changes.omitted,1);
  assert.ok(changes.items.some(x=>x.path==='/state/nullable'&&x.before===null&&x.after===2));
  assert.ok(changes.items.some(x=>x.path==='/state/removed'&&x.kind==='remove'&&x.before===1));
  assert.equal(history.transitions[0].from.revision,80,'legacy history starts only at an actually observed source');
});

test('durable history rejects disconnected, oversized, malformed or wrong-endpoint evidence',()=>{
  let history=appendMiniAppSaveHistory(undefined,checkpoint(0),0,checkpoint(1),1);
  history=appendMiniAppSaveHistory(history,checkpoint(1),1,checkpoint(2),2);
  const endpoint={revision:2,digest:answerDataDigest(checkpoint(2))};
  assert.deepEqual(validateMiniAppSaveHistory(history,endpoint),history);
  for(const mutate of [h=>h.omitted=-1,h=>h.transitions[1].from.digest='0'.repeat(64),h=>h.transitions[1].from.revision=0,
    h=>h.transitions[1].to.revision=1,h=>h.transitions[1].to.digest='0'.repeat(64),h=>h.transitions[0].changes.items[0].path='/program',
    h=>delete h.transitions[0].changes.items[0].before,h=>h.transitions[0].changes.items[0].after='a'.repeat(300),
    h=>h.transitions.push(...Array(16).fill(h.transitions[0])),h=>h.transitions[0].changes.omitted=3]){
    const bad=structuredClone(history);mutate(bad);assert.throws(()=>validateMiniAppSaveHistory(bad,endpoint));
  }
});

test('deep values and multibyte history cannot make an otherwise valid checkpoint unsavable',()=>{
  const before=checkpoint(0),after=checkpoint(0);let nested=1;
  for(let i=0;i<20;i++)nested={n:nested};after.state.added=nested;
  const history=appendMiniAppSaveHistory(undefined,before,0,after,1);
  assert.equal(history.transitions[0].changes.omitted,1);assert.deepEqual(history.transitions[0].changes.items,[]);
  const text=n=>({...checkpoint(n),state:Object.fromEntries(Array.from({length:4},(_,i)=>['value'+i,('汉'+n).repeat(70)]))});
  let unicode;
  for(let i=1;i<=30;i++)unicode=appendMiniAppSaveHistory(unicode,text(i-1),i-1,text(i),i);
  assert.ok(Buffer.byteLength(JSON.stringify(unicode))<=32000);
  assert.equal(unicode.omitted+unicode.transitions.length,30);assert.equal(unicode.transitions.at(-1).to.revision,30);
});
