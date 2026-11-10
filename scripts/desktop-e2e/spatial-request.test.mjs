import test from 'node:test';
import assert from 'node:assert/strict';
import { spatialRequestPhase } from './spatial-request.mjs';
import { createJiti } from 'jiti';
const {appendTitleRequestToTrailingUser}=await createJiti(import.meta.url).import('../../lib/session-title.ts');
const context={phase:'generation',prompt:'Turn the aircraft',followup:'Explain my angles',titleInstruction:'Return only a title'};
const user=content=>({role:'user',content});
test('title requests containing the original task remain background',()=>{
  const messages=[user(context.prompt),{role:'assistant',content:'Published'},user(context.titleInstruction)];
  assert.equal(spatialRequestPhase({messages},context),'background');
  messages.at(-1).content+='\n\nCurrent title draft:\nAircraft';
  assert.equal(spatialRequestPhase({messages,tools:[]},context),'background');
  const shadowTools=[{type:'function',function:{name:'piora_render_mini_app'}}];
  assert.equal(spatialRequestPhase({messages,tools:shadowTools},context),'background');
  for(const content of [context.prompt,[{type:'text',text:context.prompt}]]){
    const appended=appendTitleRequestToTrailingUser([user(content)],context.titleInstruction);
    assert.equal(spatialRequestPhase({messages:appended,tools:shadowTools},context),'background');
    appended.push(user('Saved mini app parameters are unavailable for this request.'));
    assert.equal(spatialRequestPhase({messages:appended,tools:shadowTools},context),'background');
  }
  assert.equal(spatialRequestPhase({messages:[user(context.prompt+'\n\n'+context.titleInstruction+'\n\nHost context')],tools:shadowTools},context),'background');
});
test('agent generation, correction and follow-up remain task requests regardless of thinking',()=>{
  const tools=[{type:'function',function:{name:'piora_render_mini_app'}}];
  for(const tail of [[],[{role:'tool',content:'Correct the program'}]])assert.equal(spatialRequestPhase({messages:[user(context.prompt),...tail],tools,thinking:{type:'disabled'}},context),'generation');
  assert.equal(spatialRequestPhase({messages:[user(context.prompt),user(context.followup)],tools},{...context,phase:'followup'}),'followup');
});
