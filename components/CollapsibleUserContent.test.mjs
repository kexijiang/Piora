import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
  alias: { "./RoomWorkspace.module.css": fileURLToPath(new URL("../lib/css-module-test-stub.mjs", import.meta.url)) },
});
const { previewUserContent, shouldCollapseUserContent } = await jiti.import("../lib/collapsible-content.ts");
const { CollapsibleUserContent } = await jiti.import("./CollapsibleUserContent.tsx");

test("1,000-line Room content renders a six-line preview with accessible full-content actions", () => {
  const full = Array.from({ length: 1_000 }, (_, index) => `日志 ${index + 1} 🙂`).join("\n");
  const preview = previewUserContent(full);
  assert.equal(preview.split("\n").length, 6);
  assert.equal(preview, full.split("\n").slice(0, 6).join("\n"));
  const hash = createHash("sha256").update(full).digest("hex");
  assert.equal(hash.length, 64);
  const source = readFileSync(new URL("./CollapsibleUserContent.tsx", import.meta.url), "utf8");
  const roomSource = readFileSync(new URL("./RoomWorkspace.tsx", import.meta.url), "utf8");
  assert.match(source, /展开全文/);
  assert.match(source, /复制全文/);
  assert.match(source, /aria-expanded/);
  assert.match(source, /<UserMessageText text=\{visibleContent\} \/>/);
  assert.doesNotMatch(source, /MarkdownBody|dangerouslySetInnerHTML/);
  assert.match(roomSource, /isUser\s*\?\s*<CollapsibleUserContent/);
  assert.match(roomSource, /<MarkdownBody cwd=\{room\.projectRoot\} className="markdown-assistant-message">\{message\.content\}<\/MarkdownBody>/);
});

test("room user messages stay literal while collapse, copy, and retry stay available", () => {
  const content = ["*bold* <tag> @member_name", "line 2", "line 3", "line 4", "line 5", "line 6", "line 7", "line 8", "line 9 secret"].join("\n");
  const message = {
    id: "m1",
    roomId: "room",
    seq: 1,
    author: { kind: "user", id: "u", name: "你" },
    content,
    payload: { byteLength: Buffer.byteLength(content), lineCount: 9, sha256: "abc", truncated: false },
    createdAt: 1,
  };
  const html = renderToStaticMarkup(React.createElement(CollapsibleUserContent, { message, sessionId: "session-1", onRetry: async () => {} }));
  assert.match(html, /class="user-message-text"/);
  assert.match(html, /\*bold\* &lt;tag&gt; @member_name/);
  assert.match(html, /line 6/);
  assert.doesNotMatch(html, /line 7|<(?:strong|em|code|h1|script|a)\b|dangerouslySetInnerHTML|markdown-body/);
  assert.match(html, /展开全文/);
  assert.match(html, /复制全文/);
  assert.match(html, /重试/);
});

test("collapse thresholds use UTF-8 metadata without truncating the source", () => {
  const exact = "你".repeat(400);
  assert.equal(shouldCollapseUserContent({ truncated: false, lineCount: 1, byteLength: Buffer.byteLength(exact) }), false);
  assert.equal(shouldCollapseUserContent({ truncated: false, lineCount: 9, byteLength: 9 }), true);
});
