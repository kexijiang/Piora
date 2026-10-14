import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { detectUserMessageLinks } = await jiti.import("./user-message-links.ts");
const { createLocalFileLinkClickHandler } = await jiti.import("./file-link-click.ts");
const { UserMessageText } = await jiti.import("../components/UserMessageText.tsx");

const links = (text) => detectUserMessageLinks(text).filter((s) => s.type !== "text").map((s) => s.text);

test("detects file paths of every supported form", () => {
  assert.deepEqual(links("看 /Users/kexi/app/main.ts:12:3 和 ~/notes/todo.md"), ["/Users/kexi/app/main.ts:12:3", "~/notes/todo.md"]);
  assert.deepEqual(links("改 ./src/app.tsx 或 ../lib/x.ts:4"), ["./src/app.tsx", "../lib/x.ts:4"]);
  assert.deepEqual(links(String.raw`打开 C:\Users\kexi\a.txt 和 D:/repo/b.ts`), [String.raw`C:\Users\kexi\a.txt`, "D:/repo/b.ts"]);
  assert.deepEqual(links("修 src/components/Foo.tsx:10，然后 @lib/file_name.ts:1-3"), ["src/components/Foo.tsx:10", "lib/file_name.ts:1"]);
  assert.deepEqual(links("我的文件src/a.ts的问题"), ["src/a.ts"]);
  assert.deepEqual(links("/etc/hosts /foo.ts"), ["/etc/hosts", "/foo.ts"]);
});

test("detects URLs and trims trailing punctuation", () => {
  assert.deepEqual(links("见 https://example.com/a?b=1。还有 (http://x.dev/p_(1))."), ["https://example.com/a?b=1", "http://x.dev/p_(1)"]);
  assert.deepEqual(links("路径 src/a.ts."), ["src/a.ts"]);
});

test("avoids false positives", () => {
  for (const text of [
    "and/or TCP/IP a/b km/h", "version 1.2.3 and v0.5.5-beta.20", "1.0/2.0 50/50",
    "/compact 一下", "README.md package.json", "foo.bar", "e.g. this",
    "http:// nothing", "C: drive", "a//b.ts",
  ]) {
    assert.deepEqual(links(text), [], text);
  }
});

test("segments reproduce the original text exactly", () => {
  const text = "  a  /tmp/x.log:3\n\n<b>&</b> https://a.com ";
  assert.equal(detectUserMessageLinks(text).map((s) => s.text).join(""), text);
});

test("renders links with escaped literal text and no raw HTML", () => {
  const text = "<b>x</b> *y* open /repo/src/a.ts:2 and https://example.com/?a=1&b=2 ~/x.md";
  const html = renderToStaticMarkup(React.createElement(UserMessageText, { text, cwd: "/repo", onOpenFile: () => {} }));
  assert.match(html, /^<div class="user-message-text">&lt;b&gt;x&lt;\/b&gt; \*y\* open /);
  assert.match(html, /<a class="user-message-link" href="\/repo\/src\/a\.ts:2">\/repo\/src\/a\.ts:2<\/a>/);
  assert.match(html, /<a class="user-message-link" href="https:\/\/example\.com\/\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">/);
  assert.match(html, / ~\/x\.md<\/div>$/);
  assert.doesNotMatch(html, /<b>|<em>/);
});

test("paths stay plain text without an open handler or outside the workspace", () => {
  const noHandler = renderToStaticMarkup(React.createElement(UserMessageText, { text: "src/a.ts https://a.com" }));
  assert.equal(noHandler, '<div class="user-message-text">src/a.ts <a class="user-message-link" href="https://a.com" target="_blank" rel="noopener noreferrer">https://a.com</a></div>');
  const outside = renderToStaticMarkup(React.createElement(UserMessageText, { text: "../../etc/passwd.txt", cwd: "/repo", onOpenFile: () => {} }));
  assert.doesNotMatch(outside, /<a/);
});

test("clicking a path opens it via the shared handler", () => {
  const opened = [];
  const handler = createLocalFileLinkClickHandler("/repo/src/a.ts", (p) => opened.push(p));
  let prevented = false;
  handler({ defaultPrevented: false, button: 0, preventDefault: () => { prevented = true; }, currentTarget: { getAttribute: () => null } });
  assert.deepEqual(opened, ["/repo/src/a.ts"]);
  assert.equal(prevented, true);
  handler({ defaultPrevented: false, button: 0, metaKey: true, preventDefault() {}, currentTarget: { getAttribute: () => null } });
  handler({ defaultPrevented: false, button: 1, preventDefault() {}, currentTarget: { getAttribute: () => null } });
  assert.equal(opened.length, 1);
});

test("MarkdownBody and UserMessageText share the same open behavior", () => {
  for (const file of ["../components/MarkdownBody.tsx", "../components/UserMessageText.tsx"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /createLocalFileLinkClickHandler\(filePath, /);
    assert.match(source, /resolveLocalFileHref\(/);
    assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
  }
});
