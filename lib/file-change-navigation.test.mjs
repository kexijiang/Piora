import assert from "node:assert/strict";
import test from "node:test";
import { getAdjacentChangeIndex, getCurrentChangeIndex, getDiffChangeRanges, getEditorChangeRanges } from "./file-change-navigation.ts";
import { getFileEditorLineChanges } from "./file-editor-line-changes.ts";

test("adjacent changed lines form one stop, including mixed kinds and deletion anchors", () => {
  assert.deepEqual(getEditorChangeRanges([
    { line: 2, kind: "modified" }, { line: 3, kind: "added" }, { line: 4, kind: "deleted" },
    { line: 9, kind: "deleted" },
  ]), [{ from: 2, to: 4 }, { from: 9, to: 9 }]);
});

test("navigation starts at either end, skips the current block and wraps in both directions", () => {
  const ranges = [{ from: 1, to: 4 }, { from: 10, to: 12 }, { from: 30, to: 30 }];
  assert.equal(getAdjacentChangeIndex(ranges, null, 1), 0);
  assert.equal(getAdjacentChangeIndex(ranges, null, -1), 2);
  assert.equal(getAdjacentChangeIndex(ranges, 2, 1), 1);
  assert.equal(getAdjacentChangeIndex(ranges, 11, -1), 0);
  assert.equal(getAdjacentChangeIndex(ranges, 30, 1), 0);
  assert.equal(getAdjacentChangeIndex(ranges, 1, -1), 2);
  assert.equal(getAdjacentChangeIndex(ranges, 8, 1), 1);
  assert.equal(getAdjacentChangeIndex(ranges, 8, -1), 0);
  assert.equal(getCurrentChangeIndex(ranges, 11), 1);
  assert.equal(getCurrentChangeIndex(ranges, 8), -1);
  assert.equal(getCurrentChangeIndex(ranges, null), -1);
  assert.equal(getAdjacentChangeIndex([], null, 1), -1);
  assert.equal(getAdjacentChangeIndex([], 1, -1), -1);
  assert.equal(getAdjacentChangeIndex([ranges[0]], 2, 1), 0);
});

test("draft navigation uses remapped Git marks and updates after edits and undo", () => {
  const patch = "--- a/file.txt\n+++ b/file.txt\n@@ -3 +3 @@\n-old\n+changed";
  const saved = "first\nsecond\nchanged\nfourth\nfifth";
  assert.deepEqual(getEditorChangeRanges(getFileEditorLineChanges(patch, saved, "new\n" + saved + "\nextra")), [
    { from: 1, to: 1 }, { from: 4, to: 4 }, { from: 7, to: 7 },
  ]);
  assert.deepEqual(getEditorChangeRanges(getFileEditorLineChanges(patch, saved, saved)), [{ from: 3, to: 3 }]);
  assert.deepEqual(getEditorChangeRanges(getFileEditorLineChanges(null, saved, "")), [{ from: 1, to: 1 }]);
});

test("diff stops identify removed and added rows together, including zero-context hunks and deleted files", () => {
  const patch = "--- a/file.txt\n+++ b/file.txt\n@@ -1,3 +1,3 @@\n first\n-old\n+new\n last\n@@ -40 +40 @@\n-gone\n\\ No newline at end of file\n+replaced\n@@ -80 +80,0 @@\n-deleted";
  assert.deepEqual(getDiffChangeRanges(patch), [{ from: 2, to: 3 }, { from: 5, to: 7 }, { from: 8, to: 8 }]);
  assert.deepEqual(getDiffChangeRanges("--- a/gone.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two"), [{ from: 1, to: 2 }]);
  assert.deepEqual(getDiffChangeRanges("Binary files a/image.png and b/image.png differ"), []);
  assert.deepEqual(getDiffChangeRanges(""), []);
});
