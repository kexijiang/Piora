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
const { MessageView, getAutomationToolCardDetails, getUserMessagePreview } = await jiti.import("./MessageView.tsx");
// Import through the same tsconfig alias used by the component so Jiti reuses
// the exact context module instead of creating a second provider instance.
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { VirtualRowStateContext } = await jiti.import("./VirtualRowState");
const { createVirtualRowState } = await jiti.import("@/lib/virtual-row-state");
const messageImageSource = readFileSync(new URL("./MessageImage.tsx", import.meta.url), "utf8");
const messageViewSource = readFileSync(new URL("./MessageView.tsx", import.meta.url), "utf8");
const globalStyles = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

function renderMessage(message, props = {}) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, { message, ...props }),
    ),
  );
}

test("shell output stays collapsed by default, including live chunks", () => {
  const message = { role: "assistant", content: [{ type: "toolCall", toolCallId: "shell", toolName: "bash", input: { command: "echo hello" } }] };
  for (const isStreaming of [true, false]) {
    const html = renderMessage(message, { toolResults: new Map([["shell", {
      role: "toolResult", toolCallId: "shell", isStreaming,
      content: [{ type: "text", text: "hello from shell" }],
    }]]) });
    assert.doesNotMatch(html, /hello from shell/);
    assert.match(html, /aria-expanded="false"/);
  }
  const local = renderMessage({ role: "bashExecution", command: "echo hello", output: "local live output", excludeFromContext: true });
  assert.doesNotMatch(local, /local live output/);
});

test("collapses long user queries to an eight-line preview", () => {
  const content = Array.from({ length: 20 }, (_, index) => `log line ${index + 1}`).join("\n");
  const preview = getUserMessagePreview(content);
  const html = renderMessage({ role: "user", content, timestamp: Date.now() });

  assert.equal(preview.collapsible, true);
  assert.equal(preview.lineCount, 20);
  assert.match(preview.preview, /log line 8$/);
  assert.doesNotMatch(preview.preview, /log line 9/);
  assert.match(html, /class="message-user-expand"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /展开完整消息 · 20 行/);
  assert.doesNotMatch(html, /log line 9/);
});

test("fresh message mounts restore the virtual row's expanded and collapsed choices", () => {
  const rowState = createVirtualRowState();
  const message = { role: "user", content: Array.from({ length: 20 }, (_, index) => `saved line ${index + 1}`).join("\n") };
  const mount = () => renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(VirtualRowStateContext.Provider, { value: rowState }, React.createElement(MessageView, { message }))));
  assert.match(mount(), /aria-expanded="false"/);
  rowState.set("user-content", true);
  assert.match(mount(), /aria-expanded="true"/);
  rowState.set("user-content", false);
  assert.match(mount(), /aria-expanded="false"/);
});

test("renders short user queries without an expand control", () => {
  const html = renderMessage({ role: "user", content: "one\ntwo\nthree", timestamp: Date.now() });
  assert.doesNotMatch(html, /message-user-expand/);
});

test("renders user images as keyboard-accessible zoom controls", () => {
  const html = renderMessage({
    role: "user",
    content: [
      { type: "text", text: "inspect this" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ],
    timestamp: Date.now(),
  });

  assert.match(html, /class="message-image-thumbnail"/);
  assert.match(html, /aria-label="打开第 1 张图片"/);
  assert.match(messageImageSource, /dialog\.showModal\(\)/);
  assert.match(messageImageSource, /createPortal\(viewer, document\.body\)/);
  assert.match(messageImageSource, /event\.key !== "Escape"/);
});

test("renders deferred prompt material as a collapsed preview with its full line count", () => {
  const html = renderMessage({
    role: "user",
    content: "preview only",
    deferredContent: true,
    deferredLineCount: 12_345,
    deferredByteLength: 500_000,
  }, { sessionId: "session-1", entryId: "entry-1" });
  assert.match(html, /message-user-expand/);
  assert.match(html, /展开完整消息 · 12,345 行/);
});

test("renders a provider error when the assistant message has no content", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [],
    stopReason: "error",
    errorMessage: "OpenAI API error (403): <html>request forbidden</html>",
  });

  assert.match(html, /role="alert"/);
  assert.match(html, /Error: OpenAI API error \(403\)/);
  assert.match(html, /&lt;html&gt;request forbidden&lt;\/html&gt;/);
});

test("renders the final response duration in the assistant footer", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    timestamp: 12_500,
    content: [{ type: "text", text: "Done" }],
  }, { showTimestamp: true, responseStartedAt: 10_000 });

  assert.match(html, /响应耗时 2\.5s/);
  assert.match(html, /message-response-meta/);
});

test("renders partial assistant content before the provider error", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Partial response" }],
    stopReason: "error",
    errorMessage: "Connection closed",
  });

  assert.match(html, /Partial response/);
  assert.match(html, /Error: Connection closed/);
});

test("renders thinking as a rounded disclosure whose content uses Markdown", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "thinking", thinking: "## Plan\n\n- inspect\n- fix" }],
  });
  const thinkingBlockSource = messageViewSource.slice(
    messageViewSource.indexOf("function ThinkingBlock"),
    messageViewSource.indexOf("function ToolCallBlock"),
  );

  assert.match(html, /class="thinking-block"/);
  assert.match(html, /class="thinking-block-trigger"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(thinkingBlockSource, /<MarkdownBody className="markdown-thinking"[^>]*>\{display\.content\}<\/MarkdownBody>/);
  assert.doesNotMatch(thinkingBlockSource, /whiteSpace:\s*"pre-wrap"/);
  assert.match(globalStyles, /\.thinking-block\s*\{[^}]*border-radius:\s*12px/s);
});

test("renders file edits as a collapsed change card with line stats", () => {
  const toolCallId = "edit-card-1";
  const patch = [
    "--- a/components/Card.tsx",
    "+++ b/components/Card.tsx",
    "@@ -1 +1,2 @@",
    "-export const value = 1;",
    "+export const value = 2;",
    "+export const ready = true;",
  ].join("\n");
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{
      type: "toolCall",
      toolCallId,
      toolName: "edit",
      input: { path: "components/Card.tsx" },
    }],
  }, {
    toolResults: new Map([[toolCallId, {
      role: "toolResult",
      toolCallId,
      content: [{ type: "text", text: "ok" }],
      details: { patch },
    }]]),
  });

  assert.match(html, /class="file-change-card is-complete"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /已编辑/);
  assert.match(html, /components\/Card\.tsx/);
  assert.match(html, /\+2/);
  assert.match(html, /−1/);
  assert.doesNotMatch(html, /export const ready/);
});

test("derives a persistent scheduled-task card from a successful create tool result", () => {
  const details = getAutomationToolCardDetails({
    toolName: "piora_automation",
    input: { action: "create" },
  }, {
    role: "toolResult",
    toolCallId: "automation-create-1",
    content: [{ type: "text", text: "created" }],
    details: {
      automation: {
        id: "automation-1",
        name: "Monitor release",
        rrule: "RRULE:FREQ=MINUTELY;INTERVAL=5",
      },
    },
  });

  assert.deepEqual(details, {
    id: "automation-1",
    name: "Monitor release",
    rrule: "RRULE:FREQ=MINUTELY;INTERVAL=5",
  });
  assert.equal(getAutomationToolCardDetails({ toolName: "piora_automation", input: { action: "list" } }, undefined), null);
});
