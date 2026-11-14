import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { parseFileReference, resolveFileReferenceTarget, remarkFileReferences, FILE_REFERENCE_HREF } = await createJiti(import.meta.url).import("./file-references.ts");

test("source locations preserve Windows drives and relative/absolute line and column metadata", () => {
  assert.deepEqual(parseFileReference("features/voice/PushTalkComponent.ets:236:9"), { path: "features/voice/PushTalkComponent.ets", line: 236, column: 9 });
  assert.deepEqual(resolveFileReferenceTarget("C:\\My Project\\a.ts:12:4", "F:/workspace"), { filePath: "C:/My Project/a.ts", line: 12, column: 4 });
  assert.deepEqual(resolveFileReferenceTarget("D:\\报告 Files\\reply.browser.test.mjs", "F:/workspace"), { filePath: "D:/报告 Files/reply.browser.test.mjs" });
  assert.deepEqual(resolveFileReferenceTarget("src/语音.ets:236", "F:/workspace"), { filePath: "F:/workspace/src/语音.ets", line: 236 });
  assert.deepEqual(resolveFileReferenceTarget("/workspace/src/a.ts#L10C3", "/workspace"), { filePath: "/workspace/src/a.ts", line: 10, column: 3 });
  assert.deepEqual(resolveFileReferenceTarget("file:///C:/project/a.ts:12", "F:/workspace"), { filePath: "C:/project/a.ts", line: 12 });
  assert.deepEqual(resolveFileReferenceTarget("//server/share/a.ts:12:4", "F:/workspace"), { filePath: "//server/share/a.ts", line: 12, column: 4 });
  assert.equal(resolveFileReferenceTarget("../outside.ts:2", "/workspace"), null);
  assert.equal(resolveFileReferenceTarget("src/a.ts:2"), null, "a relative reference needs a known workspace");
  for (const invalid of ["https://example.com/a.ts:3", "javascript:run.ts", "src/a.ts:0", "src/a.ts:999999999999999999", "a.ts\n", "/api/files/a.ts"]) {
    assert.equal(parseFileReference(invalid), null, invalid);
  }
});

test("plain Windows source references keep spaces in the absolute path", () => {
  const tree = { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: "见 C:\\My Project\\src\\a.ts:12:4，再继续。" }] }] };
  remarkFileReferences()(tree);
  const links = tree.children[0].children.filter(node => node.type === "link");
  assert.equal(links.length, 1);
  assert.equal(decodeURIComponent(links[0].url.slice(FILE_REFERENCE_HREF.length)), "C:\\My Project\\src\\a.ts:12:4");
});

test("plain generated file paths preserve Windows spaces and every filename extension", () => {
  for (const [value, expected] of [
    ["文件在 C:\\My Project\\reports\\result.md，请打开。", ["C:\\My Project\\reports\\result.md"]],
    ["见 src/example.browser.test.mjs。", ["src/example.browser.test.mjs"]],
    ["见 C:/My Project/src/example.browser.test.mjs. 再继续。", ["C:/My Project/src/example.browser.test.mjs"]],
    ["见 src/example.test.ts:12:4，再继续。", ["src/example.test.ts:12:4"]],
  ]) {
    const tree = { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value }] }] };
    remarkFileReferences()(tree);
    const references = tree.children[0].children.filter(node => node.type === "link");
    assert.deepEqual(references.map(node => decodeURIComponent(node.url.slice(FILE_REFERENCE_HREF.length))), expected, value);
  }
});

test("references in prose, inline code and file-list fences become links without rewriting code or URLs", () => {
  const inline = { type: "inlineCode", value: "src/a.ts:8:2" };
  const source = { type: "code", lang: "ts", value: 'const x = "src/a.ts:8";' };
  const tree = { type: "root", children: [{ type: "paragraph", children: [
    { type: "text", value: "逻辑在 features/voice/PushTalkComponent.ets:236，另见 common/corebase/VoiceReportConstNew.ets:216。 https://example.com/a.ts:3 v1.2.3" }, inline,
    { type: "link", url: "C:/My%20Project/a.ts:12:4", children: [{ type: "text", value: "source" }] },
    { type: "link", url: "https://example.com/a.ts", children: [{ type: "text", value: "src/not-a-link.ts" }] },
  ] }, { type: "code", value: "src/a.ts:2\nsrc/b.ets:4" }, source] };
  remarkFileReferences()(tree);
  const links = tree.children[0].children.filter(node => node.type === "link");
  assert.equal(links.length, 5);
  assert.equal(links.filter(node => node.url.startsWith(FILE_REFERENCE_HREF)).length, 4);
  assert.equal(links[2].children[0], inline, "inline-code styling is preserved");
  assert.equal(decodeURIComponent(links[3].url.slice(FILE_REFERENCE_HREF.length)), "C:/My Project/a.ts:12:4");
  assert.equal(links[4].children[0].value, "src/not-a-link.ts", "existing web links are never nested");
  assert.equal(tree.children[1].children.filter(node => node.type === "link").length, 2);
  assert.equal(tree.children[2], source, "source code examples are untouched");
});
