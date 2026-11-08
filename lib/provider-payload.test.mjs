import assert from "node:assert/strict";
import test from "node:test";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { stream as responsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { installProviderPayloadValidation, summarizeProviderError, validateChatPayload, validateOutputBudget } from "./provider-payload.ts";

const model = { api: "openai-completions", provider: "fixture", id: "fixture", name: "fixture", baseUrl: "http://127.0.0.1:1/v1", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1000, cost: {input:0,output:0,cacheRead:0,cacheWrite:0} };
const raw = '400 {"error_msg":"Message role cannot empty","error_code":"InfierHub.00101044.400","details":"[]"}';

test("SDK skill text, custom messages, and tool results reach serialization with explicit roles", async () => {
  let payload;
  const runtime = { streamSimple: stream };
  installProviderPayloadValidation(runtime);
  const messages = convertToLlm([
    {role:"user",content:'<skill name="fixture">Read SKILL.md</skill>',timestamp:1},
    {role:"custom",customType:"fixture",content:"custom context",display:true,timestamp:2},
    {role:"assistant",api:model.api,provider:model.provider,model:model.id,content:[{type:"toolCall",id:"call1",name:"read",arguments:{path:"SKILL.md"}}],usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0},stopReason:"toolUse",timestamp:3},
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

test("final output budgets cannot consume the entire input window, including payload hook overrides", async () => {
  for (const [api, adapter, field] of [
    ["openai-completions", stream, "max_tokens"],
    ["openai-completions", stream, "max_completion_tokens"],
    ["openai-responses", responsesStream, "max_output_tokens"],
    ["anthropic-messages", anthropicStream, "max_tokens"],
  ]) {
    for (const replace of [false, true]) {
      let calls = 0;
      const runtime = { streamSimple: adapter };
      installProviderPayloadValidation(runtime);
      const selected = { ...model, api, contextWindow: 300000, maxTokens: 65536 };
      const result = await runtime.streamSimple(selected, { messages: [{ role: "user", content: "private prompt", timestamp: 1 }] }, {
        apiKey: "fixture-only", maxRetries: 0,
        onPayload(payload) {
          if (replace) return { ...payload, [field]: 300000 };
          payload[field] = 300000;
        },
        fetch: async () => { calls++; throw new Error("must not send"); },
      }).result();
      assert.equal(calls, 0, `${api}/${field}: rejected before network`);
      assert.match(result.errorMessage, /Invalid model output budget:/);
      assert.match(result.errorMessage, /300000/);
      assert.doesNotMatch(result.errorMessage, /private prompt/);
      assert.equal(isRetryableAssistantError(result), false);
      assert.equal(summarizeProviderError(result.errorMessage).code, "model_output_budget");
    }
  }
});

test("budget validation preserves valid payloads, unknown limits, and API-specific context semantics", () => {
  for (const api of ["openai-completions", "openai-responses", "azure-openai-responses", "anthropic-messages"]) {
    const selected = { ...model, api, contextWindow: 300000 };
    assert.doesNotThrow(() => validateOutputBudget({ max_tokens: 65536 }, selected));
    assert.doesNotThrow(() => validateOutputBudget({ max_tokens: 299999 }, selected));
    assert.throws(() => validateOutputBudget({ max_tokens: 300001 }, selected), /Invalid model output budget/);
  }
  assert.doesNotThrow(() => validateOutputBudget({ max_tokens: 300000 }, { ...model, contextWindow: undefined }));
  assert.doesNotThrow(() => validateOutputBudget({ max_output_tokens: 300000 }, { ...model, api: "google-generative-ai" }));
  assert.doesNotThrow(() => validateOutputBudget({}, model));
});

test("zero input provider errors explain model settings while ordinary context overflow keeps its diagnosis", () => {
  const reported = '400: {"message":"This model\'s maximum context length is 300000 tokens. However, you requested 300000 output tokens and your prompt contains 18282 characters (more than 0 characters, which is the upper bound for 0 input tokens).","code":400}';
  assert.equal(summarizeProviderError(reported).code, "model_output_budget");
  assert.equal(summarizeProviderError(reported).structured, true);
  assert.equal(summarizeProviderError(reported.replace("0 input tokens", "10 input tokens")).code, "400");
  const excess = '400: {"message":"max_completion_tokens=991041 cannot be greater than max_model_len=max_total_tokens=300000. Please request fewer output tokens.","code":400}';
  assert.equal(summarizeProviderError(excess).code, "model_output_budget");
  const ordinary = '400 {"message":"maximum context length exceeded by input history","code":400}';
  assert.deepEqual(summarizeProviderError(ordinary), { summary: "maximum context length exceeded by input history", code: "400", structured: true });
});

test("wire output shares the SDK input budget including tools and system instructions", async () => {
  const selected = { ...model, contextWindow: 300000, maxTokens: 299999 };
  const context = normalizeContext({
    systemPrompt: "instructions".repeat(100),
    tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }],
    messages: [{ role: "user", content: "x".repeat(17020), timestamp: 1 }],
  });
  const input = estimateContextTokens(context).tokens;
  const available = clampMaxTokensToContext(selected, context, selected.maxTokens);
  assert.equal(available, 300000 - input - 4096);
  for (const field of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
    assert.doesNotThrow(() => validateOutputBudget({ [field]: available }, selected, context));
    assert.throws(() => validateOutputBudget({ [field]: available + 1 }, selected, context), /remaining output budget/);
  }
  for (const override of [false, true]) {
    let payload;
    const runtime = { streamSimple };
    installProviderPayloadValidation(runtime);
    const result = await runtime.streamSimple(selected, context, {
      apiKey: "fixture-only", maxRetries: 0,
      onPayload: override ? value => ({ ...value, max_tokens: 299999 }) : undefined,
      fetch: async (_url, init) => {
        payload = JSON.parse(init.body);
        return new Response('data: {"id":"x","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
      },
    }).result();
    if (override) {
      assert.equal(payload, undefined, "a hook cannot consume the input allowance");
      assert.match(result.errorMessage, /remaining output budget/);
      assert.equal(isRetryableAssistantError(result), false);
    } else {
      assert.equal(result.stopReason, "stop", result.errorMessage);
      const output = payload.max_tokens ?? payload.max_completion_tokens;
      assert.equal(output, available);
      assert.ok(input + output + 4096 <= selected.contextWindow);
    }
  }
  assert.throws(() => validateOutputBudget({ max_tokens: 1 }, selected, { messages: [{ role: "user", content: "x".repeat(1050000), timestamp: 1 }] }), /maximum context length exceeded/);
  assert.doesNotThrow(() => validateOutputBudget({ max_tokens: 1 }, selected, { messages: [{ role: "user", content: "x".repeat(1049996), timestamp: 1 }] }), "keep SDK's one-token floor within the remaining context");
});
