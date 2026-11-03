import assert from 'node:assert/strict';
import test from 'node:test';
import {createJiti} from 'jiti';
const {validateMiniAppFrame}=await createJiti(import.meta.url).import('./mini-app/frame.ts');
const document={nodes:[],css:'',inputs:[],events:[],bindings:[],viewports:['world']};
const views=[{id:'world',kind:'scene3d',label:'World',width:400,height:300}];
const frame=()=>({summary:'One cube',bindings:{},scenes:{world:{camera:{position:[4,3,5],target:[0,0,0],fov:45},meshes:[{id:'cube',geometry:{kind:'box',size:[2,2,2]},position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],color:'#246a84'}]}}});

test('a polygon failure identifies its scene and mesh; indexed and expanded triangulations both retain the shape',()=>{
  const value=frame(),positions=[0,0,0,2,0,0,2,1,0,0,1,0];
  value.scenes.world.meshes.push({...value.scenes.world.meshes[0],id:'wing',geometry:{kind:'mesh',positions}});
  assert.throws(()=>validateMiniAppFrame(value,document,views),error=>error.code==='FRAME'
    &&error.path==='frame/scenes/world/meshes/1/geometry/positions'
    &&/4 vertices \(12 numbers\)/.test(error.message)&&/indices:\[0,1,2,0,2,3\]/.test(error.message));
  const indices=[0,1,2,0,2,3];value.scenes.world.meshes[1].geometry.indices=indices;
  const indexed=validateMiniAppFrame(value,document,views).scenes.world.meshes[1].geometry;
  assert.deepEqual(indexed,{kind:'mesh',positions,indices});
  const expanded=indices.flatMap(index=>positions.slice(index*3,index*3+3));
  value.scenes.world.meshes[1].geometry={kind:'mesh',positions:expanded};
  assert.deepEqual(validateMiniAppFrame(value,document,views).scenes.world.meshes[1].geometry.positions,expanded);
  value.scenes.world.meshes[1].geometry={kind:'mesh',positions,indices:[0,1,2,3]};
  assert.throws(()=>validateMiniAppFrame(value,document,views),error=>error.code==='FRAME'
    &&error.path==='frame/scenes/world/meshes/1/geometry/indices'&&/groups of 3/.test(error.message));
});
test('frame validation rejects unsupported GPU work, malformed meshes and summed scene budgets',()=>{
  assert.deepEqual(validateMiniAppFrame(frame(),document,views),frame());
  for(const mutate of [f=>{f.scenes.world.meshes[0].shader='anything';},f=>{f.scenes.world.meshes[0].rotation[0]=Infinity;},f=>{f.scenes.world.camera.target=[4,3,5];},f=>{f.scenes.world.meshes[0].geometry={kind:'mesh',positions:[0,0,0,1,0,0,0,1,0],indices:[0,1,3]};},f=>{f.scenes.world.meshes[0].geometry={kind:'sphere',radius:2,segments:1000};},f=>{f.scenes.world.meshes=Array.from({length:30},(_,i)=>({...f.scenes.world.meshes[0],id:'sphere'+i,geometry:{kind:'sphere',radius:1,segments:32}}));},f=>{f.scenes.world.meshes=Array.from({length:201},(_,i)=>({...f.scenes.world.meshes[0],id:'cube'+i}));},f=>{f.scenes.secret=f.scenes.world;}]){const value=frame();mutate(value);assert.throws(()=>validateMiniAppFrame(value,document,views));}
});
