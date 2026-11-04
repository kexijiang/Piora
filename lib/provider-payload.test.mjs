import assert from "node:assert/strict";
import test from "node:test";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { installProviderPayloadValidation, summarizeProviderError, validateChatPayload } from "./provider-payload.ts";

const model = { api: "openai-completions", provider: "fixture", id: "fixture", name: "fixture", baseUrl: "http://127.0.0.1:1/v1", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1000, cost: {input:0,output:0,cacheRead:0,cacheWrite:0} };
const raw = '400 {"error_msg":"Message role cannot empty","error_code":"InfierHub.00101044.400","details":"[]"}';

test("SDK skill text, custom messages, and tool results reach serialization with explicit roles", async () => {
  let payload;
  const runtime = { streamSimple: stream };
  installProviderPayloadValidation(runtime);
  const messages = convertToLlm([
    {role:"user",content:'<skill name="fixture">Read SKILL.md</skill>',timestamp:1},
    {role:"custom",customType:"fixture",content:"custom context",display:true,timestamp:2},
    {role:"assistant",api:model.api,provider:model.provider,model:model.id,content:[{type:"toolCall",id:"call1",name:"read",arguments:{path:"SKILL.md"}}],stopReason:"toolUse",timestamp:3},
    {role:"toolResult",toolCallId:"call1",toolName:"read",content:[{type:"text",text:"fixture instructions"}],isError:false,timestamp:4},
  ]);
  const result = await runtime.streamSimple(model,{messages},{apiKey:"fixture-only",maxRetries:0,fetch:async (_url,init)=>{
    payload=JSON.parse(init.body);
    return new Response('data: {"id":"x","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{"content-type":"text/event-stream"}});
  }}).result();
  assert.equal(result.stopReason,"stop",result.errorMessage);
  assert.deepEqual(payload.messages.map(message=>message.role),["user","user","assistant","tool"]);
  assert.equal(payload.messages.at(-1).tool_call_id,"call1");
});

test("validates final replacement or mutation after existing payload hooks, without sending malformed content", async () => {
  for (const replace of [false,true]) {
    let calls=0;
    const runtime={streamSimple:stream}; installProviderPayloadValidation(runtime);
    assert.equal(installProviderPayloadValidation(runtime),false);
    const result=await runtime.streamSimple(model,{messages:[{role:"user",content:"private fixture",timestamp:1}]},{apiKey:"fixture-only",maxRetries:0,
      onPayload(payload){if(replace)return {messages:[{content:"private fixture"}]};payload.messages[0].role="";},
      fetch:async()=>{calls++;throw new Error('must not send');}}).result();
    assert.equal(calls,0); assert.match(result.errorMessage,/messages\[0\]\.role is empty/);
    assert.doesNotMatch(result.errorMessage,/private fixture/);
    assert.equal(isRetryableAssistantError(result),false);
  }
});

test("structured provider errors retain the raw error separately and deterministic role errors do not retry", () => {
  assert.deepEqual(summarizeProviderError(raw),{summary:"Message role cannot empty",code:"InfierHub.00101044.400",structured:true});
  assert.deepEqual(summarizeProviderError("not JSON {"),{summary:"not JSON {",structured:false});
  assert.equal(isRetryableAssistantError({stopReason:"error",errorMessage:raw}),false);
  assert.doesNotThrow(()=>validateChatPayload({messages:[{role:"developer"},{role:"assistant",content:null,tool_calls:[]}]}));
});
