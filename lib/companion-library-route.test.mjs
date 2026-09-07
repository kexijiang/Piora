import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createJiti } from 'jiti';
test('JSON transfer API writes, reads and removes a full-size document on isolated disk',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'piora-library-api-'));
 const previous=process.env.PI_CODING_AGENT_DIR;
 process.env.PI_CODING_AGENT_DIR=root;
 try{
  const {GET,POST,PATCH}=await createJiti(import.meta.url,{tsconfigPaths:true}).import('../app/api/companion/library/route.ts');
  const request=(method,body)=>new Request('http://localhost/api/companion/library',{method,headers:{host:'localhost','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const content=JSON.stringify({text:'x'.repeat(190000)});
  const saved=await POST(request('POST',{content,title:'JSON fixture',language:'json',kind:'code'}));
  assert.equal(saved.status,200,await saved.clone().text());
  const {items}=await saved.json();assert.equal(items[0].content,content);
  const loaded=await GET(request('GET'));assert.equal((await loaded.json()).items[0].content,content);
  const removed=await PATCH(request('PATCH',{id:items[0].id,remove:true}));assert.equal(removed.status,200);assert.equal((await removed.json()).items.length,0);
 }finally{
  if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;
  assert.equal(path.dirname(root),path.resolve(tmpdir()));assert.ok(path.basename(root).startsWith('piora-library-api-'));await rm(root,{recursive:true,force:true});
 }
});
