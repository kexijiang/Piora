import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { collectModelChangeNotices, insertModelChangeRows } = await jiti.import("./model-change-notices.ts");
const { buildSessionContext } = await jiti.import("./session-reader.ts");
const { buildCompactChatHistoryRows } = await jiti.import("./compact-chat-history.ts");
const timestamp = "2026-11-01T00:00:00Z";
const change = (id, parentId, modelId, provider = "test") => ({ type: "model_change", id, parentId, timestamp, provider, modelId });
const message = (id, parentId, role, content) => ({ type: "message", id, parentId, timestamp, message: { role, content, ...(role === "assistant" ? { provider: "test", model: "a" } : {}) } });
const initial = change("initial", null, "a");
const user = message("user", "initial", "user", "Question");
const reply = message("reply", "user", "assistant", [{ type: "thinking", thinking: "Thinking" }, { type: "text", text: "Answer" }]);

test("first selections and repeated choices never create switch notices", () => {
  const early = change("early", "user", "b");
  assert.deepEqual(collectModelChangeNotices([initial, user, early], undefined, ["user"]), []);
  assert.deepEqual(collectModelChangeNotices([initial, user, reply, change("same", "reply", "a")], undefined, ["user", "reply"]), []);
});

test("successful persisted switches survive reload as metadata without model-context messages", () => {
  const entries = [initial, user, reply, change("switch", "reply", "b"), change("again", "switch", "c")];
  const context = buildSessionContext(entries);
  assert.deepEqual(context.entryIds, ["user", "reply"]);
  assert.equal(context.messages.length, 2);
  assert.deepEqual(context.modelChanges, [
    { id: "switch", afterEntryId: "reply", from: { provider: "test", modelId: "a" }, to: { provider: "test", modelId: "b" } },
    { id: "again", afterEntryId: "reply", from: { provider: "test", modelId: "b" }, to: { provider: "test", modelId: "c" } },
  ]);
  assert.deepEqual(buildSessionContext(JSON.parse(JSON.stringify(entries))).modelChanges, context.modelChanges);
  assert.deepEqual(buildSessionContext(entries.slice(0, 3)).modelChanges, [], "failed switches have no persisted change to display");
});

test("selected branch excludes sibling switches and empty branches", () => {
  const entries = [initial, user, reply, change("left", "reply", "b"), change("right", "reply", "c")];
  assert.deepEqual(buildSessionContext(entries, "left").modelChanges.map(n => n.id), ["left"]);
  assert.deepEqual(buildSessionContext(entries, "right").modelChanges.map(n => n.id), ["right"]);
  assert.deepEqual(buildSessionContext(entries, "reply").modelChanges, []);
  assert.deepEqual(collectModelChangeNotices(entries, null, ["user", "reply"]), []);
});

test("provider changes count even when the model id is identical", () => {
  const notices = collectModelChangeNotices([initial, user, reply, change("switch", "reply", "a", "other")], undefined, ["user", "reply"]);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].to.provider, "other");
});

test("compaction removes notices anchored in discarded history but preserves later switches", () => {
  const entries = [initial, user, reply, change("old", "reply", "b"), message("kept", "old", "user", "Next"),
    { type: "compaction", id: "compact", parentId: "kept", timestamp, summary: "Summary", firstKeptEntryId: "kept", tokensBefore: 100 },
    change("new", "compact", "c")];
  const context = buildSessionContext(entries);
  assert.deepEqual(context.modelChanges.map(n => n.id), ["new"]);
  assert.equal(context.modelChanges[0].afterEntryId, "kept");
});

test("divider follows every reply fragment, survives process collapse, and precedes the next question", () => {
  const entries = [initial, user, reply, change("switch", "reply", "b"), message("next", "switch", "user", "Next")];
  const context = buildSessionContext(entries);
  for (const expanded of [false, true]) {
    const plan = buildCompactChatHistoryRows(context.messages, context.entryIds, false, new Map([["compact-process:user", expanded]]));
    const rows = insertModelChangeRows(plan.rows, context.entryIds, context.modelChanges);
    const index = rows.findIndex(row => row.modelChange);
    assert.ok(index > 0);
    assert.ok(rows.slice(0, index).filter(row => row.message?.role === "assistant").length > 0);
    assert.equal(rows[index + 1].message.content, "Next");
    assert.equal(rows.filter(row => row.modelChange).length, 1);
    assert.deepEqual(insertModelChangeRows(plan.rows, context.entryIds, [{ ...context.modelChanges[0], afterEntryId: "removed" }]), plan.rows);
  }
});
