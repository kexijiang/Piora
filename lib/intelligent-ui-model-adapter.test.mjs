import test from "node:test";
import assert from "node:assert/strict";
import { createUiModelAdapter } from "../scripts/intelligent-ui-model-adapter.mjs";

const tool = { name: "piora_render_ui", description: "Trusted local UI", parameters: { type: "object" } };
const model = { provider: "fixture", id: "model" };
const reply = (content, stopReason = "stop") => ({ role: "assistant", content, stopReason, model: model.id, usage: { totalTokens: 2 } });
const task = { id: "sample", label: "never-send-label", expected: { secret: "never-send-expectation" }, turns: [{ user: "帮我算一下" }] };
function fixture(responses, options = {}) {
  const requests = [], executions = [];
  const runtime = { getModel: () => model, completeSimple: async (_model, context, settings) => {
    requests.push({ context: structuredClone(context), settings });
    const response = responses.shift();
    return typeof response === "function" ? response() : response;
  } };
  const adapter = createUiModelAdapter({ runtime,
    variant: async () => ({ tools: [tool], systemPrompt: "Fixture decision policy", protocol: "surface-v1" }),
    executeUi: async input => { executions.push(input); return { content: "Rendered", committed: true }; }, ...options });
  return { ...adapter, requests, executions };
}
const input = { task, model: "fixture/model", policyVersion: "fixture-v1", repetition: 0 };

test("complete text-only responses remain evaluation samples without leaking labels or reasoning", async () => {
  const f = fixture([reply([{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "答案是80" }])]);
  const result = await f.runTask(input);
  assert.equal(result.outcome, "completed");
  assert.equal(result.turns[0].assistant, "答案是80");
  assert.deepEqual(result.turns[0].uiAttempts, []);
  assert.doesNotMatch(JSON.stringify(result), /private reasoning/);
  assert.doesNotMatch(JSON.stringify(f.requests), /never-send/);
});

test("tool results and previous conversation survive follow-up turns", async () => {
  const f = fixture([
    reply([{ type: "toolCall", id: "one", name: tool.name, arguments: { id: "calculator" } }], "toolUse"),
    reply([{ type: "text", text: "可以调整了" }]), reply([{ type: "text", text: "因为6个人平摊" }]),
  ]);
  const result = await f.runTask({ ...input, task: { ...task, turns: [...task.turns, { user: "为什么是80？" }] } });
  assert.equal(result.outcome, "completed");
  assert.equal(result.turns.length, 2);
  assert.equal(result.turns[0].uiAttempts[0].committed, true);
  assert.equal(f.executions.length, 1);
  assert.equal(f.requests[2].context.messages.filter(item => item.role === "user").length, 2);
  assert.ok(f.requests[2].context.messages.some(item => item.role === "toolResult" && item.content[0].text === "Rendered"));
});

test("unknown tools are recorded and rejected without executing a side effect", async () => {
  const f = fixture([reply([{ type: "toolCall", id: "x", name: "bash", arguments: { command: "unsafe" } }], "toolUse"), reply([])]);
  const result = await f.runTask(input);
  assert.equal(f.executions.length, 0);
  assert.equal(result.turns[0].uiAttempts.length, 0);
  assert.equal(result.turns[0].otherToolAttempts[0].errorCode, "unknown-tool");
  assert.equal(f.requests[1].context.messages.at(-1).isError, true);
});

test("provider errors do not expose credentials or masquerade as successful text", async () => {
  const f = fixture([{ ...reply([], "error"), errorMessage: "Bearer private-provider-key" }]);
  const result = await f.runTask(input);
  assert.equal(result.outcome, "provider-error");
  assert.doesNotMatch(JSON.stringify(result), /private-provider-key/);
});

test("network TypeErrors are persisted as failed tasks", async () => {
  const f = fixture([() => { throw new TypeError("fetch failed with private details"); }]);
  const result = await f.runTask(input);
  assert.equal(result.outcome, "provider-error");
  assert.equal(result.turns[0].errorCode, "provider-request-failed");
  assert.doesNotMatch(JSON.stringify(result), /private details/);
});

test("failed provider responses retain known UI selection evidence without executing it", async () => {
  for (const stopReason of ["error", "aborted"]) {
    const f = fixture([{ ...reply([{ type: "toolCall", id: "partial", name: tool.name, arguments: {} }], stopReason), errorMessage: "private-key" }]);
    const result = await f.runTask(input);
    assert.equal(result.outcome, "provider-error");
    assert.equal(result.turns[0].uiAttempts.length, 1);
    assert.equal(result.turns[0].uiAttempts[0].committed, false);
    assert.equal(f.executions.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /private-key/);
  }
});

test("request cap reports an unfinished task and does not make one more request", async () => {
  const f = fixture([reply([{ type: "toolCall", id: "one", name: tool.name, arguments: {} }], "toolUse")], { maxRequestsPerTurn: 1 });
  const result = await f.runTask(input);
  assert.equal(result.outcome, "timeout");
  assert.equal(result.turns[0].errorCode, "evaluation-request-limit");
  assert.equal(f.requests.length, 1);
});

test("deadline settles a silent provider and discards its eventual response", async () => {
  let finish;
  const f = fixture([() => new Promise(resolve => { finish = resolve; })], { timeoutMs: 25 });
  const result = await f.runTask(input);
  assert.equal(result.outcome, "timeout");
  assert.ok(result.turns[0].durationMs > 0);
  finish(reply([{ type: "toolCall", id: "late", name: tool.name, arguments: {} }]));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.executions.length, 0);
});

test("output truncation and a large parallel tool batch remain bounded failures", async () => {
  const truncated = fixture([reply([{ type: "text", text: "unfinished" }], "length")]);
  assert.equal((await truncated.runTask(input)).turns[0].errorCode, "output-token-limit");
  const batch = fixture([reply(Array.from({ length: 20 }, (_, i) => ({ type: "toolCall", id: `call${i}`, name: tool.name, arguments: {} })))],
    { maxToolAttemptsPerTurn: 2 });
  const result = await batch.runTask(input);
  assert.equal(result.outcome, "timeout");
  assert.equal(result.turns[0].errorCode, "evaluation-tool-limit");
  assert.equal(batch.executions.length, 2);
  const truncatedCall = fixture([reply([{ type: "toolCall", id: "cut", name: tool.name, arguments: { incomplete: true } }], "length")]);
  const partial = await truncatedCall.runTask(input);
  assert.equal(partial.turns[0].uiAttempts.length, 1);
  assert.equal(partial.turns[0].uiAttempts[0].errorCode, "output-token-limit");
  assert.equal(truncatedCall.executions.length, 0);
});

test("explicit cancellation is separate from timeout and prevents late tool execution", async () => {
  const controller = new AbortController();
  const f = fixture([() => { controller.abort(); return reply([{ type: "toolCall", id: "late", name: tool.name, arguments: {} }]); }]);
  const result = await f.runTask({ ...input, signal: controller.signal });
  assert.equal(result.outcome, "cancelled");
  assert.equal(f.executions.length, 0);
});

test("task state is isolated between repetitions", async () => {
  const states = [];
  const f = fixture(Array.from({ length: 2 }, () => [reply([{ type: "toolCall", id: "same", name: tool.name, arguments: {} }]), reply([])]).flat(),
    { executeUi: async ({ state }) => { states.push(state); assert.equal(state.size, 0); state.set("private", 1); return { content: "done", committed: false }; } });
  await f.runTask(input); await f.runTask(input);
  assert.notEqual(states[0], states[1]);
});
