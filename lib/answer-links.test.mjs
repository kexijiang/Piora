import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { parseAnswerLinkTarget, normalizeAnswerLink, answerLinkTargetForClick } = await jiti.import("./answer-links.ts");

test("answer links default to built-in browsing and only accept ordinary HTTP(S) URLs", () => {
  for (const value of [null, "", "invalid", "builtin"]) assert.equal(parseAnswerLinkTarget(value), "builtin");
  assert.equal(parseAnswerLinkTarget("system"), "system");
  assert.equal(normalizeAnswerLink("HTTPS://example.test/docs?q=中文#part"), "https://example.test/docs?q=%E4%B8%AD%E6%96%87#part");
  for (const value of [undefined, "", "javascript:alert(1)", "data:text/html,hi", "file:///tmp/a", "mailto:a@example.test", "./README.md", "#heading", "https://user:secret@example.test", "https://example.test\n/evil", "https://"]) {
    assert.equal(normalizeAnswerLink(value), null, String(value));
  }
});

test("Ctrl, Meta and Shift invert the default destination only once", () => {
  for (const target of ["builtin", "system"]) {
    assert.equal(answerLinkTargetForClick(target, { ctrlKey: false, metaKey: false, shiftKey: false }), target);
    for (const flags of [[true,false,false], [false,true,false], [false,false,true], [true,true,true]]) {
      assert.equal(answerLinkTargetForClick(target, { ctrlKey: flags[0], metaKey: flags[1], shiftKey: flags[2] }), target === "builtin" ? "system" : "builtin");
    }
  }
});
