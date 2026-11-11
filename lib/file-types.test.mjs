import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./file-types.ts");
}

test("detects image, audio, and document preview paths", async () => {
  const {
    getAudioMime,
    getDocumentMime,
    getImageMime,
    isAudioPath,
    isDocumentPreviewPath,
    isImagePath,
  } = await loadSubject();

  assert.equal(getImageMime("/tmp/screenshot.PNG"), "image/png");
  assert.equal(getAudioMime("C:\\Users\\me\\voice.OPUS"), "audio/ogg");
  assert.equal(getDocumentMime("/tmp/report.docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(isImagePath("/tmp/screenshot.PNG"), true);
  assert.equal(isAudioPath("C:\\Users\\me\\voice.OPUS"), true);
  assert.equal(isDocumentPreviewPath("/tmp/report.pdf"), true);
  assert.equal(isDocumentPreviewPath("/tmp/report.txt"), false);
});

test("extracts extensions from mixed path styles", async () => {
  const { documentPreviewKind, getFileExt } = await loadSubject();

  assert.equal(getFileExt("/tmp/archive.tar.gz"), "gz");
  assert.equal(getFileExt("C:\\Users\\me\\photo.AVIF"), "avif");
  assert.equal(documentPreviewKind("/tmp/manual.PDF"), "pdf");
  assert.equal(documentPreviewKind("/tmp/manual.md"), null);
});

test("routes supported text files to the text viewer and binary previews to read-only viewers", async () => {
  const { getFileViewerKind } = await loadSubject();

  assert.equal(getFileViewerKind("/tmp/README.md"), "text");
  assert.equal(getFileViewerKind("C:\\repo\\src\\app.tsx"), "text");
  assert.equal(getFileViewerKind("/tmp/logo.svg"), "image");
  assert.equal(getFileViewerKind("/tmp/voice.mp3"), "audio");
  assert.equal(getFileViewerKind("/tmp/report.pdf"), "document");
});

test("recognizes Markdown preview paths without changing other text file defaults", async () => {
  const { isMarkdownPath } = await loadSubject();
  assert.equal(isMarkdownPath("/tmp/README.md"), true);
  assert.equal(isMarkdownPath("C:\\repo\\README.MD"), true);
  assert.equal(isMarkdownPath("/tmp/guide.MDX"), true);
  assert.equal(isMarkdownPath("/tmp/notes.md/outline.txt"), false);
  assert.equal(isMarkdownPath("/tmp/notes.md.txt"), false);
  assert.equal(isMarkdownPath("/tmp/app.tsx"), false);
});
