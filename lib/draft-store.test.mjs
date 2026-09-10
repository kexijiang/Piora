import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const drafts = await jiti.import("./draft-store.ts");

test("drafts preserve pasted prompt materials without sharing mutable state", () => {
  const key = "new:C:/project";
  drafts.setDraft(key, {
    value: "summarize this",
    images: [],
    files: [{ name: "粘贴内容 1.txt", size: 12, text: "large paste", kind: "paste" }],
    retryOfPromptIds: ["failed-send"],
  });

  const first = drafts.getDraft(key);
  assert.equal(first.files[0].text, "large paste");
  first.files[0].text = "changed";
  first.retryOfPromptIds.push("different-send");
  assert.equal(drafts.getDraft(key).files[0].text, "large paste");
  assert.deepEqual(drafts.getDraft(key).retryOfPromptIds, ["failed-send"]);

  drafts.clearDraft(key);
  assert.equal(drafts.getDraft(key), null);
});
