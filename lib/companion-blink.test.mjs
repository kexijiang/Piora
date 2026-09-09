import assert from 'node:assert/strict';
import test from 'node:test';
import {createJiti} from 'jiti';
const {blinkClosure,createCompanionBlink}=await createJiti(import.meta.url).import('./companion-blink.ts');
test('a blink has a brief full closure and finishes within 260ms',()=>{
  assert.equal(blinkClosure(0),0);
  assert.equal(blinkClosure(.10),1);
  assert.ok(blinkClosure(.04)>0 && blinkClosure(.04)<1);
  assert.ok(blinkClosure(.19)>0 && blinkClosure(.19)<1);
  assert.equal(blinkClosure(.26),0);
});
test('idle blinks, sleep holds closed, wake opens and reduced motion stays still',()=>{
  const tick=createCompanionBlink(()=>.5);
  let peak=0;
  for(let i=0;i<180;i++)peak=Math.max(peak,tick(1/30,false,false));
  assert.equal(peak,1);
  for(let i=0;i<60;i++)tick(1/30,true,false);
  assert.ok(tick(1/30,true,false)>.99);
  for(let i=0;i<60;i++)tick(1/30,false,false);
  assert.ok(tick(1/30,false,false)<.01);
  for(let i=0;i<300;i++)assert.equal(tick(1/30,false,true),0);
  assert.equal(tick(1/30,true,true),1);
});
