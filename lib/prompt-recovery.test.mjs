import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { mergePendingPrompts, savePendingPrompt } = await jiti.import("./prompt-recovery.ts");
const { prepareMessageRetry } = await jiti.import("./message-retry.ts");
const { buildChatHistoryRows } = await jiti.import("./chat-history.ts");
const draft = { value: "  原文\n".repeat(10000), images: [{ data: "YWJj", mimeType: "image/png" }], files: [{ name: "材料.txt", size: 9, text: "完整附件", kind: "file" }] };
const pending = { id: "send-one", scope: "session-one", message: { role: "user", content: "预览", timestamp: 1 }, draft };

test("stop, model change and repeated empty history reloads retain full text and attachments", async () => {
  for (let reload = 0; reload < 3; reload++) {
    const result = mergePendingPrompts([], [], [structuredClone(pending)]);
    assert.equal(result.messages.length, 1);
    assert.deepEqual(result.confirmedIds, []);
    const retry = await prepareMessageRetry(result.messages[0], () => { throw new Error("must use full recovery bytes"); });
    assert.equal(retry.message, draft.value);
    assert.deepEqual(retry.files, draft.files);
    assert.equal(retry.images[0].data, draft.images[0].data);
  }
});
test("same-text sends remain separate; live receipts cannot delete backup; disk receipts cover other branches", () => {
  const sameText = { role: "user", content: "预览", clientPromptId: "another-send" };
  assert.equal(mergePendingPrompts([sameText], ["entry"], [pending]).messages.length, 2);
  const live = { ...sameText, clientPromptId: pending.id };
  assert.deepEqual(mergePendingPrompts([live], ["entry"], [pending]).confirmedIds, []);
  assert.equal(mergePendingPrompts([live], ["entry"], [pending]).messages.length, 1);
  const disk = mergePendingPrompts([], [], [pending], [pending.id]);
  assert.deepEqual(disk.confirmedIds, [pending.id]);
  assert.equal(disk.messages.length, 0);
});
test("unavailable durable storage rejects admission instead of allowing composer deletion", async () => {
  await assert.rejects(savePendingPrompt(pending), /无法保存发送恢复副本/);
});
test("multiple recovered messages have distinct virtual row identities", () => {
  const result = mergePendingPrompts([], [], [pending, { ...pending, id: "send-two" }]);
  const { rows } = buildChatHistoryRows(result.messages, result.entryIds, false, new Set());
  assert.equal(new Set(rows.map((row) => row.key)).size, 2);
});

test("a disk-confirmed retry retires its failed chain but never unrelated same-text sends", async () => {
  const retry = { ...pending, id: "retry", draft: { ...draft, retryOfPromptIds: [pending.id] } };
  const final = { ...pending, id: "final", draft: { ...draft, retryOfPromptIds: [retry.id] } };
  const unrelated = { ...pending, id: "independent" };
  const records = [pending, retry, final, unrelated];
  const liveMessage = { ...pending.message, clientPromptId: final.id };
  assert.deepEqual(mergePendingPrompts([liveMessage], ["entry"], records).confirmedIds, [], "live output is not a disk receipt");
  const result = mergePendingPrompts([liveMessage], ["entry"], records, [final.id]);
  assert.deepEqual(result.confirmedIds, [pending.id, retry.id, final.id]);
  assert.deepEqual(result.messages.map(message => message.clientPromptId), [final.id, unrelated.id]);
  assert.deepEqual(result.entryIds, ["entry", ""]);
  const restored = mergePendingPrompts([], [], [retry]).messages[0];
  const payload = await prepareMessageRetry(restored, async () => "");
  assert.deepEqual(payload.retryOfPromptIds, [retry.id, pending.id]);
});
