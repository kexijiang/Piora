import test from 'node:test';
import assert from 'node:assert/strict';
import { startRealModelProxy } from '../scripts/desktop-e2e/real-model-proxy.mjs';

const model = { provider: 'deepseek', id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', api: 'openai-completions', baseUrl: 'https://example.com/v1' };
test('model terminal event completes the relay even when the provider keeps its HTTP stream open', async t => {
  const cleanup=[],records=[];let upstreamCancelled=false;
  t.after(async()=>{for(const close of cleanup.reverse())await close();});
  const relay=await startRealModelProxy({model,signal:new AbortController().signal,registerCleanup:close=>cleanup.push(close),
    runtime:{getAuth:async()=>({auth:{apiKey:'private-token'}}),getCompatibilityRequestConfig:()=>({})},onResponse:value=>records.push(value),
    fetchImpl:async()=>new Response(new ReadableStream({start(controller){
      controller.enqueue(new TextEncoder().encode('data: {"model":"deepseek-flash","choices":[{"delta":{"content":"Three saved items"},"finish_reason":"stop"}]}\n\n'));
    },cancel(){upstreamCancelled=true;}}),{status:200})});
  const response=await fetch(relay.baseUrl+'/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${relay.apiKey}`},body:JSON.stringify({model:model.id,stream:true}),signal:AbortSignal.timeout(2000)});
  assert.match(await response.text(),/Three saved items/);assert.equal(records.length,1);assert.equal(records[0].status,200);
  assert.equal(records[0].text,'Three saved items');assert.deepEqual(records[0].finishReasons,['stop']);assert.equal(upstreamCancelled,true);
});
test('relay failures retain the request identity and safe stage without leaking provider errors', async t => {
  const cleanup=[],records=[];
  t.after(async()=>{for(const close of cleanup.reverse())await close();});
  const relay=await startRealModelProxy({model,signal:new AbortController().signal,registerCleanup:close=>cleanup.push(close),
    runtime:{getAuth:async()=>({auth:{apiKey:'private-token'}}),getCompatibilityRequestConfig:()=>({})},
    onResponse:value=>records.push(value),fetchImpl:async()=>{throw new TypeError('private-token provider detail');}});
  const response=await fetch(relay.baseUrl+'/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${relay.apiKey}`},body:JSON.stringify({model:model.id,stream:true})});
  assert.equal(response.status,502);assert.equal(records[0].id,1);assert.equal(records[0].stage,'upstream');
  assert.equal(records[0].errorType,'TypeError');assert.doesNotMatch(JSON.stringify(records)+await response.text(),/private-token|provider detail/);
});
test('truncated provider streams retain bounded diagnostics without treating partial output as success', async t => {
  const cleanup=[],records=[];
  t.after(async()=>{for(const close of cleanup.reverse())await close();});
  const relay=await startRealModelProxy({model,signal:new AbortController().signal,registerCleanup:close=>cleanup.push(close),
    runtime:{getAuth:async()=>({auth:{apiKey:'private-token'}}),getCompatibilityRequestConfig:()=>({})},onResponse:value=>records.push(value),
    fetchImpl:async()=>new Response('data: {"choices":[{"delta":{"content":"partial answer"}}]}\n\n',{status:200})});
  const response=await fetch(relay.baseUrl+'/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${relay.apiKey}`},body:JSON.stringify({model:model.id,stream:true})});
  await response.text();assert.equal(records.length,1);assert.equal(records[0].status,'failed');assert.equal(records[0].failureCode,'MISSING_TERMINAL');
  assert.equal(records[0].receivedEvents,1);assert.ok(records[0].receivedCharacters>0);assert.doesNotMatch(JSON.stringify(records),/private-token|partial answer/);
});
test('real model test relay rejects other models and unauthenticated local requests before reading credentials', async t => {
  const cleanup = []; let credentialReads = 0, forwarded = 0;
  t.after(async () => { for (const close of cleanup.reverse()) await close(); });
  const relay = await startRealModelProxy({ model, signal: new AbortController().signal, registerCleanup: close => cleanup.push(close),
    runtime: { getAuth() { credentialReads++; return { auth: { apiKey: 'user-secret' } }; }, getCompatibilityRequestConfig() { return { authHeader: true }; } },
    fetchImpl: async () => { forwarded++; throw new Error('Should not forward'); },
  });
  const request = (token, selected) => fetch(relay.baseUrl + '/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ model: selected, stream: true }) });
  assert.equal((await request('incorrect', model.id)).status, 403);
  assert.equal((await request(relay.apiKey, 'deepseek-pro')).status, 400);
  assert.equal(credentialReads, 0); assert.equal(forwarded, 0);
});
test('metadata-heavy streams can finish while total transport remains bounded', async t => {
  const cleanup=[],records=[];let exceed=false;
  t.after(async()=>{for(const close of cleanup.reverse())await close();});
  const event='data: '+JSON.stringify({id:'m'.repeat(400),choices:[{delta:{content:'a'}}]})+'\n\n';
  const relay=await startRealModelProxy({model,signal:new AbortController().signal,registerCleanup:close=>cleanup.push(close),
    runtime:{getAuth:async()=>({auth:{apiKey:'private-token'}}),getCompatibilityRequestConfig:()=>({})},onResponse:value=>records.push(value),
    fetchImpl:async()=>new Response(exceed?' '.repeat(8*1024*1024+1):event.repeat(5000)+'data: [DONE]\n\n',{status:200})});
  const send=()=>fetch(relay.baseUrl+'/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${relay.apiKey}`},body:JSON.stringify({model:model.id,stream:true})});
  await(await send()).text();assert.equal(records[0].status,200);assert.equal(records[0].text,'a'.repeat(5000));
  exceed=true;await(await send()).text();assert.equal(records[1].status,'failed');assert.equal(records[1].failureCode,'RESPONSE_LIMIT');
});
test('generated content still has its own smaller bound', async t => {
  const cleanup=[],records=[];
  t.after(async()=>{for(const close of cleanup.reverse())await close();});
  const relay=await startRealModelProxy({model,signal:new AbortController().signal,registerCleanup:close=>cleanup.push(close),
    runtime:{getAuth:async()=>({auth:{apiKey:'private-token'}}),getCompatibilityRequestConfig:()=>({})},onResponse:value=>records.push(value),
    fetchImpl:async()=>new Response('data: '+JSON.stringify({choices:[{delta:{content:'a'.repeat(2*1024*1024)}}]})+'\n\ndata: [DONE]\n\n',{status:200})});
  const response=await fetch(relay.baseUrl+'/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${relay.apiKey}`},body:JSON.stringify({model:model.id,stream:true})});
  await response.text();assert.equal(records[0].status,'failed');assert.equal(records[0].failureCode,'CONTENT_LIMIT');
});
test('real model relay uses configured credentials only upstream and records returned model without exposing secrets', async t => {
  const cleanup = [], records = []; let actual;
  t.after(async () => { for (const close of cleanup.reverse()) await close(); });
  const relay = await startRealModelProxy({ model, signal: new AbortController().signal, registerCleanup: close => cleanup.push(close),
    runtime: { getAuth: async () => ({ auth: { apiKey: 'user-secret' } }), getCompatibilityRequestConfig: () => ({ authHeader: false }) },
    onRequest: value => records.push(value), onResponse: value => records.push(value),
    fetchImpl: async (url, options) => {
      actual = { url: String(url), authorization: options.headers.get('Authorization'), body: JSON.parse(options.body) };
      return new Response('data: {"model":"deepseek-flash","choices":[{"delta":{"content":"Current result is 80"}}]}\n\ndata: [DONE]\n\n', { status: 200 });
    },
  });
  const response = await fetch(relay.baseUrl + '/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${relay.apiKey}` }, body: JSON.stringify({ model: model.id, stream: true, messages: [] }) });
  assert.match(await response.text(), /Current result is 80/);
  assert.equal(actual.url, 'https://example.com/v1/chat/completions'); assert.equal(actual.authorization, 'Bearer user-secret');
  assert.equal(actual.body.model, model.id); assert.notEqual(relay.apiKey, 'user-secret');
  assert.deepEqual(records.at(-1).modelIds, ['deepseek-flash']); assert.equal(JSON.stringify(records).includes('user-secret'), false);
});
