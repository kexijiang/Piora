import assert from 'node:assert/strict';
import test from 'node:test';
import {createJiti} from 'jiti';
const {createCompanionExpression}=await createJiti(import.meta.url).import('./companion-expression.ts');
const input={delta:1/30,pointerX:1,pointerY:-1,pointerActive:true,sleeping:false,reducedMotion:false,friendly:true};
test('eyes lead the head and tracking stays within the eye movement range',()=>{
 const tick=createCompanionExpression(()=>.5);
 let pose=tick(input);
 assert.ok(pose.eyesX>pose.headX && pose.headX>0);
 for(let i=0;i<300;i++)pose=tick({...input,pointerX:100,pointerY:-100});
 assert.ok(pose.eyesX<=1 && pose.eyesY>=-1);
 assert.ok(pose.smile<=.22 && pose.smile>.2);
});
test('sleep settles the gaze, reduced motion holds still, and long frames do not jump',()=>{
 const tick=createCompanionExpression(()=>.5);
 for(let i=0;i<60;i++)tick(input);
 let pose;
 for(let i=0;i<100;i++)pose=tick({...input,sleeping:true});
 assert.ok(Math.abs(pose.eyesX)<.001 && pose.smile<.001);
 pose=tick({...input,reducedMotion:true});
 assert.deepEqual(pose,{eyesX:0,eyesY:0,headX:0,headY:0,smile:0});
 pose=tick({...input,delta:100});
 assert.ok(pose.headX<.5);
});
