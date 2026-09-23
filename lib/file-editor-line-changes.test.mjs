import assert from "node:assert/strict";
import test from "node:test";
import { EditorState } from "@codemirror/state";
import { getFileEditorLineChanges, getFileLineSeparator, preserveFileLineEndings } from "./file-editor-line-changes.ts";

test("Git changes mark additions, replacements and deletion boundaries", () => {
  const patch = "--- a/example.ts\n+++ b/example.ts\n@@ -1,4 +1,4 @@\n first\n-old\n+new\n third\n-gone\n";
  assert.deepEqual(getFileEditorLineChanges(patch, "first\nnew\nthird", "first\nnew\nthird"), [
    { line: 2, kind: "modified" },
    { line: 3, kind: "deleted" },
  ]);
});

test("unsaved insertions shift saved Git markers and add live draft markers", () => {
  const patch = "--- a/example.ts\n+++ b/example.ts\n@@ -2 +2 @@\n-old\n+changed";
  assert.deepEqual(getFileEditorLineChanges(patch, "first\nchanged\nlast", "new\nfirst\nchanged\nlast"), [
    { line: 1, kind: "added" },
    { line: 3, kind: "modified" },
  ]);
});

test("separated draft edits leave unchanged lines unmarked", () => {
  assert.deepEqual(getFileEditorLineChanges(null, "a\nb\nc\nd\ne", "a\nB\nc\nd\nE"), [
    { line: 2, kind: "modified" },
    { line: 5, kind: "modified" },
  ]);
});

test("a new line beside an edited line keeps its added marker", () => {
  const saved = "first\n  return true;\nlast";
  const insertedBefore = "first\n\n  return false;\nlast";
  const beforeMarkers = [
    { line: 2, kind: "added" },
    { line: 3, kind: "modified" },
  ];
  assert.deepEqual(getFileEditorLineChanges(null, saved, insertedBefore), beforeMarkers);
  assert.deepEqual(getFileEditorLineChanges(null, saved.replaceAll("\n", "\r\n"), insertedBefore.replaceAll("\n", "\r\n")), beforeMarkers);
  assert.deepEqual(getFileEditorLineChanges(null, saved.replaceAll("\n", "\r\n"), insertedBefore.replace("\n\n", "\n  \n").replaceAll("\n", "\r\n")), beforeMarkers);
  assert.deepEqual(getFileEditorLineChanges(null, saved, "first\n  return false;\n\nlast"), [
    { line: 2, kind: "modified" },
    { line: 3, kind: "added" },
  ]);
});

test("Git patches distinguish adjacent additions from replacements", () => {
  const patch = "--- a/example.ts\n+++ b/example.ts\n@@ -1,3 +1,4 @@\n first\n-  return true;\n+\n+  return false;\n last";
  assert.deepEqual(getFileEditorLineChanges(patch, "first\n\n  return false;\nlast", "first\n\n  return false;\nlast"), [
    { line: 2, kind: "added" },
    { line: 3, kind: "modified" },
  ]);
});

test("CRLF files keep their line endings through an edit and mark only the edited line", () => {
  const saved = "first\r\nsecond\r\nthird\r\nfourth";
  const state = EditorState.create({ doc: saved, extensions: [EditorState.lineSeparator.of(getFileLineSeparator(saved))] });
  const second = state.doc.line(2);
  const edited = state.update({ changes: { from: second.from, to: second.to, insert: "SECOND" } }).state;
  const draft = edited.doc.sliceString(0, edited.doc.length, edited.lineBreak);
  assert.equal(draft, "first\r\nSECOND\r\nthird\r\nfourth");
  assert.deepEqual(getFileEditorLineChanges(null, saved, draft), [{ line: 2, kind: "modified" }]);
});

test("line markers ignore line-ending normalization in an existing draft", () => {
  assert.deepEqual(getFileEditorLineChanges(null, "first\r\nsecond\r\nthird", "first\nSECOND\nthird"), [
    { line: 2, kind: "modified" },
  ]);
});

test("an existing LF draft is restored to the original CRLF format before saving", () => {
  const saved = "first\r\nsecond\r\nthird";
  const draft = "first\nSECOND\nthird";
  assert.equal(preserveFileLineEndings(draft, saved), "first\r\nSECOND\r\nthird");
  assert.equal(preserveFileLineEndings("first\nsecond\nthird", saved), saved);
});
