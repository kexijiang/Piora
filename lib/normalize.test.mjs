import assert from "node:assert/strict";
import test from "node:test";
import { normalizeToolCalls } from "./normalize.ts";

function assistant(content, extra = {}) {
  return {
    role: "assistant",
    content,
    model: "fixture-model",
    provider: "fixture-provider",
    ...extra,
  };
}

test("normalizes provider reasoning aliases into Pi thinking blocks", () => {
  const normalized = normalizeToolCalls(assistant([
    { type: "reasoning", content: [{ type: "reasoning_text", text: "work it out" }] },
    { type: "text", text: "final answer" },
  ]));

  assert.deepEqual(normalized.content.map((block) => block.type), ["thinking", "text"]);
  assert.equal(normalized.content[0].thinking, "work it out");
});

test("normalizes top-level DeepSeek and OpenRouter reasoning fields", () => {
  const deepseek = normalizeToolCalls(assistant("answer", { reasoning_content: "deepseek thought" }));
  assert.deepEqual(deepseek.content, [
    { type: "thinking", thinking: "deepseek thought" },
    { type: "text", text: "answer" },
  ]);

  const openrouter = normalizeToolCalls(assistant([{ type: "text", text: "answer" }], {
    reasoning_details: [{ type: "reasoning.text", text: "router thought" }],
  }));
  assert.equal(openrouter.content[0].type, "thinking");
  assert.equal(openrouter.content[0].thinking, "router thought");
});

test("unwraps explicit gateway thinking tags while preserving the final answer", () => {
  const complete = normalizeToolCalls(assistant([
    { type: "text", text: "<think>private working</think>Visible answer" },
  ]));
  assert.deepEqual(complete.content, [
    { type: "thinking", thinking: "private working" },
    { type: "text", text: "Visible answer" },
  ]);

  const streaming = normalizeToolCalls(assistant([
    { type: "text", text: "<analysis>still working" },
  ]));
  assert.deepEqual(streaming.content, [{ type: "thinking", thinking: "still working" }]);
});

test("normalizes Gemini thought parts, OpenAI summaries, and channel-based gateways", () => {
  const gemini = normalizeToolCalls(assistant([
    { type: "text", thought: true, text: "gemini thought" },
    { type: "text", text: "gemini answer" },
  ]));
  assert.deepEqual(gemini.content.map((block) => block.type), ["thinking", "text"]);
  assert.equal(gemini.content[0].thinking, "gemini thought");

  const openai = normalizeToolCalls(assistant([
    { type: "reasoning-summary", text: "safe reasoning summary" },
    { type: "text", text: "openai answer" },
  ]));
  assert.equal(openai.content[0].type, "thinking");
  assert.equal(openai.content[0].thinking, "safe reasoning summary");

  const channel = normalizeToolCalls(assistant([
    { type: "text", channel: "analysis", text: "gateway analysis" },
    { type: "text", channel: "final", text: "gateway answer" },
  ]));
  assert.deepEqual(channel.content.map((block) => block.type), ["thinking", "text"]);
});

test("accepts camelCase reasoning aliases used by compatible gateways", () => {
  const normalized = normalizeToolCalls(assistant("answer", {
    reasoningContent: "camel case thought",
  }));
  assert.deepEqual(normalized.content, [
    { type: "thinking", thinking: "camel case thought" },
    { type: "text", text: "answer" },
  ]);
});

test("does not guess that ordinary untagged prose is private thinking", () => {
  const normalized = normalizeToolCalls(assistant([
    { type: "text", text: "Reasoning: this heading is part of the answer." },
  ]));
  assert.deepEqual(normalized.content, [
    { type: "text", text: "Reasoning: this heading is part of the answer." },
  ]);
});

test("keeps canonical Pi thinking and tool calls stable", () => {
  const normalized = normalizeToolCalls(assistant([
    { type: "thinking", thinking: "already canonical", thinkingSignature: "opaque" },
    { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
  ]));
  assert.equal(normalized.content[0].thinking, "already canonical");
  assert.equal(normalized.content[0].thinkingSignature, "opaque");
  assert.deepEqual(normalized.content[1], {
    type: "toolCall",
    toolCallId: "call-1",
    toolName: "read",
    input: { path: "README.md" },
  });
});

test("malformed provider text after image analysis cannot enter the React tree", () => {
  const normalized = normalizeToolCalls(assistant([null, { type: "text", text: { result: "invalid" } }, { type: "text", text: "Image analysis completed" }]));
  assert.deepEqual(normalized.content, [{ type: "text", text: "Image analysis completed" }]);
});
