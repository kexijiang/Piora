import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MermaidBlock } = await jiti.import("./MermaidBlock.tsx");
// Import through the same tsconfig alias used by the component so Jiti reuses
// the exact context module instead of creating a second provider instance.
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

// Simple sequenceDiagram for testing
const mermaidSrc = `sequenceDiagram
    Alice->>Bob: Hello
    Bob-->>Alice: Hi`;

function renderMermaid(props) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MermaidBlock, props),
    ),
  );
}

test("MermaidBlock renders preview by default", () => {
  const html = renderMermaid({ code: mermaidSrc });

  assert.match(html, />源代码</);
  assert.match(html, />复制图片</);
  assert.match(html, />导出 PNG</);
  assert.match(html, /disabled/);
  assert.match(html, /mermaid-block-loading/);
  assert.doesNotMatch(html, /Alice/);
});

test("Mermaid preview exposes PNG export and image clipboard actions", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("./MermaidBlock.tsx", import.meta.url), "utf8"));
  assert.match(source, /navigator\.clipboard\.write/);
  assert.match(source, /new ClipboardItem\(\{ "image\/png": png \}\)/);
  assert.match(source, /link\.download = "mermaid-diagram\.png"/);
  assert.match(source, /renderMermaidPng/);
  assert.match(source, /htmlLabels: false/);
  assert.match(source, /<MermaidImageActions svg=\{svg\} variant="toolbar" \/>/);
});

test("MermaidBlock can explicitly start in source view", () => {
  const html = renderMermaid({ code: mermaidSrc, defaultPreview: false });

  assert.match(html, />预览</);
  assert.match(html, /Alice/);
  assert.doesNotMatch(html, /mermaid-block-loading/);
});

test("MermaidBlock with isStreaming falls back to source view", () => {
  const html = renderMermaid({ code: mermaidSrc, isStreaming: true, defaultPreview: true });

  assert.match(html, /disabled/);
  assert.match(html, />预览</);
  assert.match(html, /Alice/);
  assert.match(html, /-&gt;&gt;/);
});

test("MermaidBlock renders empty graph without error", () => {
  const html = renderMermaid({ code: "graph TD", defaultPreview: true });

  assert.doesNotMatch(html, /mermaid-block-error/);
  assert.match(html, /mermaid-block-loading/);
});

test("MermaidBlock handles Chinese characters in diagram", () => {
  const chineseMermaid = `sequenceDiagram
    participant PC as PC客户端
    PC->>SV: 请求登录`;

  const html = renderMermaid({ code: chineseMermaid, defaultPreview: true });

  assert.doesNotMatch(html, /mermaid-block-error/);
  assert.match(html, /mermaid-block/);
});
