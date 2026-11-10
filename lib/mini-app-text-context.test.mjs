import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url);
const {compileMiniAppDocument}=await jiti.import('./mini-app/document.ts');
const {miniAppTextContext}=await jiti.import('./mini-app/text-context.ts');

test('projection context includes exact declared text values once and excludes SVG attributes and undeclared values',()=>{
  const document=compileMiniAppDocument({html:'<p data-text="height"></p><p data-text="height"></p><p data-text="zero"></p><p data-text="flag"></p><p data-text="empty"></p><svg><circle data-bind="cx:x" r="2"></circle></svg>',css:''},{inputs:[],viewports:[]});
  const frame={summary:'Pose only',bindings:{height:'末端离地约 0.88 米',zero:0,flag:false,empty:'',x:12,unbound:'not a text binding'}};
  const before=JSON.stringify(frame);
  assert.deepEqual(miniAppTextContext(document,frame),{scope:'current-projection-text-bindings',values:[{id:'height',text:'末端离地约 0.88 米'},{id:'zero',text:'0'},{id:'flag',text:'false'},{id:'empty',text:''}],omitted:0});
  assert.equal(JSON.stringify(frame),before);
});

test('projection context explicitly omits whole values under count and serialized-character limits',()=>{
  const ids=['large','quoted',...Array.from({length:40},(_,i)=>'value'+i)];
  const document={bindings:ids.map(id=>({id}))},frame={bindings:Object.fromEntries(ids.map(id=>[id,id==='large'?'汉'.repeat(1001):id==='quoted'?'"'.repeat(400):'保留完整单位 0.88 米']))};
  const bounded=miniAppTextContext(document,frame,240);
  assert.ok(JSON.stringify(bounded).length<=240);assert.ok(bounded.values.length);
  assert.equal(bounded.omitted+bounded.values.length,ids.length);
  assert.ok(bounded.values.every(item=>item.text===frame.bindings[item.id]));
  assert.equal(miniAppTextContext(document,frame,0).omitted,ids.length);
  const many=miniAppTextContext(document,frame,20000);assert.equal(many.values.length,32);assert.equal(many.omitted,10);
});
