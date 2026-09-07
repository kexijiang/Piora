import assert from "node:assert/strict";
import test from "node:test";
import { createAgentEventDecoder, createAgentEventTransport } from "./agent-event-transport.ts";

function setup() {
  const frames = [];
  const decoded = [];
  const decode = createAgentEventDecoder();
  const transport = createAgentEventTransport((event) => {
    const serialized = JSON.stringify(event);
    frames.push(serialized);
    const result = decode(JSON.parse(serialized));
    if (result) decoded.push(result);
  }, { incremental: true });
  return { frames, decoded, transport };
}

test("coalesces text, preserves order and does not repeat mutable SDK block content", () => {
  const { frames, decoded, transport } = setup();
  const message = { role: "assistant", content: [{ type: "text", text: "" }] };
  transport.push({ type: "message_start", message });
  transport.push({ type: "message_update", message, assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: message } });
  for (const delta of ["hello", " ", "世界"]) {
    message.content[0].text += delta;
    transport.push({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", delta, contentIndex: 0, partial: message } });
  }
  transport.push({ type: "message_end", message });
  transport.push({ type: "prompt_done" });
  assert.equal(decoded.at(-3).message.content[0].text, "hello 世界");
  assert.equal(decoded.at(-2).type, "message_end");
  assert.equal(decoded.at(-1).type, "prompt_done");
  assert.equal(frames.filter((f) => JSON.parse(f).type === "message_delta").length, 1);
  transport.close();
});

test("reconnect seeds a snapshot; thinking and tool blocks preserve earlier content", () => {
  const { decoded, transport } = setup();
  const message = { role: "assistant", content: [{ type: "thinking", thinking: "before reconnect" }] };
  transport.push({ type: "connected" });
  transport.push({ type: "message_update", message, assistantMessageEvent: { type: "thinking_delta", delta: "reconnect", contentIndex: 0, partial: message } });
  message.content[0].thinking += " after";
  transport.push({ type: "message_update", message, assistantMessageEvent: { type: "thinking_delta", delta: " after", contentIndex: 0, partial: message } });
  message.content.push({ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "a.ts" } });
  transport.push({ type: "message_update", message, assistantMessageEvent: { type: "toolcall_delta", delta: "a.ts", contentIndex: 1, partial: message } });
  transport.flush();
  assert.deepEqual(decoded.at(-1).message, message);
  transport.close();
});

test("long streams transmit linear-sized deltas instead of quadratic snapshots", () => {
  const { frames, decoded, transport } = setup();
  const message = { role: "assistant", content: [{ type: "text", text: "" }] };
  transport.push({ type: "message_start", message });
  let oldBytes = 0;
  for (let i = 0; i < 1_000; i++) {
    const delta = "x".repeat(100);
    message.content[0].text += delta;
    const event = { type: "message_update", message, assistantMessageEvent: { type: "text_delta", delta, contentIndex: 0, partial: message } };
    oldBytes += JSON.stringify(event).length;
    transport.push(event);
    if (i % 8 === 7) transport.flush();
  }
  transport.flush();
  assert.equal(decoded.at(-1).message.content[0].text.length, 100_000);
  const bytes = frames.reduce((total, frame) => total + frame.length, 0);
  assert.ok(bytes < 120_000, `${bytes} bytes for 100 KB of text`);
  assert.ok(bytes < oldBytes * 0.01);
  transport.close();
});

test("cancellation drops queued frames; legacy transport preserves the SDK contract", async () => {
  const frames = [];
  const transport = createAgentEventTransport((event) => frames.push(event));
  const event = { type: "message_update", assistantMessageEvent: { partial: "legacy" } };
  transport.push(event);
  assert.deepEqual(frames, [event]);
  transport.close();
  transport.push({ type: "prompt_done" });
  assert.equal(frames.length, 1);
  const { transport: incremental, decoded } = setup();
  incremental.push({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "" }] } });
  incremental.push({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "a" }] }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "a" } });
  incremental.close();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(decoded.length, 1);
});
