import assert from "node:assert/strict";
import test from "node:test";
import { projectRoomActivity } from "./room-activity.ts";

const base = { sessionId: "member", runId: "run", pendingToolCalls: new Set() };
test("room activity excludes previous turns and all user/system text", () => {
  const activity = projectRoomActivity({ ...base, messages: [
    { role: "system", content: "secret system" },
    { role: "user", content: "old private request" },
    { role: "assistant", content: [{ type: "thinking", thinking: "old private thought" }] },
    { role: "user", content: "room request" },
    { role: "assistant", content: [{ type: "text", text: "room answer" }] },
  ] });
  assert.equal(activity.text, "room answer");
  assert.equal(activity.thinking, "");
  assert.doesNotMatch(JSON.stringify(activity), /secret|private|request/);
  assert.equal(projectRoomActivity({ ...base, messages: [{ role: "assistant", content: [{ type: "text", text: "history without anchor" }] }] }).text, "");
});
test("reconnection projects thinking, active tools and failures from current runtime state", () => {
  const activity = projectRoomActivity({ ...base, pendingToolCalls: new Set(["browser"]), messages: [
    { role: "user" },
    { role: "assistant", content: [{ type: "toolCall", id: "failed", name: "bash", arguments: { command: "test" } }] },
    { role: "toolResult", toolCallId: "failed", isError: true, content: [{ type: "text", text: "failure detail" }] },
  ], streamingMessage: { role: "assistant", content: [
    { type: "thinking", thinking: "check the result" },
    { type: "toolCall", id: "browser", name: "piora_browser", arguments: { action: "navigate" } },
  ] } });
  assert.equal(activity.browser, true);
  assert.equal(activity.tools[0].status, "error");
  assert.equal(activity.tools[0].output, "failure detail");
  assert.equal(activity.tools[1].status, "running");
  assert.equal(activity.thinking, "check the result");
  assert.match(activity.phase, /piora_browser/);
});
test("long tool output and model deltas stay bounded", () => {
  const activity = projectRoomActivity({ ...base, messages: [{ role: "user" }], streamingMessage: { role: "assistant", content: [
    { type: "thinking", thinking: "a".repeat(80_000) },
    { type: "text", text: "b".repeat(80_000) },
    ...Array.from({ length: 50 }, (_, index) => ({ type: "toolCall", id: String(index), name: "read", arguments: { text: "x".repeat(4_000) } })),
  ] } });
  assert.equal(activity.text.length, 12_000);
  assert.equal(activity.thinking.length, 12_000);
  assert.equal(activity.tools.length, 12);
  assert.ok(activity.tools.every((tool) => tool.input.length <= 2_000));
});

test("prompt admission cannot expose the previous turn before the new user message arrives", () => {
  const activity = projectRoomActivity({ ...base, startedAt: 100, messages: [
    { role: "user", timestamp: 50 },
    { role: "assistant", content: [{ type: "text", text: "previous private answer" }] },
  ] });
  assert.equal(activity.text, "");
});
