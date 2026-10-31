import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { responseTaskTimings, mergeResponseTaskTimings } = await createJiti(import.meta.url).import("./response-task-timing.ts");
const timing = { commandId: "a", sessionId: "chat", startedAt: 1000, finishedAt: 155000, outcome: "completed" };
const records = [{ idempotencyKey: "prompt-a", taskTiming: timing }];
const user = (id, timestamp) => ({ role: "user", clientPromptId: id, timestamp, content: "identical prompt" });
const assistant = (timestamp, content = [{ type: "text", text: "answer" }]) => ({ role: "assistant", timestamp, content });

test("each task owns only its final reply, including tools, steering and queue time", () => {
  const second = { ...timing, commandId: "b", startedAt: 200000, finishedAt: 230000 };
  const messages = [user("prompt-a", 10), assistant(2000), assistant(3000, [{ type: "toolCall" }]),
    user("steer", 4000), assistant(150000), user("prompt-b", 160000), assistant(220000)];
  const mapped = responseTaskTimings(messages, [...records, { idempotencyKey: "prompt-b", taskTiming: second }]);
  assert.deepEqual([...mapped], [[4, timing], [6, second]]);
  assert.equal(mapped.get(4).finishedAt - mapped.get(4).startedAt, 154000);
  assert.equal(mapped.get(6).finishedAt - mapped.get(6).startedAt, 30000);
});

test("legacy prompts, missing branches and unfinished tool calls do not steal a previous timer", () => {
  assert.equal(responseTaskTimings([user("other", 10), assistant(10000)], records).size, 0);
  assert.equal(responseTaskTimings([user("prompt-a", 10), assistant(2000, [{ type: "toolCall" }])], records).size, 0);
  assert.equal(responseTaskTimings([user("prompt-a", 10), assistant(2000, [])], records).size, 0);
  assert.equal(responseTaskTimings([user("prompt-a", 10), assistant(2000, [{ type: "thinking", thinking: "only process" }])], records).size, 0);
  assert.equal(responseTaskTimings([user("prompt-a", 10), assistant(2000, [{ type: "toolCall" }, { type: "text", text: "final" }])], records).get(1), timing);
  const mapped = responseTaskTimings([user("prompt-a", 10), assistant(10000), user(undefined, 160000), assistant(180000)], records);
  assert.deepEqual([...mapped], [[1, timing]]);
  assert.equal(responseTaskTimings([user("prompt-a", 10), assistant(180000)], records).size, 0);
});

test("refresh and late SSE preserve every completed task without reopening totals", () => {
  const next = { ...timing, commandId: "b", startedAt: 200000, finishedAt: 230000 };
  const merged = mergeResponseTaskTimings(records, [{ idempotencyKey: "prompt-b", taskTiming: next }]);
  const late = mergeResponseTaskTimings(merged, [{ idempotencyKey: "prompt-a", taskTiming: { ...timing, outcome: undefined, finishedAt: undefined } }]);
  assert.deepEqual(late, merged);
  assert.deepEqual(mergeResponseTaskTimings([], JSON.parse(JSON.stringify(late))), merged);
});
