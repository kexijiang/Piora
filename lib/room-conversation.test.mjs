import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { mergeRoomActivities, roomConversationEntries } = await createJiti(import.meta.url).import("./room-conversation.ts");
const activity = (runId, updatedAt, extra = {}) => ({ sessionId: "agent", runId, updatedAt, status: "working", phase: "working", text: "", tools: [], thinking: "", browser: false, ...extra });
const message = (id, createdAt, author = "user", content = "prompt") => ({ id, createdAt, author: { id: author, kind: author === "user" ? "user" : "agent" }, content });
test("stream updates retain their position and a new run preserves the previous steps", () => {
  let history = mergeRoomActivities([], [activity("first", 20)]);
  history = mergeRoomActivities(history, [activity("first", 50, { text: "stream update" })]);
  assert.equal(history[0].startedAt, 20);
  history = mergeRoomActivities(history, [activity("second", 80)]);
  assert.equal(history.length, 2); assert.equal(history[0].status, "ended");
  assert.equal(history[0].text, "stream update");
});
test("steps are interleaved with prompts and final replies, not placed above the conversation", () => {
  const messages = [message("prompt", 10), message("reply", 30, "agent", "done"), message("next", 40)];
  const entries = roomConversationEntries(messages, [activity("first", 35, { startedAt: 20, status: "ended", text: "done" })]);
  assert.deepEqual(entries.map(entry => entry.key), ["message:prompt", "activity:agent:first", "message:reply", "message:next"]);
  assert.equal(entries[1].hasFinalReply, true);
});
test("parallel agents remain visible and only an identical final reply is deduplicated", () => {
  const entries = roomConversationEntries([message("reply", 40, "other", "same text")], [activity("first", 20, { status: "ended", text: "same text" }), activity("other-run", 30, { sessionId: "other" })]);
  assert.equal(entries.length, 3); assert.equal(entries[0].hasFinalReply, false);
});
test("equal timestamps keep message order and activity history remains bounded", () => {
  assert.deepEqual(roomConversationEntries([message("a", 1), message("b", 1)], []).map(entry => entry.key), ["message:a", "message:b"]);
  let history = [];
  for (let i = 0; i < 120; i++) history = mergeRoomActivities(history, [activity(String(i), i)]);
  assert.equal(history.length, 100); assert.equal(history[0].runId, "20");
});
