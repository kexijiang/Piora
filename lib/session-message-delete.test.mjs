import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
const jiti = createJiti(import.meta.url);
const { deleteSessionMessageEntries, persistedMessagePromptIds } = await jiti.import("./session-message-delete.ts");
const { mergePendingPrompts } = await jiti.import("./prompt-recovery.ts");
const header = { type: "session", version: 3, id: "session", cwd: "C:/workspace/project", timestamp: "2026-09-11T00:00:00Z" };
const entry = (id, parentId, message) => ({ type: "message", id, parentId, timestamp: header.timestamp, message });
const user = entry("user", null, { role: "user", content: "private text", timestamp: 1, clientPromptId: "exact-send" });
const call = entry("call", "user", { role: "assistant", content: [{ type: "toolCall", id: "tool", name: "read", arguments: { path: "a" } }], timestamp: 2 });
const result = entry("result", "call", { role: "toolResult", toolCallId: "tool", toolName: "read", content: [{ type: "text", text: "tool output" }], timestamp: 3 });
const reply = entry("reply", "result", { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 4 });

test("deleting a message erases its payload but preserves descendants and branch pointers", () => {
  const other = entry("branch", "user", { role: "user", content: "another branch", timestamp: 5 });
  const original = [header, user, call, result, reply, other];
  const deleted = deleteSessionMessageEntries(original, "user");
  assert.equal(deleted.entries[1].message, undefined);
  assert.equal(JSON.stringify(deleted.entries).includes("private text"), false);
  assert.deepEqual(deleted.entries.slice(2), original.slice(2));
  assert.deepEqual(buildSessionContext(deleted.entries.slice(1), "reply").messages.map(message => message.role), ["assistant", "toolResult", "assistant"]);
  assert.deepEqual(buildSessionContext(deleted.entries.slice(1), "branch").messages.map(message => message.content), ["another branch"]);
  assert.deepEqual(deleteSessionMessageEntries(deleted.entries, "user").entries, deleted.entries, "repeated requests are idempotent");
});

test("deleting an assistant message also erases its tool results and retains the following reply", () => {
  const deleted = deleteSessionMessageEntries([header, user, call, result, reply], "call");
  assert.deepEqual(deleted.deletedIds, ["call", "result"]);
  assert.equal(JSON.stringify(deleted.entries).includes("tool output"), false);
  assert.deepEqual(buildSessionContext(deleted.entries.slice(1), "reply").messages.map(message => message.role), ["user", "assistant"]);
  assert.throws(() => deleteSessionMessageEntries([header, user, call, result], "result"), /对应的模型消息/);
});

test("compaction first-kept IDs still resolve after their message is deleted", () => {
  const compact = { type: "compaction", id: "compact", parentId: "reply", timestamp: header.timestamp, summary: "earlier summary", firstKeptEntryId: "user", tokensBefore: 100 };
  const deleted = deleteSessionMessageEntries([header, user, call, result, reply, compact], "user");
  const context = buildSessionContext(deleted.entries.slice(1), "compact");
  assert.ok(context.messages.some(message => message.role === "assistant"));
  assert.equal(JSON.stringify(context).includes("private text"), false);
});

test("deleted send receipts stop only the exact recovery copy from reappearing", () => {
  const deleted = deleteSessionMessageEntries([header, user], "user");
  const ids = persistedMessagePromptIds(deleted.entries.slice(1));
  assert.deepEqual(ids, ["exact-send"]);
  const pending = ["exact-send", "different-send"].map(id => ({ id, scope: "session", message: user.message, draft: { value: "private text", images: [], files: [] } }));
  const merged = mergePendingPrompts([], [], pending, ids);
  assert.deepEqual(merged.messages.map(message => message.clientPromptId), ["different-send"]);
});
