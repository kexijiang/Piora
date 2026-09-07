import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const {
  MarkdownBody,
  preloadMarkdownMathRenderer,
  preloadMarkdownRawHtmlParser,
} = await jiti.import("./MarkdownBody.tsx");
const { normalizeDisplayMath } = await jiti.import("../lib/markdown.ts");
const globalCss = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const markdownBodySource = readFileSync(new URL("./MarkdownBody.tsx", import.meta.url), "utf8");

function renderMarkdown(markdown) {
  return renderToStaticMarkup(
    React.createElement(MarkdownBody, {
      cwd: "/home/me/project",
      onOpenFile() {},
    }, markdown),
  );
}

function renderAssistant(markdown) {
  return renderToStaticMarkup(React.createElement(MarkdownBody, {
    className: "markdown-assistant-message",
  }, markdown));
}

test("distinguishes emphasis across paragraphs and reuses repeated labels", () => {
  const html = renderAssistant("**第一项**\n\n- **第二项**\n- **第三项**\n- **第一项**\n- **第四项**");
  assert.deepEqual([...html.matchAll(/data-emphasis-color="(\d)"/g)].map((match) => match[1]), ["0", "1", "2", "0", "0"]);
  assert.doesNotMatch(renderMarkdown("**第一项** **第二项**"), /data-emphasis-color/);
});

test("keeps completed emphasis colors stable while the response streams", () => {
  const prefix = "**第一项** 和 **第二项**";
  const colors = (html) => [...html.matchAll(/data-emphasis-color="(\d)"/g)].map((match) => match[1]);
  assert.deepEqual(colors(renderAssistant(prefix + "\n\n**第三项** 后续正文")).slice(0, 2), colors(renderAssistant(prefix)));
  assert.match(renderAssistant("**新回复**"), /data-emphasis-color="0"/);
});

test("handles sanitized HTML bold without recoloring headings, highlights or code", async () => {
  await preloadMarkdownRawHtmlParser();
  const html = renderAssistant("# **标题**\n\n`**代码**`\n\n<mark><strong>提示</strong></mark>\n\n<b>第一项</b> **第二项** **第三项** <strong>第一项</strong>");
  assert.deepEqual([...html.matchAll(/data-emphasis-color="(\d)"/g)].map((match) => match[1]), ["0", "1", "2", "0"]);
  assert.match(html, /<h1><strong>标题<\/strong><\/h1>/);
  assert.match(html, /<mark><strong>提示<\/strong><\/mark>/);
});

test("opens non-file markdown links in a safe new tab", () => {
  const html = renderMarkdown("[docs](https://example.com/docs)");

  assert.match(
    html,
    /<a (?=[^>]*href="https:\/\/example\.com\/docs")(?=[^>]*target="_blank")(?=[^>]*rel="noopener noreferrer")[^>]*>docs<\/a>/,
  );
  assert.doesNotMatch(html, /\snode=/);
});

test("keeps local file markdown links in the app", () => {
  const html = renderMarkdown("[file](components/MarkdownBody.tsx)");

  assert.match(html, /<a href="components\/MarkdownBody\.tsx">file<\/a>/);
  assert.doesNotMatch(html, /target=|rel=|\snode=/);
});

test("keeps wide tables on one line inside a horizontal scroller", () => {
  const html = renderMarkdown("| 第一列 | 第二列 |\n| --- | --- |\n| 很长的内容 | 同样很长的内容 |");

  assert.match(html, /class="markdown-table-wrap"/);
  assert.match(globalCss, /\.markdown-table-wrap\s*\{[^}]*overflow-x:\s*auto;[^}]*scrollbar-gutter:\s*stable;/s);
  assert.match(globalCss, /\.markdown-body table\s*\{[^}]*width:\s*max-content;[^}]*min-width:\s*100%;/s);
  assert.match(globalCss, /\.markdown-body th, \.markdown-body td\s*\{[^}]*white-space:\s*nowrap;/s);
});

test("opens Mermaid markdown in preview mode without flashing its source", () => {
  assert.match(markdownBodySource, /<LazyMermaidBlock code=\{code\} isStreaming=\{isStreaming\} defaultPreview \/>/);
  assert.match(markdownBodySource, /fallback=\{<MermaidPreviewFallback \/>\}/);
  assert.match(markdownBodySource, /className="mermaid-block mermaid-block-loading"/);
});

test("renders safe raw HTML and sanitizes unsafe elements after the parser loads", async () => {
  await preloadMarkdownRawHtmlParser();
  const html = renderMarkdown("<strong>safe</strong><script>alert('unsafe')</script>");

  assert.match(html, /<strong>safe<\/strong>/);
  assert.doesNotMatch(html, /<script|alert\(/);
});

test("renders LaTeX parenthesis delimiters as inline math", async () => {
  await preloadMarkdownMathRenderer();
  const html = renderMarkdown(String.raw`射线为 \(r_c = K^{-1}p\)。`);

  assert.match(html, /class="katex"/);
  assert.match(html, /r_c/);
});

test("renders paired LaTeX bracket delimiters as display math", async () => {
  await preloadMarkdownMathRenderer();
  const html = renderMarkdown(String.raw`\[
P(\lambda)=o_b+\lambda r_b
\]`);
  const oneLineHtml = renderMarkdown(String.raw`\[P(\lambda)=o_b+\lambda r_b\]`);

  assert.match(html, /class="katex-display"/);
  assert.match(html, /lambda/);
  assert.match(oneLineHtml, /class="katex-display"/);
});

test("leaves an unmatched LaTeX bracket delimiter unchanged", () => {
  const markdown = String.raw`before
\[
x + y
after`;

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize LaTeX delimiters inside Markdown code", () => {
  const markdown = "    \\(indented\\)\n\n`code\n\\(inline\\)`\n\n```text\n\\[\nfenced\n\\]\n```";

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize LaTeX delimiters inside raw HTML code", () => {
  const markdown = "<code>\\(inline\\)</code>\n\n<pre>\n\\(block\\)\n</pre>";

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize escaped delimiters or link destinations", () => {
  const escaped = String.raw`Literal: \\(x+y\\).`;
  const link = String.raw`[docs](https://example.com/\(manual\))`;

  assert.equal(normalizeDisplayMath(escaped), escaped);
  assert.equal(normalizeDisplayMath(link), link);
});
